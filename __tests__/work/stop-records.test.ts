/**
 * cartridge-worker-dispatch: stop records for every session end, trusted checkpoints
 * only under AC-9's conditions, interrupted records after a host crash, and the continuation gate (AC-8 to AC-10).
 * A real work store; git reads are a scripted function (the sandboxed tree-git is covered by its own tests).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshJobConsumer, type JobsPort, type GitHubReader } from "../../src/mesh-jobs/consumer";
import { LeaseLostError, type MeshClaim, type MeshJob, type MeshJobReport } from "../../src/mesh-jobs/client";
import { WorkStore } from "../../src/work/store";
import { createWorkHandler, type SessionExecutor, type SessionResult } from "../../src/work/consumer";
import { issueDigest12 } from "../../src/work/approval";
import { loadWorkConfig } from "../../src/work/config";
import { checkContinuation, createStopRecorder, recordInterruptedStops, type TreeRead } from "../../src/work/stops";

const BODY = "Intent body v1";
const DIGEST = issueDigest12(BODY);
const REF = `wabc1234ef0.${DIGEST}`;
const WORK = "wabc1234ef0";
const HEAD = "a".repeat(40);

let root: string;
let dbPath: string;
let store: WorkStore;
let clock: number;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "work-stops-")));
  dbPath = join(root, "work.db");
  store = WorkStore.open(dbPath, { rootBase: root });
  clock = 1_000_000;
});
afterEach(() => store.close());

function workJob(): MeshJob {
  return {
    id: "job-1", enqueuer: "owner@mesh", type: "start-work", target: { repo: "rfcclub/anima", kind: "issue", number: 7 },
    slots: 1, expiresAt: clock + 86_400_000, state: "queued", createdAt: clock, workRef: REF,
  } as MeshJob;
}

class FakeJobs implements JobsPort {
  queued: MeshJob[] = [];
  heartbeatError: Error | null = null;
  private n = 0;
  private claims = new Map<string, MeshJob>();
  async pending() { return this.queued.length; }
  async claim(): Promise<MeshClaim | null> {
    const job = this.queued.shift();
    if (!job) return null;
    const claim = { id: `claim-${++this.n}`, jobId: job.id, worker: "finn@anima", state: "active", leaseExpiresAt: clock + 300_000, evidenceRef: null } as MeshClaim;
    this.claims.set(job.id, job);
    return claim;
  }
  async getJob(id: string) { return this.claims.get(id)!; }
  async heartbeat(claimId: string): Promise<MeshClaim> {
    if (this.heartbeatError) throw this.heartbeatError;
    return { id: claimId } as MeshClaim;
  }
  reports: MeshJobReport[] = [];
  async report(claimId: string, report: MeshJobReport) { this.reports.push(report); return { id: claimId } as MeshClaim; }
  async release(claimId: string) { return { id: claimId } as MeshClaim; }
}

const github: GitHubReader = {
  async pullRequest() { throw new Error("not used"); },
  async diff() { throw new Error("not used"); },
  async issue() { return { title: "t", body: BODY }; },
  async reviews() { return []; },
};

class ScriptedExecutor implements SessionExecutor {
  readonly adapterKind = "loop";
  next: SessionResult | "throw" | "hang" = { stopCause: "max_reached", iterations: 5, execMs: 60_000, cessation: "proven" };
  ready() { return { ok: true as const }; }
  async runSession(input: Parameters<SessionExecutor["runSession"]>[0]): Promise<SessionResult> {
    const next = this.next;
    if (next === "throw") throw new Error("the adapter crashed");
    if (next === "hang") {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
      return { stopCause: "interrupted", iterations: 1, execMs: 1000, cessation: "proven" };
    }
    return next;
  }
}

/** A tree read that answers HEAD and status, or fails. */
function tree(head = HEAD, status = "", fail = false): TreeRead {
  return (_tree, args) => {
    if (fail) throw new Error("git failed");
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "status") return status;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

async function runOnce(
  executor: ScriptedExecutor, jobs = new FakeJobs(), read: TreeRead = tree(),
  over: { recordStop?: (input: never) => unknown; evidence?: () => Promise<{ ok: true; url: string } | { ok: false; reason: string }> } = {},
) {
  const handler = createWorkHandler({
    store, executor, github, heartbeatMs: 10, heartbeatTimeoutMs: 30, now: () => clock,
    config: loadWorkConfig({ caps: { maxSessions: 10, workWallMs: 120 * 60_000 } }),
    collectEvidence: over.evidence ?? (async () => ({ ok: false, reason: "no pull request" })),
    recordStop: over.recordStop ?? createStopRecorder({ store, read }),
  });
  const consumer = new MeshJobConsumer({
    workers: [{ agent: "finn", jobs }], github, runTurn: async () => { throw new Error("review path not used"); },
    heartbeatMs: 10, turnTimeoutMs: 1000, now: () => clock, work: handler, releaseBackoffMs: 30_000, log: () => {},
  });
  jobs.queued.push(workJob());
  await consumer.tick();
  clock += 60_000;
}

describe("stop records (cartridge-worker-dispatch S5)", () => {
  test("stop-record-every-outcome: each session end through the handler writes one record with adapter, cause and cessation", async () => {
    const executor = new ScriptedExecutor();
    const outcomes: Array<SessionResult> = [
      { stopCause: "done", iterations: 2, execMs: 1000, cessation: "proven" },
      { stopCause: "max_reached", iterations: 5, execMs: 1000, cessation: "proven" },
      { stopCause: "deadline", iterations: 3, execMs: 1000, cessation: "proven" },
    ];
    for (const result of outcomes) {
      executor.next = result;
      await runOnce(executor);
      if (store.getWork(WORK)!.state === "blocked") store.setState(WORK, "checkpointed");
    }
    executor.next = "throw";
    await runOnce(executor);
    store.setState(WORK, "checkpointed");

    executor.next = "hang";
    const lost = new FakeJobs();
    lost.heartbeatError = new LeaseLostError(409, "lease-lost");
    await runOnce(executor, lost);

    const sessions = store.listSessions(WORK);
    expect(sessions.length).toBe(5);
    const found = sessions.map((s: { sessionId: string }) => store.getStop(s.sessionId));
    expect(found.filter((s) => s === null).length).toBe(0);
    const stops = found.map((s) => s!);
    expect(stops.map((s) => [s.adapter, s.stopCause, s.cessation])).toEqual([
      ["loop", "done", "proven"],
      ["loop", "max_reached", "proven"],
      ["loop", "deadline", "proven"],
      ["loop", "executor-error", "unproven"],
      ["loop", "interrupted", "proven"],
    ]);
    expect(stops[3]!.cessationCheck).toBe("executor-error");
    expect(stops.map((s) => s.trusted)).toEqual([true, true, true, false, false]);
    expect(stops[4]!.head).toBe("untrusted");
    expect(stops.every((s) => !s.interrupted && s.evidence === "unavailable")).toBe(true);
  });

  test("stop-record-failure-blocks: a stop record that cannot be written blocks the work even after a done session", async () => {
    const executor = new ScriptedExecutor();
    executor.next = { stopCause: "done", iterations: 2, execMs: 1000, cessation: "proven" };
    const jobs = new FakeJobs();
    await runOnce(executor, jobs, tree(), {
      recordStop: () => { throw new Error("disk full"); },
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/1" }),
    });
    expect(store.getWork(WORK)!.state).toBe("blocked");
    expect(store.getWork(WORK)!.blockedReason).toContain("stop record");
    expect(jobs.reports.filter((r) => r.outcome === "done")).toEqual([]);
  });

  test("trusted-checkpoint-conditions: trusted only with proven cessation, lease, generation and readable tree", () => {
    const config = loadWorkConfig({ caps: { maxSessions: 10, workWallMs: 120 * 60_000 } });
    const work = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, config, workId: WORK }).work;
    const session = () => {
      const r = store.reserveSession(WORK, { jobId: "j", claimId: `c${clock++}` });
      if (!r.ok) throw new Error(r.reason);
      store.closeSession(r.session.sessionId, { iterations: 1, execMs: 1, stopCause: "done" });
      return store.getSession(r.session.sessionId)!;
    };
    const record = (read: TreeRead, over: Partial<Parameters<ReturnType<typeof createStopRecorder>>[0]>) =>
      createStopRecorder({ store, read })({
        work, session: session(), adapter: "loop", stopCause: "done", cessation: "proven", leaseHeld: true, generationCurrent: true, ...over,
      });

    const good = record(tree(HEAD, " M a.ts\n"), {});
    expect([good.trusted, good.head, good.status]).toEqual([true, HEAD, " M a.ts\n"]);
    const lease = record(tree(), { leaseHeld: false });
    expect([lease.trusted, lease.head, lease.status]).toEqual([false, "untrusted", "untrusted"]);
    const unproven = record(tree(), { cessation: "unproven", cessationCheck: "survivor" });
    expect([unproven.trusted, unproven.head, unproven.cessationCheck]).toEqual([false, "untrusted", "survivor"]);
    const stale = record(tree(), { generationCurrent: false });
    expect([stale.trusted, stale.head]).toEqual([false, "untrusted"]);
    const unreadable = record(tree(HEAD, "", true), {});
    expect([unreadable.trusted, unreadable.head, unreadable.status]).toEqual([false, "unavailable", "unavailable"]);
  });

  test("interrupted-after-crash: a recovered session gets one interrupted record; an external-adapter session blocks its work", () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, config: loadWorkConfig({}), workId: WORK });
    const r = store.reserveSession(WORK, { jobId: "j", claimId: "c1" });
    if (!r.ok) throw new Error(r.reason);
    store.setSessionAdapter(r.session.sessionId, "low");
    store.close();

    store = WorkStore.open(dbPath, { rootBase: root });
    store.recoverOpenSessions();
    const written = recordInterruptedStops(store);
    expect(written.map((s) => s.sessionId)).toEqual([r.session.sessionId]);
    const stop = store.getStop(r.session.sessionId)!;
    expect([stop.interrupted, stop.adapter, stop.stopCause, stop.cessation, stop.head, stop.status, stop.evidence, stop.trusted])
      .toEqual([true, "low", "unknown", "unproven", "unknown", "unknown", "unknown", false]);
    expect(store.getWork(WORK)!.state).toBe("blocked");
    expect(store.getWork(WORK)!.blockedReason).toContain("interrupted");
    expect(recordInterruptedStops(store)).toEqual([]);
  });

  test("continuation-gate: refused without a trusted checkpoint or with a moved tree; allowed for a fresh work or a matching tree", () => {
    const work = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, config: loadWorkConfig({}), workId: WORK }).work;
    expect(checkContinuation(store, work, tree())).toEqual({ ok: true });

    const close = () => {
      const r = store.reserveSession(WORK, { jobId: "j", claimId: `c${clock++}` });
      if (!r.ok) throw new Error(r.reason);
      store.closeSession(r.session.sessionId, { iterations: 1, execMs: 1, stopCause: "max_reached" });
      return store.getSession(r.session.sessionId)!;
    };
    const recorder = createStopRecorder({ store, read: tree(HEAD) });
    recorder({ work, session: close(), adapter: "low", stopCause: "max_reached", cessation: "proven", leaseHeld: true, generationCurrent: true });
    expect(checkContinuation(store, work, tree(HEAD))).toEqual({ ok: true });

    const moved = checkContinuation(store, work, tree("b".repeat(40)));
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.reason).toContain("does not match");
    const missing = checkContinuation(store, work, tree(HEAD, "", true));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("cannot be read");

    // A session that ended without a stop record (a crash between closing it and writing the record) is the latest.
    close();
    const unrecorded = checkContinuation(store, work, tree(HEAD));
    expect(unrecorded.ok).toBe(false);
    if (!unrecorded.ok) expect(unrecorded.reason).toContain("no stop record");

    recorder({ work, session: close(), adapter: "low", stopCause: "interrupted", cessation: "proven", leaseHeld: false, generationCurrent: true });
    const untrusted = checkContinuation(store, work, tree(HEAD));
    expect(untrusted.ok).toBe(false);
    if (!untrusted.ok) expect(untrusted.reason).toContain("no trusted checkpoint");
  });
});

describe("stop records in the assembled runtime (cartridge-worker-dispatch S5)", () => {
  test("runtime-stop-wiring: with a tree read, building the runtime records interrupted sessions after crash recovery", async () => {
    const { buildWorkRuntime } = await import("../../src/work/runtime");
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, config: loadWorkConfig({}), workId: WORK });
    const r = store.reserveSession(WORK, { jobId: "j", claimId: "c1" });
    if (!r.ok) throw new Error(r.reason);
    store.setSessionAdapter(r.session.sessionId, "low");
    const config = {
      author: "finn", authorActor: "finn-gotako[bot]", authorMeshId: "finn-anima-1@mac", enqueuer: "bruno", base: "master",
      reviewers: [], releaseBackoffMs: 30_000, reconcileIntervalMs: 60_000, perToolCallMs: 120_000, cloneUrl: "https://github.com/{repo}.git",
    };
    buildWorkRuntime(config as never, {
      store,
      executor: { ready: () => ({ ok: true as const }), runSession: async () => { throw new Error("not used"); } },
      github, workGithub: { findPullRequest: async () => null, pullRequest: async () => { throw new Error("x"); }, reviews: async () => [] },
      enqueuer: { enqueue: async () => ({ id: "j" }), confirm: async () => {} },
      heartbeatMs: 1000, log: () => {}, treeRead: tree(),
    } as never);
    expect(store.getStop(r.session.sessionId)?.interrupted).toBe(true);
    expect(store.getWork(WORK)!.state).toBe("blocked");
  });
});

describe("stop records (cartridge-worker-dispatch)", () => {
  const create = () => store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, config: loadWorkConfig({ caps: { maxSessions: 10, workWallMs: 120 * 60_000 } }), workId: WORK }).work;

  test("recovery-closed-without-record: a session closed but never recorded (crash in between) gets an interrupted record and blocks", () => {
    create();
    const r = store.reserveSession(WORK, { jobId: "j", claimId: "c1" }, "low");
    if (!r.ok) throw new Error(r.reason);
    store.closeSession(r.session.sessionId, { iterations: 1, execMs: 1, stopCause: "done" });
    store.close();
    store = WorkStore.open(dbPath, { rootBase: root });
    store.recoverOpenSessions();
    expect(recordInterruptedStops(store).map((s) => s.sessionId)).toEqual([r.session.sessionId]);
    expect(store.getStop(r.session.sessionId)?.interrupted).toBe(true);
    expect(store.getWork(WORK)!.state).toBe("blocked");
  });

  test("interrupted-block-atomic: when the block cannot be written, the interrupted record is not kept either", () => {
    create();
    const r = store.reserveSession(WORK, { jobId: "j", claimId: "c1" }, "low");
    if (!r.ok) throw new Error(r.reason);
    store.recoverOpenSessions();
    const original = store.setState.bind(store);
    store.setState = () => { throw new Error("disk full"); };
    expect(() => recordInterruptedStops(store)).toThrow();
    store.setState = original;
    expect(store.getStop(r.session.sessionId)).toBeNull();
    expect(recordInterruptedStops(store).length).toBe(1);
    expect(store.getWork(WORK)!.state).toBe("blocked");
  });

  test("executor-adapter-kind: the real executor factory exposes the adapter it builds with", async () => {
    const { createSessionExecutor } = await import("../../src/work/executor");
    const adapter = { kind: "low", run: async () => ({ stopCause: "done" as const, iterations: 0, cessation: "proven" as const }) };
    expect(createSessionExecutor({ adapter } as never).adapterKind).toBe("low");
    expect(createSessionExecutor({} as never).adapterKind).toBe("loop");
  });

  test("executor-error-record-failure-reason: a failed stop record stays visible in the block reason", async () => {
    const executor = new ScriptedExecutor();
    executor.next = "throw";
    await runOnce(executor, new FakeJobs(), tree(), { recordStop: () => { throw new Error("disk full"); } });
    const reason = store.getWork(WORK)!.blockedReason ?? "";
    expect(reason).toContain("session executor failed");
    expect(reason).toContain("stop record could not be written");
  });

  test("continuation-status-match: an uncommitted change after the checkpoint refuses continuation", () => {
    const work = create();
    const r = store.reserveSession(WORK, { jobId: "j", claimId: "c1" }, "low");
    if (!r.ok) throw new Error(r.reason);
    store.closeSession(r.session.sessionId, { iterations: 1, execMs: 1, stopCause: "max_reached" });
    createStopRecorder({ store, read: tree(HEAD, "") })({
      work, session: store.getSession(r.session.sessionId)!, adapter: "low", stopCause: "max_reached", cessation: "proven", leaseHeld: true, generationCurrent: true,
    });
    expect(checkContinuation(store, work, tree(HEAD, ""))).toEqual({ ok: true });
    const changed = checkContinuation(store, work, tree(HEAD, " M src/a.ts\n"));
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.reason).toContain("does not match");
  });
});
