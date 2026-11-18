import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../../src/agents/session";
import { SUMMARY_ACK, SUMMARY_MARKER } from "../../src/session/castle-compaction";
import type { LoadedAgent } from "../../src/agents/loader";
import { JsonlStore } from "../../src/memory/jsonl-store";
import type { Provider, ProviderMessage, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// a stored summary is pinned ahead of the prior messages and survives the budget trim.
let tempDir: string;
let roomDir: string;
let store: JsonlStore;
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-prior-summary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const pair = (summary: string): ProviderMessage[] => [
  { role: "user", content: `${SUMMARY_MARKER}\n${summary}` },
  { role: "assistant", content: SUMMARY_ACK },
];

test("AC-4 the summary is sent as a fixed user/assistant pair before the prior messages", async () => {
  const prior = history(4);
  const messages = await sentMessages({ priorMessages: prior, priorSummary: "the summary" });
  expect(messages).toEqual([...pair("the summary"), ...prior, { role: "user", content: "now" }]);
});

test("AC-11 the summary survives the trim: the budget for prior messages is the given budget minus the summary pair", async () => {
  // Budget 30,000 by default; the pair is about 10,019 estimated tokens, which leaves 19,981: 19 messages of
  // 1,000 (m21..m39) fit, and m21 is an assistant message, so the kept part is m22..m39.
  const summary = "s".repeat(40_000);
  const messages = await sentMessages({ priorMessages: history(40), priorSummary: summary });
  expect(messages.slice(0, 2)).toEqual(pair(summary));
  const kept = messages.slice(2, -1);
  expect(kept[0]!.role).toBe("user");
  expect(tags(kept)).toEqual(Array.from({ length: 18 }, (_, i) => `m${i + 22}`));
});

test("AC-11 the castle budget is passed per call; without it the budget stays 30,000", async () => {
  const wide = await sentMessages({ priorMessages: history(60), priorHistoryTokenBudget: 200_000 });
  expect(wide).toHaveLength(61);
  const narrow = await sentMessages({ priorMessages: history(60) });
  expect(narrow.slice(0, -1)).toHaveLength(30);
});

test("AC-11 the newest exchange is still kept whole after the summary pair", async () => {
  const prior: ProviderMessage[] = [
    { role: "user", content: "older" },
    { role: "assistant", content: "older reply" },
    { role: "user", content: "question" },
    { role: "assistant", content: "y".repeat(4 * 30_000) },
  ];
  const messages = await sentMessages({ priorMessages: prior, priorSummary: "short" });
  expect(messages).toEqual([...pair("short"), ...prior.slice(2), { role: "user", content: "now" }]);
});
