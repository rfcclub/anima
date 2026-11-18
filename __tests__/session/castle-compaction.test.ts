import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type TurnRecord } from "../../src/memory/session-store";
import {
  CASTLE_PRIOR_HISTORY_BUDGET,
  COMPACT_IDLE_MS,
  COMPACTING_TURN_BUDGET,
  SUMMARY_MAX_CHARS,
  compactIfNeeded,
  compactSession,
  decideCompaction,
  keptTailStart,
  providerSummarizer,
  startCastleCompaction,
  waitForCastleCompactions,
  type Summarizer,
} from "../../src/session/castle-compaction";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// castle sessions compact on size and on idle, publishing a summary and
// soft-deleting exactly the summarized turns in one transaction.
let dir: string;
let store: SessionStore;
let logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
const NOW = Date.parse("2026-10-21T22:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "castle-compaction-"));
  store = new SessionStore(join(dir, "sessions.db"));
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const log = (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => { logs.push({ level, msg, fields }); };

/** A session with `count` alternating user/assistant turns of `tokensEach` estimated tokens, the last one `ageMs` old. */
function session(count: number, tokensEach = 10, ageMs = 0): string {
  const s = store.createSession("jade", "ui");
  for (let i = 0; i < count; i++) {
    store.appendTurn(s.id, i % 2 === 0 ? "user" : "assistant", `m${i}:` + "x".repeat(4 * tokensEach - `m${i}:`.length));
  }
  setLastTurnTime(s.id, NOW - ageMs);
  return s.id;
}

function setLastTurnTime(sessionId: string, ms: number): void {
  const db = (store as unknown as { db: { run(sql: string, params: unknown[]): void } }).db;
  db.run("UPDATE turns SET ts = ? WHERE session_id = ?", [new Date(ms).toISOString(), sessionId]);
}

const tags = (turns: TurnRecord[]) => turns.map((t) => t.content.split(":")[0]);

function fakeSummarizer(calls: Array<{ previousSummary?: string; turns: string[] }>, text = "SUMMARY"): Summarizer {
  return async ({ previousSummary, turns }) => {
    calls.push({ previousSummary, turns: tags(turns) });
    return `${text}#${calls.length}`;
  };
}

const deps = (summarize: Summarizer, extra: Record<string, unknown> = {}) => ({ store, summarize, log, now: () => NOW, ...extra });

test("the kept tail is the newest 10 messages, extended back to a user message and the whole newest exchange", () => {
  const turns = store.getTurns(session(30));
  expect(keptTailStart(turns)).toBe(20);
  // m20 is a user message already; with 31 turns the newest 10 start at m21 (assistant), so the tail starts at m20.
  const odd = store.getTurns(session(31));
  expect(keptTailStart(odd)).toBe(20);
  // [user, assistant x 11]: the newest exchange is all 12 messages.
  const s = store.createSession("jade", "ui");
  store.appendTurn(s.id, "user", "q");
  for (let i = 0; i < 11; i++) store.appendTurn(s.id, "assistant", `a${i}`);
  expect(keptTailStart(store.getTurns(s.id))).toBe(0);
});

test("AC-1 size: over 200,000 estimated tokens with eligible messages compacts with reason size", async () => {
  // 30 turns of 7,000 tokens = 210,000 > 200,000; last turn is fresh.
  const id = session(30, 7000, 60_000);
  const decision = decideCompaction({ turns: store.getTurns(id), incomingMessage: "now", now: NOW });
  expect(decision.reason).toBe("size");
  expect(tags(decision.eligible)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));

  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  const result = await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result).toMatchObject({ status: "compacted", reason: "size", summarized: 20, kept: 10 });
  expect(tags(store.getTurns(id))).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 20}`));
  expect(store.getSummary(id)?.summary).toBe("SUMMARY#1");
});

test("AC-1 the size estimate counts the stored summary and the incoming message", () => {
  // 30 turns of 6,600 tokens = 198,000; the incoming message adds 2,500.
  const id = session(30, 6600, 60_000);
  const turns = store.getTurns(id);
  expect(decideCompaction({ turns, incomingMessage: "y".repeat(10_000), now: NOW }).reason).toBe("size");
  expect(decideCompaction({ turns, incomingMessage: "now", now: NOW }).reason).toBeUndefined();
  expect(decideCompaction({ turns, summary: "s".repeat(10_000), incomingMessage: "now", now: NOW }).reason).toBe("size");
});

test("AC-2 idle: a last message older than 30 minutes with 10 or more eligible messages compacts with reason idle", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  const result = await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result).toMatchObject({ status: "compacted", reason: "idle", summarized: 10, kept: 10 });
  expect(calls).toHaveLength(1);
});

test("AC-2 idle with fewer than 10 eligible messages makes no summary call", async () => {
  const id = session(19, 10, COMPACT_IDLE_MS + 60_000);
  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  const result = await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result.status).toBe("nothing");
  expect(calls).toHaveLength(0);
  expect(store.getTurns(id)).toHaveLength(19);
});

test("AC-2 when size and idle both fire, the reason is idle", () => {
  const id = session(30, 7000, COMPACT_IDLE_MS + 60_000);
  expect(decideCompaction({ turns: store.getTurns(id), incomingMessage: "now", now: NOW }).reason).toBe("idle");
});

test("AC-3 no trigger: no summary call and nothing changes", async () => {
  const id = session(40, 10, 60_000);
  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  const result = await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result.status).toBe("nothing");
  expect(calls).toHaveLength(0);
  expect(store.getTurns(id)).toHaveLength(40);
  expect(store.getSummary(id)).toBeNull();
});

test("AC-5 a later compaction folds the previous summary in; one summary row remains", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  for (let i = 20; i < 30; i++) store.appendTurn(id, i % 2 === 0 ? "user" : "assistant", `m${i}:` + "x".repeat(36));
  setLastTurnTime(id, NOW - COMPACT_IDLE_MS - 60_000);
  await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(calls[1]).toEqual({ previousSummary: "SUMMARY#1", turns: Array.from({ length: 10 }, (_, i) => `m${i + 10}`) });
  expect(store.getSummary(id)).toMatchObject({ summary: "SUMMARY#2", version: 2 });
  const db = (store as unknown as { db: { query(sql: string): { get(...a: unknown[]): unknown } } }).db;
  expect(db.query("SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = ?").get(id)).toEqual({ c: 1 });
});

test("AC-6 messages appended during the summary call stay visible; only the snapshot is soft-deleted; no row is removed", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const summarize: Summarizer = async () => {
    store.appendTurn(id, "user", "late-user");
    store.appendTurn(id, "assistant", "late-assistant");
    return "SUMMARY";
  };
  await compactIfNeeded(deps(summarize), { sessionId: id, agent: "jade", incomingMessage: "now" });
  const visible = store.getTurns(id).map((t) => t.content.split(":")[0]);
  expect(visible).toEqual([...Array.from({ length: 10 }, (_, i) => `m${i + 10}`), "late-user", "late-assistant"]);
  const db = (store as unknown as { db: { query(sql: string): { get(...a: unknown[]): unknown } } }).db;
  expect(db.query("SELECT COUNT(*) AS c FROM turns WHERE session_id = ?").get(id)).toEqual({ c: 22 });
  expect(db.query("SELECT COUNT(*) AS c FROM turns WHERE session_id = ? AND deleted = 1").get(id)).toEqual({ c: 10 });
});

test("AC-7 a failed, empty or slow summary, or a failed publish, changes nothing and logs the reason", async () => {
  const cases: Array<[string, Summarizer, Record<string, unknown>]> = [
    ["error", async () => { throw new Error("provider down"); }, {}],
    ["empty", async () => "   ", {}],
    ["timeout", () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200)), { timeoutMs: 20 }],
  ];
  for (const [reason, summarize, extra] of cases) {
    logs = [];
    const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
    const result = await compactIfNeeded(deps(summarize, extra), { sessionId: id, agent: "jade", incomingMessage: "now" });
    expect(result.status).toBe("failed");
    expect(store.getTurns(id)).toHaveLength(20);
    expect(store.getSummary(id)).toBeNull();
    expect(logs.find((l) => l.msg === "session compaction failed")?.fields).toMatchObject({ agent: "jade", reason: "idle", error: expect.stringContaining(reason === "error" ? "provider down" : reason) });
  }

  logs = [];
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const broken = Object.create(store) as SessionStore;
  broken.publishSummary = () => { throw new Error("disk full"); };
  const result = await compactIfNeeded({ store: broken, summarize: async () => "S", log, now: () => NOW }, { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result.status).toBe("failed");
  expect(store.getTurns(id)).toHaveLength(20);
  expect(logs.find((l) => l.msg === "session compaction failed")?.fields?.error).toContain("disk full");
});

test("AC-8 a stale snapshot publishes nothing", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const summarize: Summarizer = async () => {
    // Another compaction publishes first.
    expect(store.publishSummary({ sessionId: id, expectedVersion: 0, summary: "OTHER", coversThroughTurn: 0, turnIds: [] })).toBe(true);
    return "MINE";
  };
  const result = await compactIfNeeded(deps(summarize), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result.status).toBe("stale");
  expect(store.getSummary(id)?.summary).toBe("OTHER");
  expect(store.getTurns(id)).toHaveLength(20);
});

test("AC-9 a published compaction logs agent, reason, counts and the summary's estimated tokens", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  await compactIfNeeded(deps(async () => "s".repeat(400)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(logs.filter((l) => l.msg === "session compacted")).toEqual([
    { level: "info", msg: "session compacted", fields: { agent: "jade", reason: "idle", summarized: 10, kept: 10, summaryEstimatedTokens: 100 } },
  ]);
});

test("AC-10 manual compaction keeps the tail, needs one eligible message, and otherwise makes no call", async () => {
  const id = session(14, 10, 60_000);
  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  const result = await compactSession(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", reason: "manual" });
  expect(result).toMatchObject({ status: "compacted", reason: "manual", summarized: 4, kept: 10 });

  const small = session(10, 10, 60_000);
  const none = await compactSession(deps(fakeSummarizer(calls)), { sessionId: small, agent: "jade", reason: "manual" });
  expect(none.status).toBe("nothing");
  expect(calls).toHaveLength(1);
});

test("AC-12 branching rooms are skipped and the skip is logged when a trigger would fire", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const calls: Array<{ previousSummary?: string; turns: string[] }> = [];
  const auto = await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", incomingMessage: "now", branching: true });
  const manual = await compactSession(deps(fakeSummarizer(calls)), { sessionId: id, agent: "jade", reason: "manual", branching: true });
  expect(auto.status).toBe("skipped");
  expect(manual.status).toBe("skipped");
  expect(calls).toHaveLength(0);
  expect(store.getTurns(id)).toHaveLength(20);
  expect(logs.filter((l) => l.msg === "session compaction skipped").map((l) => l.fields)).toEqual([
    { agent: "jade", reason: "branching" },
    { agent: "jade", reason: "branching" },
  ]);

  logs = [];
  const quiet = session(4, 10, 60_000);
  await compactIfNeeded(deps(fakeSummarizer(calls)), { sessionId: quiet, agent: "jade", incomingMessage: "now", branching: true });
  expect(logs).toEqual([]);
});

test("AC-6/AC-7 the published or untouched state is what a reopened database shows", async () => {
  const ok = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const failed = session(20, 10, COMPACT_IDLE_MS + 60_000);
  await compactIfNeeded(deps(async () => "KEPT"), { sessionId: ok, agent: "jade", incomingMessage: "now" });
  await compactIfNeeded(deps(async () => { throw new Error("down"); }), { sessionId: failed, agent: "jade", incomingMessage: "now" });
  const reopened = new SessionStore(join(dir, "sessions.db"));
  expect(reopened.getSummary(ok)).toMatchObject({ summary: "KEPT", version: 1 });
  expect(reopened.getTurns(ok)).toHaveLength(10);
  expect(reopened.getSummary(failed)).toBeNull();
  expect(reopened.getTurns(failed)).toHaveLength(20);
});

test("AC-7 after a failed automatic compaction the session is not retried for 30 minutes; manual compaction still runs", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const failures = new Map<string, number>();
  let now = NOW;
  let calls = 0;
  const summarize: Summarizer = async () => { calls++; if (calls === 1) throw new Error("down"); return "S"; };
  const d = { store, summarize, log, now: () => now, failures };
  expect((await compactIfNeeded(d, { sessionId: id, agent: "jade", incomingMessage: "now" })).status).toBe("failed");
  now += 60_000;
  expect((await compactIfNeeded(d, { sessionId: id, agent: "jade", incomingMessage: "now" })).status).toBe("nothing");
  expect(calls).toBe(1);
  now += COMPACT_IDLE_MS;
  expect((await compactIfNeeded(d, { sessionId: id, agent: "jade", incomingMessage: "now" })).status).toBe("compacted");
  expect(calls).toBe(2);

  const other = session(20, 10, COMPACT_IDLE_MS + 60_000);
  failures.set(other, now);
  expect((await compactSession(d, { sessionId: other, agent: "jade", reason: "manual" })).status).toBe("compacted");
});

test("AC-7 the deadline aborts the summary query itself", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  let seen: AbortSignal | undefined;
  const summarize: Summarizer = ({ signal }) => {
    seen = signal;
    return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  };
  const result = await compactIfNeeded(deps(summarize, { timeoutMs: 20 }), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result.status).toBe("failed");
  expect(seen?.aborted).toBe(true);
  expect(store.getTurns(id)).toHaveLength(20);
});

test("AC-7 a summary longer than the bound is a failure, and nothing changes", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  const result = await compactIfNeeded(deps(async () => "s".repeat(SUMMARY_MAX_CHARS + 1)), { sessionId: id, agent: "jade", incomingMessage: "now" });
  expect(result.status).toBe("failed");
  expect(store.getSummary(id)).toBeNull();
  expect(store.getTurns(id)).toHaveLength(20);
  expect(logs.find((l) => l.msg === "session compaction failed")?.fields?.error).toContain("too long");
});

test("providerSummarizer asks for a bounded answer, passes the signal, and stops an over-long or aborted stream", async () => {
  const turns = store.getTurns(session(4, 10, 0));
  const requests: ProviderRequest[] = [];
  const once: Provider = { name: "claude", query: async (req: ProviderRequest): Promise<ProviderResponse> => { requests.push(req); return { message: { role: "assistant", content: "short" } }; } };
  const controller = new AbortController();
  expect(await providerSummarizer(once, "m")({ previousSummary: "prev", turns, signal: controller.signal })).toBe("short");
  expect(requests[0]).toMatchObject({ agent: "compactor", effort: "normal", model: "m", signal: controller.signal });
  expect(String(requests[0]!.messages[0]!.content)).toStartWith("PREVIOUS SUMMARY:\nprev");

  let pulled = 0;
  const endless: Provider = {
    name: "claude",
    query: (() => (async function* (): AsyncGenerator<ProviderChunk> {
      for (;;) { pulled++; yield { type: "text", content: "x".repeat(1000) }; }
    })()) as Provider["query"],
  };
  await expect(providerSummarizer(endless)({ turns, signal: new AbortController().signal })).rejects.toThrow("too long");
  expect(pulled).toBeLessThanOrEqual(SUMMARY_MAX_CHARS / 1000 + 1);

  const aborted = new AbortController();
  aborted.abort(new Error("deadline"));
  await expect(providerSummarizer(endless)({ turns, signal: aborted.signal })).rejects.toThrow("deadline");
});

test("startCastleCompaction runs a triggered compaction in the background, once per session, and trims that turn", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider: Provider = {
    name: "claude",
    query: async (): Promise<ProviderResponse> => { calls++; await gate; return { message: { role: "assistant", content: "BG SUMMARY" } }; },
  };
  const input = { store, sessionId: id, agent: "jade", branching: false, provider, incomingMessage: "now", now: NOW, failures: new Map<string, number>() };
  const first = startCastleCompaction(input);
  expect(first).toMatchObject({ summary: undefined, budget: COMPACTING_TURN_BUDGET });
  expect(first.pending).toBeDefined();
  const second = startCastleCompaction(input);
  expect(second.pending).toBe(first.pending);
  release();
  await waitForCastleCompactions();
  expect(calls).toBe(1);
  expect(startCastleCompaction({ ...input, now: Date.parse(store.getTurns(id).at(-1)!.ts) + 1000 })).toEqual({ summary: "BG SUMMARY", budget: CASTLE_PRIOR_HISTORY_BUDGET });

  const quiet = session(4, 10, 0);
  expect(startCastleCompaction({ ...input, sessionId: quiet, now: Date.now() })).toEqual({ summary: undefined, budget: CASTLE_PRIOR_HISTORY_BUDGET });
  const branching = session(20, 10, COMPACT_IDLE_MS + 60_000);
  expect(startCastleCompaction({ ...input, sessionId: branching, branching: true })).toEqual({ budget: COMPACTING_TURN_BUDGET });
  expect(calls).toBe(1);
});

test("a background compaction that throws unexpectedly is logged as failed, backs off, and never becomes an unhandled rejection", async () => {
  const id = session(20, 10, COMPACT_IDLE_MS + 60_000);
  let reads = 0;
  const faulty = Object.create(store) as SessionStore;
  // startCastleCompaction's own read succeeds; the worker's first read fails.
  faulty.getTurns = (sessionId: string) => {
    reads++;
    if (reads === 2) throw new Error("injected SQLite read IO error");
    return store.getTurns(sessionId);
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => { errors.push(String(line)); };
  try {
    let queries = 0;
    const provider: Provider = { name: "claude", query: async (): Promise<ProviderResponse> => { queries++; return { message: { role: "assistant", content: "S" } }; } };
    const failures = new Map<string, number>();
    const input = { store: faulty, sessionId: id, agent: "jade", branching: false, provider, incomingMessage: "now", now: NOW, failures };
    // The caller drops `pending`, as talk.ts does.
    startCastleCompaction(input);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
    expect(errors.some((line) => line.includes("session compaction failed") && line.includes("injected SQLite read IO error"))).toBe(true);
    expect(store.getTurns(id)).toHaveLength(20);
    expect(store.getSummary(id)).toBeNull();
    // No immediate automatic retry.
    expect(startCastleCompaction({ ...input, store })).toEqual({ summary: undefined, budget: COMPACTING_TURN_BUDGET });
    expect(queries).toBe(0);
  } finally {
    console.error = originalError;
    process.off("unhandledRejection", onUnhandled);
  }
});
