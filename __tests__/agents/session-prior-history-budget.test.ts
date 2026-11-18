import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, PRIOR_HISTORY_TOKEN_BUDGET } from "../../src/agents/session";
import type { LoadedAgent } from "../../src/agents/loader";
import { JsonlStore } from "../../src/memory/jsonl-store";
import { SessionStore } from "../../src/memory/session-store";
import { ThreadStore } from "../../src/memory/thread-store";
import type { Provider, ProviderMessage, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// a turn sends only the newest prior messages that fit the history budget.
let tempDir: string;
let roomDir: string;
let store: JsonlStore;
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-prior-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roomDir = join(tempDir, "rooms", "jade");
  mkdirSync(join(roomDir, "staging"), { recursive: true });
  store = new JsonlStore(tempDir);
  originalHome = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function agent(): LoadedAgent {
  return {
    name: "jade",
    label: "Jade",
    roomDir,
    soulPath: "SOUL.md",
    geneContent: "Core instructions.",
    soulContent: "You are Jade.",
    sessionContextFiles: [],
    additionalContent: [],
    config: {
      identity: { name: "jade", label: "Jade" },
      provider: { type: "claude" },
      policy: { allowedRoots: [roomDir], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 0 },
      boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
    },
  };
}

function recordingProvider(requests: ProviderRequest[]): Provider {
  return {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(structuredClone(req));
      return { message: { role: "assistant", content: "ok" } };
    },
  };
}

/** `count` alternating user/assistant messages, each `tokensEach` estimated tokens (4 characters per token), tagged by index. */
function history(count: number, firstRole: "user" | "assistant" = "user", tokensEach = 1000): ProviderMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const role = (i % 2 === 0) === (firstRole === "user") ? "user" : "assistant";
    const tag = `m${i}:`;
    return { role, content: tag + "x".repeat(4 * tokensEach - tag.length) } as ProviderMessage;
  });
}

const tags = (messages: ProviderMessage[]) => messages.map((m) => String(m.content).split(":")[0]);

async function sentMessages(options: Record<string, unknown>, logs?: Array<{ msg: string; fields?: Record<string, unknown> }>) {
  const requests: ProviderRequest[] = [];
  const log = (_level: "info" | "error", msg: string, fields?: Record<string, unknown>) => { logs?.push({ msg, fields }); };
  const session = new AgentSession({ store, provider: recordingProvider(requests), log });
  await session.run({ agent: agent(), message: "now", mode: "plan", ...options });
  expect(requests).toHaveLength(1);
  return requests[0]!.messages;
}

test("PH-1 over budget: only the newest prior messages within 30,000 estimated tokens are sent, in order, then the new message", async () => {
  expect(PRIOR_HISTORY_TOKEN_BUDGET).toBe(30_000);
  const messages = await sentMessages({ priorMessages: history(40) });
  expect(tags(messages.slice(0, -1))).toEqual(Array.from({ length: 30 }, (_, i) => `m${i + 10}`));
  expect(messages.at(-1)).toEqual({ role: "user", content: "now" });
});

test("PH-2 within budget: every prior message is sent unchanged, even one that starts with an assistant message", async () => {
  const prior = history(12);
  const messages = await sentMessages({ priorMessages: prior });
  expect(messages.slice(0, -1)).toEqual(prior);

  const assistantFirst = history(11, "assistant");
  const unchanged = await sentMessages({ priorMessages: assistantFirst });
  expect(unchanged.slice(0, -1)).toEqual(assistantFirst);
});

test("PH-3 a leading assistant message left by the cut is dropped", async () => {
  // 33 messages: the newest 30 are m3..m32, and m3 is an assistant message.
  const messages = await sentMessages({ priorMessages: history(33) });
  expect(tags(messages.slice(0, -1))).toEqual(Array.from({ length: 29 }, (_, i) => `m${i + 4}`));
  expect(messages[0]!.role).toBe("user");
});

test("PH-3 several assistant messages exposed by the cut are all dropped, and the first user message is kept", async () => {
  // No prior user message at all: no newest exchange is forced, and the cut leaves only assistant messages.
  const allAssistant: ProviderMessage[] = Array.from({ length: 40 }, (_, i) => ({ role: "assistant", content: `m${i}:` + "x".repeat(4000 - `m${i}:`.length) }) as ProviderMessage);
  expect(await sentMessages({ priorMessages: allAssistant })).toEqual([{ role: "user", content: "now" }]);

  // Two assistants in a row exposed by the cut (m10, m11), then a user message m12 that must be kept.
  const prior = history(40).map((m, i) => (i === 10 ? { ...m, role: "assistant" } : m)) as ProviderMessage[];
  const messages = await sentMessages({ priorMessages: prior });
  expect(tags(messages.slice(0, -1))).toEqual(Array.from({ length: 28 }, (_, i) => `m${i + 12}`));
});

test("PH-4 the newest exchange is sent whole even past the budget; older messages are dropped", async () => {
  const huge: ProviderMessage[] = [
    { role: "user", content: "older" },
    { role: "assistant", content: "older reply" },
    { role: "user", content: "small question" },
    { role: "assistant", content: "y".repeat(4 * PRIOR_HISTORY_TOKEN_BUDGET + 4) },
  ];
  expect(await sentMessages({ priorMessages: huge })).toEqual([...huge.slice(2), { role: "user", content: "now" }]);

  // Regression case: [user 1k, assistant 1k, user 1k, assistant 29.5k] used to send no history.
  const nearBudget: ProviderMessage[] = [
    { role: "user", content: "a".repeat(4000) },
    { role: "assistant", content: "b".repeat(4000) },
    { role: "user", content: "c".repeat(4000) },
    { role: "assistant", content: "d".repeat(118_000) },
  ];
  expect(await sentMessages({ priorMessages: nearBudget })).toEqual([...nearBudget.slice(2), { role: "user", content: "now" }]);
});

test("PH-5 the trim also applies to history from the thread store and the session store", async () => {
  // The in-memory thread store keeps its newest 20 messages, so these are 2,000 tokens each: m0..m19 hold
  // 40,000 and the newest 15 (m5..m19) fill the budget; m5 is an assistant message, so m6..m19 remain.
  const threads = new ThreadStore();
  for (const m of history(20, "user", 2000)) threads.add("chan", "jade", m.role as "user" | "assistant", String(m.content));
  const fromThread = await sentMessages({ channelId: "chan", threadStore: threads });
  expect(tags(fromThread.slice(0, -1))).toEqual(Array.from({ length: 14 }, (_, i) => `m${i + 6}`));

  const sessions = new SessionStore(join(tempDir, "sessions.db"));
  const s = sessions.createSession("jade", "ui");
  for (const m of history(40)) sessions.appendTurn(s.id, m.role as "user" | "assistant", String(m.content));
  const fromSessions = await sentMessages({ sessionStore: sessions, sessionId: s.id });
  expect(tags(fromSessions.slice(0, -1))).toEqual(Array.from({ length: 30 }, (_, i) => `m${i + 10}`));
});

test("PH-6 every turn stored before a trimmed turn keeps its id, role, content and order", async () => {
  const sessions = new SessionStore(join(tempDir, "sessions.db"));
  const s = sessions.createSession("jade", "ui");
  for (const m of history(40)) sessions.appendTurn(s.id, m.role as "user" | "assistant", String(m.content));
  const record = (t: { id: number; role: string; content: string }) => ({ id: t.id, role: t.role, content: t.content });
  const before = sessions.getTurns(s.id).map(record);
  await sentMessages({ sessionStore: sessions, sessionId: s.id });
  expect(sessions.getTurns(s.id).map(record).slice(0, before.length)).toEqual(before);
});

test("PH-7 a trimmed turn logs the kept and dropped counts; an untrimmed turn does not", async () => {
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  await sentMessages({ priorMessages: history(40) }, logs);
  expect(logs.filter((l) => l.msg === "prior history trimmed")).toEqual([
    { msg: "prior history trimmed", fields: { agent: "jade", kept: 30, dropped: 10, keptEstimatedTokens: 30_000 } },
  ]);

  const quiet: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  await sentMessages({ priorMessages: history(12) }, quiet);
  expect(quiet.filter((l) => l.msg === "prior history trimmed")).toEqual([]);
});
