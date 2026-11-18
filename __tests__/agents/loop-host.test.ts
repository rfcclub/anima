/**
 * castle-work-loop: runLoopMode host options — signal propagation, step markers
 * around every provider call, work-scoped recovery that does not depend on the resumed flag, and a
 * fresh session for a stale checkpoint. A fake provider and a fake host; real SessionStore.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoopMode, type LoopHost, type LoopHostStep } from "../../src/agents/loop";
import { buildResumeMessage, goalHash } from "../../src/agents/run-checkpoint";
import type { LoadedAgent } from "../../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";

let dir: string;
let store: SessionStore;
let manager: SessionManager;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-loop-host-"));
  store = new SessionStore(join(dir, "sessions.db"));
  manager = new SessionManager({ store, maxTokens: 200_000 });
  now = Date.parse("2026-10-22T12:00:00Z");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

type Step = string | Error | ((request: ProviderRequest) => Promise<string> | string);

function provider(steps: Step[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    name: "claude",
    requests,
    async query(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      const step = steps[i++] ?? '<DONE reason="no more steps" />';
      const value = typeof step === "function" ? await step(request) : step;
      if (value instanceof Error) throw value;
      return { message: { role: "assistant", content: value } };
    },
  };
}

function agent(): LoadedAgent {
  return {
    name: "finn", label: "Finn", roomDir: dir, geneContent: "Core.", soulContent: "Soul.", soulPath: join(dir, "soul.md"),
    sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
    config: {
      provider: { type: "claude", model: "claude-test", modeMap: {} },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "auto", compactThreshold: 60000 },
      memory: undefined,
    },
  } as unknown as LoadedAgent;
}

const lastUser = (r: ProviderRequest) => {
  const u = [...r.messages].reverse().find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};
const LOOP = (reason: string) => `Working.\n<LOOP reason="${reason}" />`;

function fakeHost(over: Partial<LoopHost> & { open?: LoopHostStep[]; note?: string } = {}) {
  const log: string[] = [];
  const open: LoopHostStep[] = [...(over.open ?? [])];
  const reconciled: Array<{ steps: LoopHostStep[]; stale: boolean }> = [];
  let n = 0;
  const host: LoopHost = {
    workId: "wabc",
    beginStep: (info) => { const id = `st${++n}`; log.push(`begin:${info.kind}:${info.seq}`); open.push({ id, seq: info.seq, kind: info.kind }); return id; },
    endStep: (id, outcome) => { log.push(`end:${id}:${outcome}`); const i = open.findIndex((s) => s.id === id); if (i >= 0 && outcome === "completed") open.splice(i, 1); },
    openSteps: () => [...open],
    reconcile: async (steps, ctx) => { reconciled.push({ steps, stale: ctx.stale }); for (const s of steps) { const i = open.findIndex((x) => x.id === s.id); if (i >= 0) open.splice(i, 1); } return over.note ?? "tree clean, branch has no new commits"; },
    ...over,
  };
  return { host, log, open, reconciled };
}

describe("step markers", () => {
  test("a marker opens before every provider call and closes after it", async () => {
    const { host, log, open } = fakeHost();
    const p = provider([LOOP("a"), LOOP("b"), '<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host });
    expect(log.filter((l) => l.startsWith("begin:provider")).length).toBe(3);
    expect(log.filter((l) => l.endsWith(":completed")).length).toBe(3);
    expect(open).toEqual([]);
    // each begin comes before the provider call that follows it
    expect(log[0]).toBe("begin:provider:1");
  });

  test("a failing provider leaves the marker open and unknown", async () => {
    const { host, log, open } = fakeHost();
    const p = provider([new Error("socket hang up")]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host });
    expect(r.exitReason).toBe("error");
    expect(log).toContain("end:st1:unknown");
    expect(open.length).toBe(1);
    expect(r.checkpoint?.workId).toBe("wabc");
    expect(r.checkpoint?.lastOutcome).toBe("unknown");
  });

  test("when the marker cannot be written the provider is not called", async () => {
    const { host } = fakeHost({ beginStep: () => { throw new Error("database is locked"); } });
    const p = provider([LOOP("a")]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host });
    expect(p.requests.length).toBe(0);
    expect(r.exitReason).toBe("error");
  });
});

describe("signal", () => {
  test("the provider request carries the abort signal and an abort stops the call", async () => {
    const { host } = fakeHost();
    const controller = new AbortController();
    const p = provider([
      (request) => new Promise<string>((_, reject) => {
        expect(request.signal).toBe(controller.signal);
        request.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => controller.abort(), 20);
      }),
    ]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host, signal: controller.signal });
    expect(r.exitReason).toBe("error");
    expect(r.checkpoint?.stopReason).toBe("interrupted");
    expect(r.checkpoint?.lastOutcome).toBe("unknown");
    expect(r.interruptionSource).toBe("abort");
  });

  test("the first interruption wins when SIGINT precedes a later abort", async () => {
    const existing = new Set(process.listeners("SIGINT"));
    const controller = new AbortController();
    const { host } = fakeHost();
    const p = provider([() => {
      const added = process.listeners("SIGINT").filter(listener => !existing.has(listener));
      expect(added).toHaveLength(1);
      Reflect.apply(added[0]!, process, []);
      controller.abort();
      return '<DONE reason="late" />';
    }]);
    const result = await runLoopMode(agent(), "goal", p, manager, store, { host, checkpoints: true, signal: controller.signal });
    expect(result.exitReason).toBe("interrupted");
    expect(result.interruptionSource).toBe("sigint");
  });
});

describe("cost link", () => {
  test("every provider request of the session carries the host's work link; without one none does", async () => {
    const link = { workId: "wabc", jobId: "job-1", claimId: "claim-1", sessionNo: 2 };
    const { host } = fakeHost({ link });
    const p = provider([LOOP("a"), '<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host });
    expect(p.requests.map((r) => r.work)).toEqual([link, link]);

    const plain = fakeHost();
    const q = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", q, manager, store, { maxIterations: 5, host: plain.host });
    expect(q.requests[0]!.work).toBeUndefined();
  });
});

describe("iteration cap", () => {
  test("a persistently failing provider is called once, not retried inside the session", async () => {
    const { host } = fakeHost();
    const p = provider([new Error("boom"), new Error("boom"), new Error("boom")]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host });
    expect(p.requests.length).toBe(1);
  });

  test("never more than the iteration limit of provider calls", async () => {
    const { host } = fakeHost();
    const p = provider(Array.from({ length: 20 }, (_, i) => LOOP(`step ${i}`)));
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host });
    expect(p.requests.length).toBe(5);
    expect(r.exitReason).toBe("max_reached");
  });
});

describe("work-scoped recovery", () => {
  function saveCheckpoint(over: Record<string, unknown> = {}) {
    const session = manager.openSession("finn", "work:wabc");
    manager.appendTurn(session.id, "user", "goal");
    manager.appendTurn(session.id, "assistant", LOOP("half done"));
    return store.saveRunCheckpoint({
      agent: "finn", sessionId: session.id, goal: "goal", goalHash: goalHash("goal"), stopReason: "max_reached",
      iteration: 2, maxIterations: 5, lastOutcome: "completed", remaining: "finish the tests", createdAt: new Date(now - 60_000).toISOString(),
      workId: "wabc", ...over,
    } as never);
  }

  test("changed revision goal is included with review feedback when a work checkpoint resumes", async () => {
    const cp = saveCheckpoint();
    const revision = "This is a revision.\n<review>Fix failed bootout and check other plist locations.</review>";
    const { host } = fakeHost({
      open: [{ id: "old1", seq: 3, kind: "provider" }],
      note: "check the existing branch",
    });
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), revision, p, manager, store, {
      maxIterations: 5, resume: true, checkpoints: true, host, now: () => now,
    });
    const first = lastUser(p.requests[0]!);
    expect(p.requests[0]!.sessionId).toBe(cp.sessionId);
    expect(first).toContain("[resume]");
    expect(first).toContain("[goal changed]");
    expect(first).toContain(revision);
    expect(first).toContain("outcome is unknown");
    expect(first).toContain("check the existing branch");
  });

  test("unchanged work goal preserves the existing resume message without duplication", async () => {
    const cp = saveCheckpoint();
    const { host } = fakeHost();
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", p, manager, store, {
      maxIterations: 5, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(p.requests[0]!.sessionId).toBe(cp.sessionId);
    expect(lastUser(p.requests[0]!)).toBe(buildResumeMessage(cp));
  });

  test("changed revision goal survives stale checkpoint recovery in a fresh session", async () => {
    const cp = saveCheckpoint({ createdAt: new Date(now - 25 * 3_600_000).toISOString() });
    const { host, reconciled } = fakeHost({ note: "inspect the tree before revising" });
    const p = provider(['<DONE reason="ok" />']);
    const revision = "Revise the work.\n<review>Fix the launchd check.</review>";
    await runLoopMode(agent(), revision, p, manager, store, {
      maxIterations: 5, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(reconciled[0]!.stale).toBe(true);
    expect(p.requests[0]!.sessionId).not.toBe(cp.sessionId);
    expect(lastUser(p.requests[0]!)).toContain("[goal changed]");
    expect(lastUser(p.requests[0]!)).toContain(revision);
    expect(lastUser(p.requests[0]!)).toContain("inspect the tree before revising");
  });

  test("a later checkpoint records the revised goal and resumes it without appending it again", async () => {
    saveCheckpoint();
    const revision = "Revision:\n<review>Fix the launchd check.</review>";
    const { host } = fakeHost();
    const first = provider([LOOP("still working")]);
    const result = await runLoopMode(agent(), revision, first, manager, store, {
      maxIterations: 1, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(result.checkpoint?.goalHash).toBe(goalHash(revision));
    const second = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), revision, second, manager, store, {
      maxIterations: 1, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(lastUser(second.requests[0]!)).toBe(buildResumeMessage(result.checkpoint!));
  });

  test("a changed goal explicitly supersedes the old goal and earlier review", async () => {
    const oldGoal = "First revision:\n<review>Keep the old behavior.</review>";
    const newGoal = "Second revision:\n<review>Replace the old behavior.</review>";
    saveCheckpoint({ goal: oldGoal, goalHash: goalHash(oldGoal) });
    const { host } = fakeHost();
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), newGoal, p, manager, store, {
      maxIterations: 5, resume: true, checkpoints: true, host, now: () => now,
    });
    const first = lastUser(p.requests[0]!);
    const precedence = "The current goal below supersedes the goal above, including any earlier <review>.";
    expect(first).toContain(oldGoal);
    expect(first).toContain(precedence);
    expect(first).toContain(newGoal);
    expect(first.indexOf(oldGoal)).toBeLessThan(first.indexOf(precedence));
    expect(first.indexOf(precedence)).toBeLessThan(first.indexOf(newGoal));
  });

  test("a changed goal without review uses a neutral label", async () => {
    saveCheckpoint();
    const { host } = fakeHost();
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "Investigate the database.", p, manager, store, {
      maxIterations: 5, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(lastUser(p.requests[0]!)).toContain("[goal changed]");
    expect(lastUser(p.requests[0]!)).not.toContain("[revision]");
  });

  test("an open step from a dead session is reconciled before anything is repeated and is named in the first message", async () => {
    const cp = saveCheckpoint();
    const { host, reconciled } = fakeHost({ open: [{ id: "old1", seq: 3, kind: "provider" }], note: "src/a.ts was half written; the branch has no new commit" });
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, resume: true, checkpoints: true, host, now: () => now });
    expect(reconciled.length).toBe(1);
    expect(reconciled[0]!.steps.map((s) => s.id)).toEqual(["old1"]);
    expect(reconciled[0]!.stale).toBe(false);
    const first = lastUser(p.requests[0]!);
    expect(first).toContain("[resume]");
    expect(first).toContain("unknown");
    expect(first).toContain("src/a.ts was half written");
    expect(cp.workId).toBe("wabc");
  });

  test("a checkpoint marked resumed by a run that died is still found by the next run for the same work", async () => {
    const cp = saveCheckpoint();
    store.setRunCheckpointStatus(cp.id, "resumed"); // what the old resume path did before the first call
    const { host } = fakeHost();
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, resume: true, checkpoints: true, host, now: () => now });
    expect(lastUser(p.requests[0]!)).toContain("[resume]");
    expect(lastUser(p.requests[0]!)).toContain("finish the tests");
  });

  test("the checkpoint stays open while the resumed run is unfinished and is consumed when that run ends", async () => {
    const cp = saveCheckpoint();
    const { host } = fakeHost();
    let statusDuringCall = "";
    const p = provider([() => { statusDuringCall = store.getRunCheckpoint(cp.id)!.status; return '<DONE reason="ok" />'; }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, resume: true, checkpoints: true, host, now: () => now });
    expect(statusDuringCall).toBe("open");
    expect(store.getRunCheckpoint(cp.id)!.status).toBe("done");
  });

  test("when the resumed run stops again, its checkpoint is marked resumed only after the new one is saved", async () => {
    const cp = saveCheckpoint();
    const { host } = fakeHost();
    const p = provider([LOOP("still more")]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 1, resume: true, checkpoints: true, host, now: () => now });
    expect(store.getRunCheckpoint(cp.id)!.status).toBe("resumed");
    expect(store.getLatestRunCheckpointForWork("wabc")?.id).toBe(r.checkpoint?.id);
  });

  test("a completed newer checkpoint does not revive an earlier resumed work checkpoint", async () => {
    const old = saveCheckpoint();
    const { host } = fakeHost();
    const continuing = provider([LOOP("newer checkpoint")]);
    const second = await runLoopMode(agent(), "goal", continuing, manager, store, {
      maxIterations: 1, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(store.getRunCheckpoint(old.id)!.status).toBe("resumed");
    expect(second.checkpoint).toBeDefined();
    const completing = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", completing, manager, store, {
      maxIterations: 1, resume: true, checkpoints: true, host, now: () => now,
    });
    expect(store.getRunCheckpoint(second.checkpoint!.id)!.status).toBe("done");
    expect(store.getLatestRunCheckpointForWork("wabc")).toBeNull();
  });

  test("a checkpoint older than 24 hours is reconciled and a fresh session starts instead of throwing", async () => {
    const cp = saveCheckpoint({ createdAt: new Date(now - 25 * 3_600_000).toISOString() });
    const { host, reconciled } = fakeHost({ note: "branch is two commits behind master" });
    const p = provider(['<DONE reason="ok" />']);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, resume: true, checkpoints: true, host, now: () => now });
    expect(reconciled[0]!.stale).toBe(true);
    expect(p.requests[0]!.sessionId).not.toBe(cp.sessionId);
    expect(lastUser(p.requests[0]!)).toContain("branch is two commits behind master");
    expect(r.exitReason).toBe("done");
  });

  test("a checkpoint of another work is not picked up", async () => {
    saveCheckpoint({ workId: "wother" });
    const { host, reconciled } = fakeHost();
    const p = provider(['<DONE reason="ok" />']);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, resume: true, checkpoints: true, host, now: () => now });
    expect(reconciled.length).toBe(0);
    expect(lastUser(p.requests[0]!)).not.toContain("[resume]");
  });

  test("a new checkpoint saved by the run carries the work id", async () => {
    const { host } = fakeHost();
    const p = provider([LOOP("more")]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 1, checkpoints: true, host });
    expect(r.checkpoint?.workId).toBe("wabc");
    expect(store.getLatestRunCheckpointForWork("wabc")?.id).toBe(r.checkpoint?.id);
  });
});

describe("without host options", () => {
  test("a stale checkpoint still throws and the provider request has no marker calls", async () => {
    const session = manager.openSession("finn", "loop");
    store.saveRunCheckpoint({
      agent: "finn", sessionId: session.id, goal: "goal", goalHash: goalHash("goal"), stopReason: "max_reached",
      iteration: 1, maxIterations: 1, lastOutcome: "completed", remaining: "r", createdAt: new Date(now - 25 * 3_600_000).toISOString(),
    });
    const p = provider(['<DONE reason="ok" />']);
    await expect(runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, resume: true, checkpoints: true, now: () => now })).rejects.toThrow(/stale checkpoint/);
  });
});
