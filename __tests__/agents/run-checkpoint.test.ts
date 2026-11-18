import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runLoopMode } from "../../src/agents/loop";
import { classifyStopError, goalHash } from "../../src/agents/run-checkpoint";
import type { LoadedAgent } from "../../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";

const HOUR = 3_600_000;
let dir: string;
let dbPath: string;
let store: SessionStore;
let manager: SessionManager;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-run-checkpoint-"));
  dbPath = join(dir, "sessions.db");
  store = new SessionStore(dbPath);
  manager = new SessionManager({ store, maxTokens: 200_000 });
  now = Date.parse("2026-10-13T12:00:00Z");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

type Step = string | Error | ((request: ProviderRequest) => string | Error);

function provider(steps: Step[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    name: "claude",
    requests,
    query(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      const step = steps[i++] ?? '<DONE reason="no more steps" />';
      const value = typeof step === "function" ? step(request) : step;
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve({ message: { role: "assistant", content: value } });
    },
  };
}

function agent(name = "test-agent"): LoadedAgent {
  return {
    name, label: "Test Agent", roomDir: dir, geneContent: "Core.", soulContent: "Soul.", soulPath: join(dir, "soul.md"),
    sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
    config: {
      provider: { type: "claude", model: "claude-test", modeMap: {} },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "auto", compactThreshold: 60000 },
      memory: undefined,
    },
  } as unknown as LoadedAgent;
}

function lastUserMessage(request: ProviderRequest): string {
  const user = [...request.messages].reverse().find((message) => message.role === "user");
  const content = user?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function checkpointCount(): number {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS n FROM run_checkpoints").get() as { n: number }).n; }
  catch { return 0; }
  finally { db.close(); }
}

const LOOP = (reason: string) => `Working.\n<LOOP reason="${reason}" />`;

describe("classifyStopError", () => {
  test("quota and token exhaustion are named", () => {
    expect(classifyStopError(new Error("429 Too Many Requests: quota exceeded"))).toBe("quota");
    expect(classifyStopError(new Error("insufficient balance"))).toBe("quota");
    expect(classifyStopError(new Error("context length exceeded"))).toBe("quota");
    expect(classifyStopError(new Error("socket hang up"))).toBe("provider_error");
  });
});

describe("session store records", () => {
  test("round trip and status", () => {
    const saved = store.saveRunCheckpoint({
      agent: "a", sessionId: "s1", goal: "g", goalHash: goalHash("g"), stopReason: "max_reached",
      iteration: 2, maxIterations: 2, lastOutcome: "completed", remaining: "r", createdAt: new Date(now).toISOString(),
    });
    expect(store.getLatestOpenRunCheckpoint("a", goalHash("g"))).toEqual(saved);
    store.setRunCheckpointStatus(saved.id, "resumed");
    expect(store.getLatestOpenRunCheckpoint("a", goalHash("g"))).toBeNull();
  });
});

describe("checkpoint on a non-done exit", () => {
  test("iteration cap", async () => {
    const result = await runLoopMode(agent(), "goal", provider([LOOP("step 2 done, step 3 remaining"), LOOP("step 2 done, step 3 remaining")]), manager, store,
      { maxIterations: 2, checkpoints: true, now: () => now });
    expect(result.exitReason).toBe("max_reached");
    expect(result.checkpoint).toMatchObject({ stopReason: "max_reached", iteration: 2, lastOutcome: "completed", remaining: "step 2 done, step 3 remaining", status: "open" });
  });

  test("done writes nothing", async () => {
    const result = await runLoopMode(agent(), "goal", provider(['<DONE reason="ok" />']), manager, store, { checkpoints: true, now: () => now });
    expect(result.exitReason).toBe("done");
    expect(result.checkpoint).toBeUndefined();
    expect(checkpointCount()).toBe(0);
  });

  test("disabled", async () => {
    const result = await runLoopMode(agent(), "goal", provider([LOOP("a"), LOOP("b")]), manager, store, { maxIterations: 2 });
    expect(result.exitReason).toBe("max_reached");
    expect(result.checkpoint).toBeUndefined();
    expect(checkpointCount()).toBe(0);
  });

  test("abort after a step", async () => {
    const controller = new AbortController();
    const steps = provider([() => { controller.abort(); return LOOP("half way"); }]);
    const result = await runLoopMode(agent(), "goal", steps, manager, store, { checkpoints: true, signal: controller.signal, now: () => now });
    expect(result.exitReason).toBe("interrupted");
    expect(result.checkpoint).toMatchObject({ stopReason: "interrupted", iteration: 1, lastOutcome: "completed" });
  });

  test("abort that makes the provider throw", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const steps = provider([() => { controller.abort(); return abortError; }]);
    const result = await runLoopMode(agent(), "goal", steps, manager, store, { checkpoints: true, signal: controller.signal, now: () => now });
    expect(result.checkpoint).toMatchObject({ stopReason: "interrupted", lastOutcome: "unknown" });
  });

  test("quota error", async () => {
    const result = await runLoopMode(agent(), "goal", provider([LOOP("1"), LOOP("2"), new Error("429 Too Many Requests: quota exceeded")]), manager, store,
      { maxIterations: 5, checkpoints: true, now: () => now });
    expect(result.exitReason).toBe("error");
    expect(result.checkpoint).toMatchObject({ stopReason: "quota", iteration: 3, lastOutcome: "unknown" });
  });

  test("other provider error", async () => {
    const result = await runLoopMode(agent(), "goal", provider([new Error("socket hang up")]), manager, store, { checkpoints: true, now: () => now });
    expect(result.checkpoint?.stopReason).toBe("provider_error");
  });
});

describe("resume", () => {
  test("resume does not restart from step 1", async () => {
    const first = await runLoopMode(agent(), "goal", provider([LOOP("x"), LOOP("step 2 done, step 3 remaining")]), manager, store,
      { maxIterations: 2, checkpoints: true, now: () => now });
    const turns: number[] = [];
    const second = provider(['<DONE reason="finished" />']);
    const result = await runLoopMode(agent(), "goal", second, manager, store,
      { maxIterations: 2, checkpoints: true, resume: true, now: () => now, onTurn: (n) => turns.push(n) });
    expect(result.exitReason).toBe("done");
    expect(turns[0]).toBe(3);
    const message = lastUserMessage(second.requests[0]!);
    expect(message).toContain("stopped: max_reached");
    expect(message).toContain("step 3 remaining");
    expect(second.requests[0]!.sessionId).toBe(first.checkpoint!.sessionId);
    expect(store.getRunCheckpoint(first.checkpoint!.id)?.status).toBe("resumed");
  });

  test("different goal is not resumed", async () => {
    const first = await runLoopMode(agent(), "goal A", provider([LOOP("a")]), manager, store, { maxIterations: 1, checkpoints: true, now: () => now });
    const turns: number[] = [];
    await runLoopMode(agent(), "goal B", provider(['<DONE reason="ok" />']), manager, store,
      { checkpoints: true, resume: true, now: () => now, onTurn: (n) => turns.push(n) });
    expect(turns[0]).toBe(1);
    expect(store.getRunCheckpoint(first.checkpoint!.id)?.status).toBe("open");
  });

  test("old checkpoint", async () => {
    await runLoopMode(agent(), "goal", provider([LOOP("a")]), manager, store, { maxIterations: 1, checkpoints: true, now: () => now - 25 * HOUR });
    const second = provider(['<DONE reason="ok" />']);
    await expect(runLoopMode(agent(), "goal", second, manager, store, { checkpoints: true, resume: true, now: () => now })).rejects.toThrow("stale checkpoint");
    expect(second.requests).toHaveLength(0);

    // The refused checkpoint is closed as expired, so the next resume of the goal starts fresh instead of throwing forever.
    expect(store.getLatestOpenRunCheckpoint("test-agent", goalHash("goal"))).toBeNull();
    const turns: number[] = [];
    await runLoopMode(agent(), "goal", provider(['<DONE reason="ok" />']), manager, store,
      { checkpoints: true, resume: true, now: () => now, onTurn: (n) => turns.push(n) });
    expect(turns[0]).toBe(1);
  });

  test("resume keeps the remaining work if the first resumed step fails", async () => {
    await runLoopMode(agent(), "goal", provider([LOOP("step 3 remaining")]), manager, store, { maxIterations: 1, checkpoints: true, now: () => now });
    const result = await runLoopMode(agent(), "goal", provider([new Error("socket hang up")]), manager, store,
      { checkpoints: true, resume: true, now: () => now });
    expect(result.checkpoint).toMatchObject({ stopReason: "provider_error", iteration: 2, remaining: "step 3 remaining" });
  });

  test("resume after an unknown step", async () => {
    await runLoopMode(agent(), "goal", provider([new Error("quota exceeded")]), manager, store, { checkpoints: true, now: () => now });
    const second = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", second, manager, store, { checkpoints: true, resume: true, now: () => now });
    const message = lastUserMessage(second.requests[0]!);
    expect(message).toContain("outcome of step 1 is unknown");
    expect(message).toContain("verify");
    expect(message).not.toBe("goal");
  });
});

describe("record contents", () => {
  test("fields only", async () => {
    await runLoopMode(agent(), "goal", provider([LOOP("a")]), manager, store,
      { maxIterations: 1, checkpoints: true, mailContext: "SECRET-MAIL", now: () => now });
    const db = new Database(dbPath, { readonly: true });
    const columns = (db.prepare("PRAGMA table_info(run_checkpoints)").all() as Array<{ name: string }>).map((c) => c.name).sort();
    const rows = db.prepare("SELECT * FROM run_checkpoints").all() as Array<Record<string, unknown>>;
    db.close();
    expect(columns).toEqual(["agent", "created_at", "goal", "goal_hash", "id", "iteration", "last_outcome", "max_iterations", "remaining", "session_id", "status", "stop_reason", "work_id"]);
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0]!).some((value) => String(value).includes("SECRET-MAIL"))).toBe(false);
  });
});
