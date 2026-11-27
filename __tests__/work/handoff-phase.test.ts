/**
 * Handoff as its own task (owner, 2026-11-27). When a loop work session runs out of time or iterations it is not cut
 * off mid-thought: the model finishes its current turn, then gets a few more turns in the same conversation whose
 * only job is the handoff note. The consumer gives such an executor a grace period before it hard-stops it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoopMode, type LoopHostTools, type LoopRunOptions } from "../../src/agents/loop";
import type { LoadedAgent } from "../../src/agents/loader";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import { SessionStore } from "../../src/memory/session-store";
import type { MeshClaim, MeshJob } from "../../src/mesh-jobs/client";
import type { JobsPort, GitHubReader } from "../../src/mesh-jobs/consumer";
import type { Provider, ProviderToolCall } from "../../src/providers/interface";
import { SessionManager } from "../../src/session/manager";
import { issueDigest12 } from "../../src/work/approval";
import { loadWorkConfig } from "../../src/work/config";
import { createWorkHandler, type SessionExecutor, type SessionResult } from "../../src/work/consumer";
import { createLoopHost } from "../../src/work/runner";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore } from "../../src/work/store";

let dir: string;
let workStore: WorkStore;
let sessions: SessionStore;
let manager: SessionManager;
let workId: string;
let workSessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "work-handoff-phase-"));
  workStore = WorkStore.open(join(dir, "work.db"), { rootBase: join(dir, "roots") });
  const work = workStore.createWork({ repo: "test/repo", issue: 1, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
  workId = work.workId;
  const reservation = workStore.reserveSession(workId, { jobId: "job-1", claimId: "claim-1" });
  if (!reservation.ok) throw new Error("failed to reserve work session");
  workSessionId = reservation.session.sessionId;
  sessions = new SessionStore(join(dir, "sessions.db"));
  manager = new SessionManager({ store: sessions, maxTokens: 100_000 });
});
afterEach(() => { sessions.close(); workStore.close(); rmSync(dir, { recursive: true, force: true }); });

function agent(): LoadedAgent {
  return {
    name: "finn", label: "Finn", roomDir: dir, geneContent: "core", soulContent: "soul", soulPath: join(dir, "soul"),
    sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
    config: { provider: { type: "fake", model: "fake", modeMap: {} }, policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] }, session: { defaultMode: "auto", compactThreshold: 60000 } },
  } as unknown as LoadedAgent;
}

type Seen = { tools: string[]; message: string };
/** Answers with `script(n)` for the n-th call (0-based) and records what each call was offered. */
function provider(script: (n: number) => { content: string; calls?: ProviderToolCall[] }, seen: Seen[]): Provider {
  let n = 0;
  return { name: "fake", async query(req: { tools?: { name: string }[]; messages: { role: string; content: string }[] }) {
    seen.push({ tools: (req.tools ?? []).map((t) => t.name), message: String(req.messages.at(-1)?.content ?? "") });
    const step = script(n++);
    return { message: { role: "assistant", content: step.content }, ...(step.calls ? { tool_calls: step.calls } : {}) };
  } } as unknown as Provider;
}
const call = (name: string, args: Record<string, unknown> = {}): ProviderToolCall => ({ id: `c-${name}`, name, arguments: JSON.stringify(args) });

const workTools: LoopHostTools = { definitions: [{ name: "bash", description: "", parameters: {} }], async execute() { return "read output"; } };
function handoffTools(writes: string[]): LoopHostTools {
  return {
    definitions: [{ name: "write", description: "", parameters: {} }],
    async execute(c) { if (c.name !== "write") return "Error: only write"; writes.push(JSON.parse(c.arguments).content); return "wrote"; },
  };
}
function host() {
  return { ...createLoopHost(workStore, workId, async () => "checked", { workSessionId }), tools: workTools };
}
const run = (p: Provider, extra: Partial<LoopRunOptions>) =>
  runLoopMode(agent(), "goal", p, manager, sessions, { host: host(), maxIterations: 20, ...extra });

describe("the loop's handoff task", () => {
  test("once the time is up the next turn asks only for the handoff, with only the handoff tools, and ends as a deadline", async () => {
    const seen: Seen[] = [];
    const writes: string[] = [];
    let calls = 0;
    const result = await run(
      provider((n) => (n < 3 ? { content: "reading", calls: [call("bash")] } : { content: "note", calls: [call("write", { content: "Done: x" })] }), seen),
      { handoff: { due: () => ++calls > 3, turns: 10, prompt: "HANDOFF-TASK", tools: handoffTools(writes), check: () => (writes.length ? null : "the note is missing") } },
    );
    expect(result.exitReason).toBe("deadline");
    expect(seen).toHaveLength(4);
    expect(seen[2]!.tools).toEqual(["bash"]);
    expect(seen[3]!.tools).toEqual(["write"]);
    expect(seen[3]!.message).toContain("HANDOFF-TASK");
    expect(seen[3]!.message).toContain("read output");
    expect(writes).toEqual(["Done: x"]);
  });

  test("DONE during the handoff ends the handoff, not the work", async () => {
    const writes: string[] = [];
    const result = await run(
      provider((n) => (n === 0 ? { content: "x", calls: [call("bash")] } : { content: '<DONE reason="handoff written" />' }), []),
      { handoff: { due: () => true, turns: 10, prompt: "HANDOFF-TASK", tools: handoffTools(writes), check: () => "the note is missing" } },
    );
    expect(result.exitReason).toBe("deadline");
  });

  test("an unusable note is sent back with the problem, at most for the given number of turns", async () => {
    const seen: Seen[] = [];
    const result = await run(
      provider(() => ({ content: "note", calls: [call("write", { content: "x" })] }), seen),
      { handoff: { due: () => seen.length >= 1, turns: 3, prompt: "HANDOFF-TASK", tools: handoffTools([]), check: () => "the note is longer than 16384 characters" } },
    );
    expect(result.exitReason).toBe("deadline");
    expect(seen).toHaveLength(4);
    expect(seen[2]!.message).toContain("the note is longer than 16384 characters");
  });

  test("reaching the iteration limit also gets the handoff turns and ends as max_reached", async () => {
    const seen: Seen[] = [];
    const writes: string[] = [];
    const result = await run(
      provider((n) => (n < 2 ? { content: "x", calls: [call("bash")] } : { content: "note", calls: [call("write", { content: "n" })] }), seen),
      { maxIterations: 2, handoff: { due: () => false, turns: 10, prompt: "HANDOFF-TASK", tools: handoffTools(writes), check: () => (writes.length ? null : "missing") } },
    );
    expect(result.exitReason).toBe("max_reached");
    expect(seen).toHaveLength(3);
    expect(seen[2]!.message).toContain("HANDOFF-TASK");
  });

  test("the LOOP reason given during the handoff is kept as the remaining work", async () => {
    const seen: Seen[] = [];
    const result = await run(
      provider((n) => (n === 0 ? { content: "x", calls: [call("bash")] } : { content: '<LOOP reason="next: fix handoff-runner.ts:42" />' }), seen),
      { checkpoints: true, handoff: { due: () => seen.length >= 1, turns: 1, prompt: "HANDOFF-TASK", tools: handoffTools([]), check: () => "missing" } },
    );
    expect(result.checkpoint?.remaining).toBe("next: fix handoff-runner.ts:42");
  });

  test("without a handoff option the limit ends the run as before", async () => {
    const result = await run(provider(() => ({ content: "x", calls: [call("bash")] }), []), { maxIterations: 2 });
    expect(result.exitReason).toBe("max_reached");
  });
});

const BODY = "Intent body v1";
const DIGEST = issueDigest12(BODY);
const github: GitHubReader = {
  async pullRequest() { return { headSha: "a".repeat(40), state: "open", merged: false, title: "PR", body: "", author: "author" }; },
  async diff() { throw new Error("not used"); },
  async issue() { return { title: "t", body: BODY }; },
  async reviews() { return []; },
};
const jobs: JobsPort = {
  async pending() { return 0; }, async claim() { return null; }, async getJob() { throw new Error("unused"); },
  async heartbeat(id: string) { return { id } as MeshClaim; },
  async report(id: string) { return { id } as MeshClaim; },
} as unknown as JobsPort;

describe("the consumer's grace period", () => {
  async function session(executor: SessionExecutor) {
    const store = WorkStore.open(":memory:", { rootBase: dir });
    try {
      const work = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
        config: loadWorkConfig({ author: "finn", caps: { maxSessions: 3, sessionWallMs: 40, workWallMs: 10_000 } }) }).work;
      const handler = createWorkHandler({ store, executor, github, heartbeatMs: 5, heartbeatTimeoutMs: 100,
        recordStop: createStopRecorder({ store, read: (_tree, args) => (args[0] === "rev-parse" ? "a".repeat(40) : "") }),
        collectEvidence: async () => ({ ok: false, reason: "unused" }) });
      const job = { id: "job-1", enqueuer: "owner@mesh", type: "start-work", target: { repo: "rfcclub/anima", kind: "issue", number: 7 },
        slots: 1, expiresAt: Date.now() + 86_400_000, state: "queued", createdAt: Date.now(), workRef: `wabc1234ef0.${DIGEST}` } as MeshJob;
      await handler.run({ worker: "finn", claim: { id: "claim-1", jobId: job.id } as MeshClaim, job, jobs });
      const s = store.listSessions(work.workId)[0]!;
      return { session: s, stop: store.getStop(s.sessionId)! };
    } finally { store.close(); }
  }

  test("an executor with a grace period is not aborted at the deadline, and its own deadline stop is trusted", async () => {
    let abortedAt: number | null = null;
    const executor: SessionExecutor = {
      handoffGraceMs: 5_000,
      ready: () => ({ ok: true }),
      async runSession(input) {
        const start = Date.now();
        input.signal.addEventListener("abort", () => { abortedAt = Date.now() - start; });
        await new Promise((r) => setTimeout(r, 150)); // past the 40 ms deadline: the handoff turns
        return { stopCause: "deadline", iterations: 3, execMs: 150, cessation: "proven" } as SessionResult;
      },
    };
    const { session: s, stop } = await session(executor);
    expect(abortedAt).toBeNull();
    expect(s.stopCause).toBe("deadline");
    expect(stop).toMatchObject({ stopCause: "deadline", cessation: "proven", trusted: true });
  });

  test("the grace period ends in a hard stop, still recorded as a deadline", async () => {
    const executor: SessionExecutor = {
      handoffGraceMs: 60,
      ready: () => ({ ok: true }),
      async runSession(input) {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
        return { stopCause: "interrupted", interruptionSource: "abort", iterations: 3, execMs: 100, cessation: "proven" } as SessionResult;
      },
    };
    const { stop } = await session(executor);
    expect(stop).toMatchObject({ stopCause: "deadline", trusted: true });
  });

  test("an executor without a grace period is aborted at the deadline", async () => {
    let abortedAfter = -1;
    const executor: SessionExecutor = {
      ready: () => ({ ok: true }),
      async runSession(input) {
        const start = Date.now();
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => { abortedAfter = Date.now() - start; resolve(); }));
        return { stopCause: "interrupted", interruptionSource: "abort", iterations: 1, execMs: 40, cessation: "proven" } as SessionResult;
      },
    };
    await session(executor);
    expect(abortedAfter).toBeGreaterThanOrEqual(0);
    expect(abortedAfter).toBeLessThan(1_000);
  });
});
