/**
 * castle-work-loop, WL-3: a session killed for real (SIGKILL of a child process)
 * leaves a durable record, and the next session reconciles before it repeats anything.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoopMode } from "../../src/agents/loop";
import { goalHash } from "../../src/agents/run-checkpoint";
import { createLoopHost } from "../../src/work/runner";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import type { LoadedAgent } from "../../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

let dir: string;
let work: WorkStore;
let sessions: SessionStore;
let manager: SessionManager;
let workId: string;

const agent = (): LoadedAgent => ({
  name: "finn", label: "Finn", roomDir: dir, geneContent: "Core.", soulContent: "Soul.", soulPath: join(dir, "soul.md"),
  sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
  config: {
    provider: { type: "claude", model: "claude-test", modeMap: {} },
    policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
    session: { defaultMode: "auto", compactThreshold: 60000 },
    memory: undefined,
  },
} as unknown as LoadedAgent);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "work-rec-")));
  work = WorkStore.open(join(dir, "work.db"), { rootBase: join(dir, "roots") });
  sessions = new SessionStore(join(dir, "sessions.db"));
  manager = new SessionManager({ store: sessions, maxTokens: 200_000 });
  workId = work.createWork({ repo: "a/x", issue: 7, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work.workId;
});

async function killedChild(): Promise<void> {
  // the parent releases its handles first so the child is the only writer while it runs
  work.close();
  sessions.close();
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/loop-child.ts"), dir, workId, "hang"], {
    env: { PATH: process.env.PATH ?? "", HOME: dir }, stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100 && !existsSync(join(dir, "ready")); i++) await Bun.sleep(50);
  expect(existsSync(join(dir, "ready"))).toBe(true);
  child.kill("SIGKILL");
  await child.exited;
  work = WorkStore.open(join(dir, "work.db"), { rootBase: join(dir, "roots") });
  sessions = new SessionStore(join(dir, "sessions.db"));
  manager = new SessionManager({ store: sessions, maxTokens: 200_000 });
}

function recorder() {
  const order: string[] = [];
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "claude",
    async query(request: ProviderRequest): Promise<ProviderResponse> {
      order.push("provider");
      requests.push(request);
      return { message: { role: "assistant", content: '<DONE reason="ok" />' } };
    },
  };
  return { order, requests, provider };
}
const firstMessage = (r: ProviderRequest) => {
  const user = [...r.messages].reverse().find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
};

describe("death during the first provider call", () => {
  test("the work, tree path and counters survive; the step is reconciled before the provider is called again", async () => {
    // the consumer reserves a session before it starts one
    const reserved = work.reserveSession(workId, { jobId: "j1", claimId: "c1" });
    expect(reserved.ok).toBe(true);
    const before = work.getWork(workId)!;
    await killedChild();

    const open = work.openSteps(workId);
    expect(open.length).toBe(1);
    expect(open[0]!.outcome).toBe("in-progress");

    // restart: the dead session is charged in full, never reset
    work.recoverOpenSessions();
    const mid = work.getWork(workId)!;
    expect(mid.sessionsUsed).toBe(1);
    expect(mid.execMsUsed).toBe(10 * 60_000);

    const r = recorder();
    const host = createLoopHost(work, workId, async (steps) => { r.order.push(`reconcile:${steps.length}`); return "tree has one uncommitted file"; });
    const next = work.reserveSession(workId, { jobId: "j1", claimId: "c2" });
    expect(next.ok).toBe(true);
    await runLoopMode(agent(), "goal", r.provider, manager, sessions, { maxIterations: 5, checkpoints: true, resume: true, host });

    expect(r.order).toEqual(["reconcile:1", "provider"]);
    expect(firstMessage(r.requests[0]!)).toContain("[recovery]");
    expect(firstMessage(r.requests[0]!)).toContain("tree has one uncommitted file");
    expect(work.openSteps(workId)).toEqual([]);

    const after = work.getWork(workId)!;
    expect(after.workId).toBe(before.workId);
    expect(after.root).toBe(before.root);
    expect(after.branch).toBe(before.branch);
    expect(after.caps).toEqual(before.caps);
    expect(after.sessionsUsed).toBe(2);
  });
});

describe("death immediately after resume", () => {
  test("a checkpoint is still open after the resumed run is killed, and the next start resumes it again", async () => {
    // an earlier session stopped cleanly and left a checkpoint for this work
    const channel = `work:${workId}`;
    const session = manager.openSession("finn", channel);
    manager.appendTurn(session.id, "user", "goal");
    manager.appendTurn(session.id, "assistant", 'Working.\n<LOOP reason="half done" />');
    const cp = sessions.saveRunCheckpoint({
      agent: "finn", sessionId: session.id, goal: "goal", goalHash: goalHash("goal"), stopReason: "max_reached",
      iteration: 2, maxIterations: 5, lastOutcome: "completed", remaining: "write the second test", createdAt: new Date().toISOString(), workId,
    });
    work.reserveSession(workId, { jobId: "j1", claimId: "c1" });

    await killedChild(); // resumes, begins a step, is killed inside the provider call
    expect(sessions.getRunCheckpoint(cp.id)!.status).toBe("open");
    expect(work.openSteps(workId).length).toBe(1);

    work.recoverOpenSessions();
    const r = recorder();
    const host = createLoopHost(work, workId, async () => "checked");
    work.reserveSession(workId, { jobId: "j1", claimId: "c2" });
    await runLoopMode(agent(), "goal", r.provider, manager, sessions, { maxIterations: 5, checkpoints: true, resume: true, host });

    const text = firstMessage(r.requests[0]!);
    expect(text).toContain("[resume]");
    expect(text).toContain("write the second test");
    expect(text).toContain("[recovery]");
  });
});

describe("recovery past 24 hours", () => {
  test("the work, tree and caps are kept and a fresh session starts after reconciliation", async () => {
    const channel = `work:${workId}`;
    const old = manager.openSession("finn", channel);
    const longAgo = Date.now() - 25 * 3_600_000;
    sessions.saveRunCheckpoint({
      agent: "finn", sessionId: old.id, goal: "goal", goalHash: goalHash("goal"), stopReason: "max_reached",
      iteration: 3, maxIterations: 5, lastOutcome: "completed", remaining: "open the PR", createdAt: new Date(longAgo).toISOString(), workId,
    });
    const before = work.getWork(workId)!;
    const r = recorder();
    const host = createLoopHost(work, workId, async (_steps, ctx) => { r.order.push(`reconcile:stale=${ctx.stale}`); return "master moved on by two commits"; });
    work.reserveSession(workId, { jobId: "j1", claimId: "c1" });
    await runLoopMode(agent(), "goal", r.provider, manager, sessions, { maxIterations: 5, checkpoints: true, resume: true, host });

    expect(r.order).toEqual(["reconcile:stale=true", "provider"]);
    expect(r.requests[0]!.sessionId).not.toBe(old.id);
    expect(firstMessage(r.requests[0]!)).toContain("master moved on by two commits");
    const after = work.getWork(workId)!;
    expect(after.root).toBe(before.root);
    expect(after.caps).toEqual(before.caps);
    expect(after.sessionsUsed).toBe(1);
  });
});
