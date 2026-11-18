/**
 * castle-work-loop, WL-2/WL-3/WL-9: the work handler inside the job consumer.
 * A fake Mesh port, a fake session executor, a scripted GitHub reader, a real work store.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshJobConsumer, type JobsPort, type GitHubReader } from "../../src/mesh-jobs/consumer";
import { LeaseLostError, type MeshClaim, type MeshJob, type MeshJobReport } from "../../src/mesh-jobs/client";
import { WorkStore } from "../../src/work/store";
import { createWorkHandler, type SessionExecutor, type SessionResult } from "../../src/work/consumer";
import { issueDigest12 } from "../../src/work/approval";
import { loadWorkConfig } from "../../src/work/config";
import { publishCommittedWork } from "../../src/work/publish-fallback";
import { createSessionExecutor } from "../../src/work/executor";
import { createStopRecorder } from "../../src/work/stops";
import { readTreeGit } from "../../src/work/workspace";

const BODY = "Intent body v1";
const DIGEST = issueDigest12(BODY);
const REF = `wabc1234ef0.${DIGEST}`;

let root: string;
let store: WorkStore;
let clock: number;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "work-cons-")));
  store = WorkStore.open(":memory:", { rootBase: root });
  clock = 1_000_000;
});
afterEach(() => store.close());

/** Another writer took the work while this session still ran: its generation is no longer current. */
function advanceGeneration(workId: string): void {
  (store as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db.run(
    "UPDATE works SET generation = generation + 1 WHERE work_id = ?", [workId],
  );
}

function workJob(over: Partial<MeshJob> = {}): MeshJob {
  return {
    id: "job-1", enqueuer: "owner@mesh", type: "start-work", target: { repo: "rfcclub/anima", kind: "issue", number: 7 },
    slots: 1, expiresAt: clock + 86_400_000, state: "queued", createdAt: clock, workRef: REF, ...over,
  } as MeshJob;
}

class FakeJobs implements JobsPort {
  queued: MeshJob[] = [];
  claimsMade: MeshClaim[] = [];
  released: string[] = [];
  reports: Array<{ claimId: string; report: MeshJobReport }> = [];
  heartbeats = 0;
  heartbeatError: Error | null = null;
  /** How long a heartbeat request takes to answer; the answer (or error) arrives after this. */
  heartbeatDelayMs = 0;
  /** Per-call answers, consumed in call order; once empty, `heartbeatDelayMs` / `heartbeatError` apply. */
  heartbeatScript: Array<{ delayMs: number; error?: Error }> = [];
  /** A gateway that never answers a heartbeat. */
  heartbeatHangs = false;
  private n = 0;
  async pending() { return this.queued.length; }
  async claim(): Promise<MeshClaim | null> {
    const job = this.queued.shift();
    if (!job) return null;
    const claim = { id: `claim-${++this.n}`, jobId: job.id, worker: "finn@anima", state: "active", leaseExpiresAt: clock + 300_000, evidenceRef: null } as MeshClaim;
    this.claimsMade.push(claim);
    this.jobsById.set(job.id, job);
    return claim;
  }
  jobsById = new Map<string, MeshJob>();
  async getJob(id: string) { return this.jobsById.get(id)!; }
  async heartbeat(claimId: string): Promise<MeshClaim> {
    this.heartbeats++;
    if (this.heartbeatHangs) await new Promise<never>(() => {});
    const step = this.heartbeatScript.shift();
    const delayMs = step ? step.delayMs : this.heartbeatDelayMs;
    const error = step ? step.error ?? null : this.heartbeatError;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (error) throw error;
    return { id: claimId } as MeshClaim;
  }
  async report(claimId: string, report: MeshJobReport) { this.reports.push({ claimId, report }); return { id: claimId } as MeshClaim; }
  async release(claimId: string) { this.released.push(claimId); const claim = this.claimsMade.find((c) => c.id === claimId)!; this.queued.push(this.jobsById.get(claim.jobId)!); return { id: claimId } as MeshClaim; }
}

const github: GitHubReader = {
  async pullRequest() { return { headSha: "a".repeat(40), state: "open", merged: false, title: "PR", body: "", author: "author" }; },
  async diff() { throw new Error("not used"); },
  async issue(_repo, n) { return { title: "t", body: n === 7 || n === 8 ? currentBody : `PR #${n} body` }; },
  async reviews() { return []; },
};
let currentBody = BODY;
beforeEach(() => { currentBody = BODY; });

class FakeExecutor implements SessionExecutor {
  inputs: Array<{ workId: string; sessionNo: number; maxIterations: number; deadlineMs: number; provider: string; model: string }> = [];
  results: SessionResult[] = [];
  readyResult: { ok: true } | { ok: false; reason: string } = { ok: true };
  hangUntilAbort = false;
  /** With hangUntilAbort: reject (as a production executor can on setup, provider, loop or stopAll errors) instead of returning. */
  rejectAfterAbort = false;
  /** How long a session runs before it returns. */
  sessionMs = 0;
  ready() { return this.readyResult; }
  async runSession(input: Parameters<SessionExecutor["runSession"]>[0]): Promise<SessionResult> {
    this.inputs.push({ workId: input.work.workId, sessionNo: input.session.no, maxIterations: input.maxIterations, deadlineMs: input.deadlineMs, provider: input.work.provider, model: input.work.model });
    if (this.hangUntilAbort) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
      if (this.rejectAfterAbort) throw new Error("executor failed after the abort");
      return this.results.shift() ?? { stopCause: "interrupted", iterations: 1, execMs: 1000, cessation: "proven" };
    }
    if (this.sessionMs) await new Promise((r) => setTimeout(r, this.sessionMs));
    return this.results.shift() ?? { stopCause: "max_reached", iterations: 5, execMs: 60_000, cessation: "proven" };
  }
}

function build(over: { executor?: FakeExecutor; jobs?: FakeJobs; evidence?: (workId: string) => Promise<{ ok: true; url: string } | { ok: false; reason: string }>; agent?: string; authors?: string[]; releaseBackoffMs?: number; findPublishedPr?: () => Promise<boolean>; publishFallback?: (input: { work: unknown; kind: "start-work" | "revise"; stopCause: string; limitTerminal?: boolean }) => Promise<{ published: boolean; reason?: string; host?: { sha: string; prOutput: string; checks: string[] }; hostPushed?: boolean; hostSha?: string }> } = {}) {
  const jobs = over.jobs ?? new FakeJobs();
  const executor = over.executor ?? new FakeExecutor();
  const logs: string[] = [];
  const handler = createWorkHandler({
    store, executor, github, heartbeatMs: 10, now: () => clock,
    ...(over.authors ? { authors: over.authors } : {}),
    collectEvidence: over.evidence ?? (async () => ({ ok: false, reason: "no pull request" })),
    findPublishedPr: over.findPublishedPr ?? (async () => false),
      heartbeatTimeoutMs: 30,
    ...(over.publishFallback ? { publishFallback: over.publishFallback as never } : {}),
    log: (_level, message) => { logs.push(message); },
  });
  const consumer = new MeshJobConsumer({
    workers: [{ agent: over.agent ?? "finn", jobs }], github, runTurn: async () => { throw new Error("review path not used"); },
    heartbeatMs: 10, turnTimeoutMs: 1000, now: () => clock, work: handler, releaseBackoffMs: over.releaseBackoffMs ?? 30_000,
    log: (_level, message) => { logs.push(message); },
  });
  return { jobs, executor, consumer, logs };
}

describe("a bounded session and release", () => {
  test("a start-work claim creates the work, runs session 1 with the caps, and a stop on the iteration cap releases the claim without a report", async () => {
    const { jobs, executor, consumer } = build();
    jobs.queued.push(workJob());
    await consumer.tick();

    const works = store.listWorks();
    expect(works.length).toBe(1);
    expect(works[0]!.workId).toBe("wabc1234ef0");
    expect(works[0]!.author).toBe("finn");
    expect(executor.inputs).toEqual([{ workId: "wabc1234ef0", sessionNo: 1, maxIterations: 5, deadlineMs: 600_000, provider: "agnes", model: "agnes-3.0-flash" }]);
    expect(jobs.released).toEqual(["claim-1"]);
    expect(jobs.reports).toEqual([]);
    expect(works[0]!.state).toBe("checkpointed");
    expect(works[0]!.sessionsUsed).toBe(1);
    expect(store.listSessions("wabc1234ef0")[0]!.iterations).toBe(5);
  });

  test("the released job is not claimed again until the backoff has passed, then the same work continues", async () => {
    const { jobs, executor, consumer } = build();
    jobs.queued.push(workJob());
    await consumer.tick();
    clock += 10_000; // inside the 30 s backoff
    await consumer.tick();
    expect(jobs.claimsMade.length).toBe(1);
    clock += 30_000;
    await consumer.tick();
    expect(jobs.claimsMade.length).toBe(2);
    expect(store.listWorks().length).toBe(1);
    expect(executor.inputs.map((i) => i.sessionNo)).toEqual([1, 2]);
    expect(executor.inputs.every((i) => i.workId === "wabc1234ef0")).toBe(true);
  });

  test("heartbeats go out while a session runs", async () => {
    const executor = new FakeExecutor();
    const orig = executor.runSession.bind(executor);
    executor.runSession = async (input) => { await new Promise((r) => setTimeout(r, 60)); return orig(input); };
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.heartbeats).toBeGreaterThanOrEqual(2);
  });
});

describe("who may run it", () => {
  test("blocked and accepted claims log their reason without executing a session", async () => {
    store.createWork({
      repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0", config: loadWorkConfig({}),
    });
    const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const executor = new FakeExecutor();
    const jobs = new FakeJobs();
    const handler = createWorkHandler({
      store, executor, github, heartbeatMs: 10,
      collectEvidence: async () => ({ ok: false, reason: "unused" }),
      log: (_level, message, fields = {}) => logs.push({ message, fields }),
    });
    const claim = { id: "claim-1", jobId: "job-1" } as MeshClaim;
    store.setState("wabc1234ef0", "blocked", "sessions exhausted");
    const blocked = await handler.run({ worker: "finn", claim, job: workJob(), jobs });
    store.setState("wabc1234ef0", "accepted");
    const accepted = await handler.run({ worker: "finn", claim, job: workJob(), jobs });
    expect(blocked).toEqual({ kind: "report", report: { outcome: "failed" } });
    expect(accepted).toEqual(blocked);
    expect(executor.inputs).toEqual([]);
    expect(logs).toEqual([
      { message: "work refused", fields: { workId: "wabc1234ef0", state: "blocked", reason: "sessions exhausted" } },
      { message: "work refused", fields: { workId: "wabc1234ef0", state: "accepted", reason: null } },
    ]);
  });

  test("a claim blocked by a changed approval also logs the blocked reason", async () => {
    store.createWork({
      repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0", config: loadWorkConfig({}),
    });
    currentBody = "different approved body";
    const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const executor = new FakeExecutor();
    const handler = createWorkHandler({
      store, executor, github, heartbeatMs: 10,
      collectEvidence: async () => ({ ok: false, reason: "unused" }),
      log: (_level, message, fields = {}) => logs.push({ message, fields }),
    });
    const result = await handler.run({
      worker: "finn", claim: { id: "claim-1", jobId: "job-1" } as MeshClaim, job: workJob(), jobs: new FakeJobs(),
    });
    expect(result).toEqual({ kind: "report", report: { outcome: "failed" } });
    expect(executor.inputs).toEqual([]);
    expect(logs).toContainEqual({
      message: "work refused", fields: { workId: "wabc1234ef0", state: "blocked", reason: "approval changed" },
    });
  });

  test("a worker that is not the pinned author does not run the work", async () => {
    const { jobs, executor, consumer } = build({ agent: "cleo" });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(executor.inputs.length).toBe(0);
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed"]);
  });

  test("a listed extra author may start a new work, and the work is pinned to it", async () => {
    const { jobs, executor, consumer } = build({ agent: "jade", authors: ["jade"] });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(executor.inputs.length).toBe(1);
    expect(store.listWorks().map((w) => w.author)).toEqual(["jade"]);
  });

  test("an agent that is neither the author nor a listed extra author is still refused", async () => {
    const { jobs, executor, consumer } = build({ agent: "kai", authors: ["jade"] });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(executor.inputs.length).toBe(0);
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed"]);
    expect(store.listWorks().length).toBe(0);
  });

  test("a work pinned to one author is handed back, not failed, when another listed author claims it", async () => {
    const first = build({ agent: "finn", authors: ["jade"] });
    first.jobs.queued.push(workJob());
    await first.consumer.tick();
    expect(store.listWorks().map((w) => w.author)).toEqual(["finn"]);
    const before = first.executor.inputs.length;

    const second = build({ agent: "jade", authors: ["jade"] });
    second.jobs.queued.push(workJob());
    await second.consumer.tick();
    expect(second.executor.inputs.length).toBe(0);
    expect(second.jobs.reports).toEqual([]);
    expect(second.jobs.released.length).toBe(1);
    expect(store.listWorks().map((w) => w.author)).toEqual(["finn"]);
    expect(first.executor.inputs.length).toBe(before);
  });

  test("a job without a readable work reference is not run", async () => {
    const { jobs, executor, consumer } = build();
    jobs.queued.push(workJob({ workRef: undefined }));
    await consumer.tick();
    expect(executor.inputs.length).toBe(0);
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed"]);
    expect(store.listWorks().length).toBe(0);
  });
});

describe("pinned model and isolation", () => {
  test("a model-reported blocker blocks the work without host publish fallback or a done report", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "blocked", blockedReason: "missing test fixture", iterations: 1, execMs: 500, cessation: "proven" });
    let fallbackCalls = 0;
    const { jobs, consumer } = build({
      executor,
      publishFallback: async () => { fallbackCalls++; return { published: true }; },
      evidence: async () => ({ ok: true, url: "https://example.test/pr/1" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("missing test fixture");
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed"]);
    expect(fallbackCalls).toBe(0);
  });

  test("an unavailable pinned model blocks the work and no other model is tried", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "model_unavailable", iterations: 0, execMs: 500, cessation: "proven" });
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("model");
    expect(executor.inputs.length).toBe(1);
    expect(executor.inputs[0]!.model).toBe("agnes-3.0-flash");
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed"]);
  });

  test("when the write boundary cannot be established no session starts and the work is blocked", async () => {
    const executor = new FakeExecutor();
    executor.readyResult = { ok: false, reason: "isolation unavailable: probe failed" };
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(executor.inputs.length).toBe(0);
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("isolation");
    expect(store.getWork("wabc1234ef0")!.sessionsUsed).toBe(0);
  });

  test("asynchronous isolation readiness is awaited before deciding or reserving a session", async () => {
    const executor = new FakeExecutor();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let resolveReady!: (r: { ok: false; reason: string }) => void;
    const pending = new Promise<{ ok: false; reason: string }>((resolve) => { resolveReady = resolve; });
    executor.ready = (() => { enter(); return pending; }) as unknown as typeof executor.ready;
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    const running = consumer.tick();
    await entered;
    try {
      expect(store.getWork("wabc1234ef0")!.state).not.toBe("blocked");
      expect(executor.inputs.length).toBe(0);
      expect(jobs.reports.length).toBe(0);
    } finally {
      resolveReady({ ok: false, reason: "isolation unavailable: async check" });
      await running;
    }
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("async check");
    expect(store.getWork("wabc1234ef0")!.sessionsUsed).toBe(0);
  });
});

describe("lease loss", () => {
  test("lease loss during a real workspace fetch records unproven cessation without charging unused iterations", async () => {
    const source = join(root, "source"), remote = join(root, "remote.git"), bin = join(root, "slow-git-bin");
    mkdirSync(source); mkdirSync(bin);
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
        { cwd, env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git(root, "init", "--bare", "-q", "-b", "main", remote);
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "fixture.txt"), "base");
    git(source, "add", "fixture.txt"); git(source, "commit", "-qm", "base");
    git(source, "remote", "add", "origin", remote); git(source, "push", "-q", "-u", "origin", "main");
    const realGit = Bun.which("git")!, marker = join(root, "fetch.pid");
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) echo $$ > "${marker}"; exec /bin/sleep 30;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    let authorStarted = false;
    const jobs = new FakeJobs();
    jobs.heartbeat = async () => {
      if (existsSync(marker)) throw new LeaseLostError(409, "lease-lost");
      return { id: "claim-1" } as MeshClaim;
    };
    const executor = createSessionExecutor({
      store, sessionStore: {} as never, sessionManager: {} as never,
      ready: () => ({ ok: true }), cloneSource: () => source, base: "main",
      createProvider: async () => { authorStarted = true; throw new Error("unexpected author"); },
      loadIdentity: async () => { throw new Error("unexpected author"); },
      issue: async () => ({ title: "unused", body: BODY }),
    });
    const handler = createWorkHandler({
      store, executor, github, heartbeatMs: 15, heartbeatTimeoutMs: 500,
      recordStop: createStopRecorder({ store, read: readTreeGit }),
      collectEvidence: async () => ({ ok: false, reason: "unused" }),
    });
    const job = workJob();
    const claim = { id: "claim-1", jobId: job.id, worker: "finn@anima", state: "active" } as MeshClaim;
    try {
      const outcome = await handler.run({ worker: "finn", claim, job, jobs });
      expect(outcome.kind).toBe("lease-lost");
      expect(existsSync(marker)).toBe(true);
      const pid = Number(readFileSync(marker, "utf8").trim());
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
      const work = store.getWork("wabc1234ef0")!;
      expect(work.state).toBe("blocked");
      expect(work.blockedReason).toContain("cessation-unproven");
      expect(work.iterationsUsed).toBe(0);
      expect(store.listSessions(work.workId)[0]!.stopCause).toBe("interrupted");
      expect(authorStarted).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  }, 15_000);

  test("a lost lease aborts the session; with proven cessation the work is checkpointed and nothing is reported", async () => {
    const executor = new FakeExecutor();
    executor.hangUntilAbort = true;
    const { jobs, consumer } = build({ executor });
    jobs.heartbeatError = new LeaseLostError(409, "lease-lost");
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(jobs.released).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).toBe("checkpointed");
    expect(store.listSessions("wabc1234ef0")[0]!.endedAt).not.toBeNull();
  });

  test("when the old session cannot be proven stopped the work is blocked and no new session starts", async () => {
    const executor = new FakeExecutor();
    executor.hangUntilAbort = true;
    executor.results.push({ stopCause: "interrupted", iterations: 1, execMs: 1000, cessation: "unproven" });
    const { jobs, consumer } = build({ executor });
    jobs.heartbeatError = new LeaseLostError(409, "lease-lost");
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("cessation");

    // the job comes back and is claimed again: still no writer
    jobs.heartbeatError = null;
    executor.hangUntilAbort = false;
    jobs.queued.push(workJob());
    clock += 60_000;
    await consumer.tick();
    expect(executor.inputs.length).toBe(1);
  });

  test("an unproven workspace timeout records timeout without claiming a lease interruption", async () => {
    const executor = new FakeExecutor();
    executor.results.push({
      stopCause: "workspace_timeout" as never, iterations: 0, execMs: 60_000,
      cessation: "unproven", cessationCheck: "workspace-preparation-timeout",
    });
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    const work = store.getWork("wabc1234ef0")!;
    expect(work.state).toBe("blocked");
    expect(work.blockedReason).toMatch(/workspace preparation timed out/i);
    expect(work.blockedReason).toMatch(/cessation-unproven/i);
    expect(store.listSessions(work.workId)[0]!.stopCause).toBe("workspace_timeout");
    expect(work.iterationsUsed).toBe(0);
  });
});

describe("caps and approval", () => {
  test("the final session blocks and a fourth session is refused", async () => {
    const { jobs, executor, consumer } = build();
    for (let i = 0; i < 4; i++) {
      jobs.queued.push(workJob());
      await consumer.tick();
      clock += 60_000;
    }
    expect(executor.inputs.length).toBe(3);
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("sessions");
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed", "failed"]);
  });

  test("if the issue changed after it was enqueued the work is blocked and nothing runs", async () => {
    const { jobs, executor, consumer } = build();
    currentBody = "Intent body v2";
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(executor.inputs.length).toBe(0);
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("approval");
  });

  test("a revise job checks the approved issue, not the PR number in its target", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "done", iterations: 1, execMs: 100, cessation: "proven" });
    const { jobs, consumer } = build({
      executor, evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    // The work already exists and is revising; its approved digest is the issue body, while the revise job
    // targets PR 12 (a different body).
    const created = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, config: loadWorkConfig({}), workId: "wabc1234ef0" }).work;
    store.setState(created.workId, "revising");
    store.recordPullRequest(created.workId, { number: 12, head: "a".repeat(40), url: "https://github.com/rfcclub/anima/pull/12" });
    jobs.queued.push(workJob({ type: "revise", target: { repo: "rfcclub/anima", kind: "pr", number: 12, headSha: "a".repeat(40) } }));
    await consumer.tick();
    expect(store.getWork(created.workId)!.state).toBe("in-review");
    expect(jobs.reports[0]!.report).toEqual({ outcome: "done", evidenceRef: "https://github.com/rfcclub/anima/pull/12" });
  });
});

describe("done", () => {
  test("a model that says done without a verified pull request is not reported done", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "done", iterations: 2, execMs: 30_000, cessation: "proven" });
    const { jobs, consumer } = build({ executor, evidence: async () => ({ ok: false, reason: "no pull request" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports.map((r) => r.report.outcome)).toEqual(["failed"]);
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("pull request");
  });

  test("verified pull request evidence is what the done report carries, and the work is in review", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "done", iterations: 2, execMs: 30_000, cessation: "proven" });
    const { jobs, consumer } = build({ executor, evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "done", evidenceRef: "https://github.com/rfcclub/anima/pull/12" } }]);
    expect(store.getWork("wabc1234ef0")!.state).toBe("in-review");
    // the job is remembered so the enqueuer can confirm it once the work is accepted
    const reported = store.listEvents("wabc1234ef0").filter((e) => e.kind === "job-reported");
    expect(reported.map((e) => e.detail)).toEqual([{ jobId: "job-1", type: "start-work" }]);
    expect(store.getWork("wabc1234ef0")!.startJobId).toBe("job-1");
  });
});

describe("final session exhaustion", () => {
  function limited(maxSessions: number) {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ author: "finn", caps: { maxSessions } }) });
  }

  test("final max_reached without a PR blocks without another reservation", async () => {
    limited(1);
    const { jobs, consumer } = build({ publishFallback: async () => ({ published: false }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("sessions exhausted");
    expect(jobs.released).toEqual([]);
  });

  test("final max_reached can publish and enter review", async () => {
    limited(1);
    const { jobs, consumer } = build({ publishFallback: async () => ({ published: true }),
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(jobs.reports[0]?.report.outcome).toBe("done");
  });

  test("SC-020 a host publish is recorded with the pull request URL, the stop cause and the checks that ran", async () => {
    limited(1);
    const { jobs, consumer } = build({
      publishFallback: async () => ({ published: true, host: { sha: "c".repeat(40), prOutput: "{}", checks: ["no-change", "tests"] } }),
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();

    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(store.listEvents("wabc1234ef0").filter((event) => event.kind === "published-by-host").map((event) => event.detail)).toEqual([
      { url: "https://github.com/rfcclub/anima/pull/12", stopCause: "max_reached", checks: ["no-change", "tests"] },
    ]);
  });

  test("SC-028 failing to record the host event does not stop the evidence flow", async () => {
    limited(1);
    const original = store.appendEvent.bind(store);
    store.appendEvent = ((workId: string, kind: string, detail: unknown) => {
      if (kind === "published-by-host") throw new Error("disk full");
      return original(workId, kind as never, detail as never);
    }) as typeof store.appendEvent;
    const { jobs, consumer } = build({
      publishFallback: async () => ({ published: true, host: { sha: "c".repeat(40), prOutput: "{}", checks: ["tests"] } }),
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();

    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(jobs.reports[0]?.report.outcome).toBe("done");
  });

  test("SC-027 a pushed branch without a pull request is recorded with its commit and blocks with the visible reason", async () => {
    limited(1);
    const { jobs, consumer } = build({
      publishFallback: async () => ({ published: false, reason: "pr-create-failed (branch pushed)", hostPushed: true, hostSha: "d".repeat(40) }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();

    expect(store.getWork("wabc1234ef0")?.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("publish fallback declined: pr-create-failed (branch pushed)");
    expect(store.listEvents("wabc1234ef0").filter((event) => event.kind === "host-push-without-pr").map((event) => event.detail))
      .toEqual([{ branch: store.getWork("wabc1234ef0")!.branch, commit: "d".repeat(40), reason: "pr-create-failed (branch pushed)" }]);
  });

  test("the pushed-without-PR event is not written when the pull request turns out to exist (the response was lost)", async () => {
    limited(1);
    const { jobs, consumer } = build({
      publishFallback: async () => ({ published: false, reason: "pr-create-failed (branch pushed)", hostPushed: true, hostSha: "d".repeat(40) }),
      findPublishedPr: async () => true,
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();

    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(store.listEvents("wabc1234ef0").some((event) => event.kind === "host-push-without-pr")).toBe(false);
  });

  test("the pushed-without-PR event is not written when the pull request lookup fails (unknown is not absent)", async () => {
    limited(1);
    const { jobs, consumer } = build({
      publishFallback: async () => ({ published: false, reason: "pr-create-failed (branch pushed)", hostPushed: true, hostSha: "d".repeat(40) }),
      findPublishedPr: async () => { throw new Error("github down"); },
    });
    jobs.queued.push(workJob());
    await consumer.tick();

    expect(store.listEvents("wabc1234ef0").some((event) => event.kind === "host-push-without-pr")).toBe(false);
  });

  test("the pushed-without-PR event is not written by a writer whose generation moved during the publish", async () => {
    limited(1);
    const { jobs, consumer } = build({
      publishFallback: async () => {
        advanceGeneration("wabc1234ef0");
        return { published: false, reason: "pr-create-failed (branch pushed)", hostPushed: true, hostSha: "d".repeat(40) };
      },
    });
    jobs.queued.push(workJob());
    await consumer.tick();

    expect(store.listEvents("wabc1234ef0").some((event) => event.kind === "host-push-without-pr")).toBe(false);
  });

  test("a pre-existing PR is collected as evidence rather than mistaken for no publication", async () => {
    limited(1);
    const { jobs, consumer } = build({ publishFallback: async () => ({ published: false, reason: "pull request already exists" }),
      findPublishedPr: async () => true,
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(jobs.reports[0]?.report.outcome).toBe("done");
  });

  test("an unavailable PR lookup does not claim no PR exists", async () => {
    limited(1);
    const { jobs, consumer } = build({ publishFallback: async () => ({ published: false }),
      findPublishedPr: async () => { throw new Error("GitHub unavailable"); } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.state).toBe("checkpointed");
    expect(jobs.released).toEqual(["claim-1"]);
  });

  test("a failed fallback still checks for a PR before blocking exhausted work", async () => {
    limited(1);
    const { jobs, consumer } = build({
      publishFallback: async () => { throw new Error("publish unavailable"); },
      findPublishedPr: async () => false,
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("sessions exhausted");
  });

  test("the final session is checked even without a publish fallback", async () => {
    limited(1);
    const { jobs, consumer } = build({ findPublishedPr: async () => false });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("sessions exhausted");
  });

  test("a lease lost while looking up the PR cannot block exhausted work", async () => {
    limited(1);
    const jobs = new FakeJobs();
    let checked = false;
    const { consumer } = build({ jobs, publishFallback: async () => ({ published: false }),
      findPublishedPr: async () => {
        checked = true;
        jobs.heartbeatError = new LeaseLostError(409, "lost");
        await new Promise((resolve) => setTimeout(resolve, 40));
        return false;
      } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(checked).toBe(true);
    expect(store.getWork("wabc1234ef0")?.state).not.toBe("blocked");
    expect(jobs.reports).toEqual([]);
  });

  test("a remaining session is released", async () => {
    limited(2);
    const { jobs, consumer } = build({ publishFallback: async () => ({ published: false }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.state).toBe("checkpointed");
    expect(jobs.released).toEqual(["claim-1"]);
  });

  test("unproven cessation keeps its own blocking reason", async () => {
    limited(1);
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "max_reached", iterations: 1, execMs: 1, cessation: "unproven" });
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("cessation-unproven");
  });

  test("a lost lease cannot block or report session exhaustion", async () => {
    limited(1);
    const executor = new FakeExecutor();
    executor.sessionMs = 40;
    const jobs = new FakeJobs();
    jobs.heartbeatError = new LeaseLostError(409, "lost");
    const { consumer } = build({ executor, jobs });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.state).not.toBe("blocked");
    expect(jobs.reports).toEqual([]);
  });
});

describe("host publish fallback", () => {
  test("SC-001 deadline at the work wall-time cap runs the fallback as limit-terminal", async () => {
    const created = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { workWallMs: 500, sessionWallMs: 500 } }) }).work;
    expect(created.execMsUsed).toBe(0);
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "deadline", iterations: 1, execMs: 500, cessation: "proven" });
    const fallbackInputs: Array<{ limitTerminal?: boolean }> = [];
    const { jobs, consumer } = build({ executor, publishFallback: async (input) => {
      fallbackInputs.push(input);
      return { published: false };
    } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(fallbackInputs).toHaveLength(1);
    expect(fallbackInputs[0]?.limitTerminal).toBe(true);
  });

  test("SC-002 deadline with wall time and sessions left does not run the fallback", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "deadline", iterations: 1, execMs: 100, cessation: "proven" });
    let fallbackCalls = 0;
    const { jobs, consumer } = build({ executor, publishFallback: async () => {
      fallbackCalls++;
      return { published: false };
    } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(fallbackCalls).toBe(0);
    expect(store.getWork("wabc1234ef0")?.state).toBe("checkpointed");
    expect(jobs.released).toEqual(["claim-1"]);
  });

  test("SC-003 deadline at the session-count cap runs the fallback as limit-terminal", async () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }) });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "deadline", iterations: 1, execMs: 100, cessation: "proven" });
    const fallbackInputs: Array<{ limitTerminal?: boolean }> = [];
    const { jobs, consumer } = build({ executor, publishFallback: async (input) => {
      fallbackInputs.push(input);
      return { published: false };
    } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(fallbackInputs).toHaveLength(1);
    expect(fallbackInputs[0]?.limitTerminal).toBe(true);
  });

  test("SC-004 non-publish stop causes do not run the fallback", async () => {
    const causes = ["provider_error", "blocked", "question", "worker_error", "quota", "interrupted", "unverified"] as const;
    let fallbackCalls = 0;
    for (let i = 0; i < causes.length; i++) {
      const workId = `w${String(i).padStart(10, "0")}`;
      const executor = new FakeExecutor();
      executor.results.push({ stopCause: causes[i]!, iterations: 1, execMs: 100, cessation: "proven" });
      const { jobs, consumer } = build({ executor, publishFallback: async () => {
        fallbackCalls++;
        return { published: false };
      } });
      jobs.queued.push(workJob({
        target: { repo: `rfcclub/test-${i}`, kind: "issue", number: 7 },
        workRef: `${workId}.${DIGEST}`,
      }));
      await consumer.tick();
    }
    expect(fallbackCalls).toBe(0);
  });

  test("SC-005 a revise session ending in deadline does not run the fallback", async () => {
    const created = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { workWallMs: 500, sessionWallMs: 500 } }) }).work;
    store.setState(created.workId, "revising");
    store.recordPullRequest(created.workId, { number: 12, head: "a".repeat(40), url: "https://github.com/rfcclub/anima/pull/12" });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "deadline", iterations: 1, execMs: 500, cessation: "proven" });
    let fallbackCalls = 0;
    const { jobs, consumer } = build({ executor, publishFallback: async () => {
      fallbackCalls++;
      return { published: false };
    } });
    jobs.queued.push(workJob({ type: "revise", target: { repo: "rfcclub/anima", kind: "pr", number: 12, headSha: "a".repeat(40) } }));
    await consumer.tick();
    expect(fallbackCalls).toBe(0);
  });

  test("SC-026 max_reached sets limitTerminal only when a cap is exhausted", async () => {
    const inputs: Array<{ limitTerminal?: boolean }> = [];
    const { jobs, consumer } = build({ publishFallback: async (input) => {
      inputs.push(input);
      return { published: false };
    } });
    jobs.queued.push(workJob());
    await consumer.tick();

    const finalWorkId = "w0000000001";
    store.createWork({ repo: "rfcclub/anima", issue: 8, approvedDigest: DIGEST, workId: finalWorkId,
      config: loadWorkConfig({ caps: { maxSessions: 1 } }) });
    const finalJobs = new FakeJobs();
    const finalExecutor = new FakeExecutor();
    const finalHandler = createWorkHandler({
      store, executor: finalExecutor, github, heartbeatMs: 10, now: () => clock,
      collectEvidence: async () => ({ ok: false, reason: "no pull request" }),
      publishFallback: async (input) => { inputs.push(input); return { published: false }; },
    });
    const finalConsumer = new MeshJobConsumer({
      workers: [{ agent: "finn", jobs: finalJobs }], github, runTurn: async () => { throw new Error("review path not used"); },
      heartbeatMs: 10, turnTimeoutMs: 1000, now: () => clock, work: finalHandler, releaseBackoffMs: 30_000,
    });
    finalJobs.queued.push(workJob({ workRef: `${finalWorkId}.${DIGEST}` }));
    await finalConsumer.tick();
    expect(store.getWork(finalWorkId)).toMatchObject({ sessionsUsed: 1, caps: { maxSessions: 1 } });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.limitTerminal).toBeFalsy();
    expect(inputs[1]?.limitTerminal).toBe(true);
  });

  test("SC-021 a limit-terminal fallback decline blocks with its reason and records the event", async () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { workWallMs: 500, sessionWallMs: 500 } }) });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "deadline", iterations: 1, execMs: 500, cessation: "proven" });
    const { jobs, consumer } = build({ executor, publishFallback: async () => ({ published: false, reason: "working tree is not clean" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")).toMatchObject({
      state: "blocked", blockedReason: "execution time limit reached; publish fallback declined: working tree is not clean",
    });
    expect(store.listEvents("wabc1234ef0").filter((event) => event.kind === "limit-terminal-declined").map((event) => event.detail))
      .toEqual([{ limit: "execution time limit reached", reason: "working tree is not clean" }]);
  });

  test("SC-024 a decline is work-scoped across generation 1 and 2 and operator recovery resets it", async () => {
    const createCheckpointedAfterFirstReservation = (workId: string, repo: string) => {
      store.createWork({ repo, issue: 7, approvedDigest: DIGEST, workId,
        config: loadWorkConfig({ caps: { maxSessions: 2, workWallMs: 100, sessionWallMs: 100 } }) });
      const first = store.reserveSession(workId, { jobId: "job-0", claimId: "claim-0" });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(first.reason);
      store.closeSession(first.session.sessionId, { iterations: 1, execMs: 100, stopCause: "deadline" });
      store.appendEvent(workId, "limit-terminal-declined", { limit: "execution time limit reached", reason: "no reason given" });
      (store as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db.run(
        "UPDATE works SET exec_ms_used = 0, caps_json = json_set(caps_json, '$.workWallMs', 200) WHERE work_id = ?", [workId],
      );
    };

    createCheckpointedAfterFirstReservation("wabc1234ef0", "rfcclub/anima");
    const executor = new FakeExecutor();
    let calls = 0;
    const { jobs, consumer } = build({ executor, publishFallback: async () => { calls++; return { published: false }; } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.listSessions("wabc1234ef0").map((session) => session.generation)).toEqual([1, 2]);
    expect(calls).toBe(0);

    const recoveredId = "w0000000002";
    createCheckpointedAfterFirstReservation(recoveredId, "rfcclub/other");
    store.appendEvent(recoveredId, "operator-recovery", {});
    const recoveredJobs = new FakeJobs();
    const recoveredHandler = createWorkHandler({ store, executor: new FakeExecutor(), github, heartbeatMs: 10, now: () => clock,
      collectEvidence: async () => ({ ok: false, reason: "no pull request" }),
      publishFallback: async () => { calls++; return { published: false }; } });
    const recoveredConsumer = new MeshJobConsumer({ workers: [{ agent: "finn", jobs: recoveredJobs }], github,
      runTurn: async () => { throw new Error("review path not used"); }, heartbeatMs: 10, turnTimeoutMs: 1000,
      now: () => clock, work: recoveredHandler, releaseBackoffMs: 30_000 });
    recoveredJobs.queued.push(workJob({ workRef: `${recoveredId}.${DIGEST}` }));
    await recoveredConsumer.tick();
    expect(store.listSessions(recoveredId).map((session) => session.generation)).toEqual([1, 2]);
    expect(calls).toBe(1);
  });

  test("SC-035 a PR lookup prevents blocking on a decline and sends the work to evidence", async () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }) });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "max_reached", iterations: 1, execMs: 100, cessation: "proven" });
    let lookups = 0;
    let evidenceCalls = 0;
    const { jobs, consumer } = build({ executor, findPublishedPr: async () => { lookups++; return true; },
      publishFallback: async () => ({ published: false, reason: "working tree is not clean" }),
      evidence: async () => { evidenceCalls++; return { ok: true, url: "https://github.com/rfcclub/anima/pull/12" }; } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(lookups).toBe(1);
    expect(evidenceCalls).toBe(1);
    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(jobs.reports[0]?.report).toEqual({ outcome: "done", evidenceRef: "https://github.com/rfcclub/anima/pull/12" });
  });

  test("SC-036 a failed PR lookup does not block or record a decline", async () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }) });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "max_reached", iterations: 1, execMs: 100, cessation: "proven" });
    let lookups = 0;
    const { jobs, consumer } = build({ executor, findPublishedPr: async () => { lookups++; throw new Error("lookup unavailable"); },
      publishFallback: async () => ({ published: false, reason: "working tree is not clean" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(lookups).toBeGreaterThan(0);
    expect(store.getWork("wabc1234ef0")?.state).toBe("checkpointed");
    expect(store.listEvents("wabc1234ef0").some((event) => event.kind === "limit-terminal-declined")).toBe(false);
  });

  test("SC-037 no published PR blocks and records the limit-terminal decline", async () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }) });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "max_reached", iterations: 1, execMs: 100, cessation: "proven" });
    const { jobs, consumer } = build({ executor, findPublishedPr: async () => false,
      publishFallback: async () => ({ published: false, reason: "working tree is not clean" }) });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")?.blockedReason).toContain("publish fallback declined: working tree is not clean");
    expect(store.listEvents("wabc1234ef0").some((event) => event.kind === "limit-terminal-declined")).toBe(true);
  });

  test("SC-025 an existing-PR decline is collected as evidence without blocking", async () => {
    store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ caps: { maxSessions: 1 } }) });
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "max_reached", iterations: 1, execMs: 100, cessation: "proven" });
    let evidenceCalls = 0;
    const { jobs, consumer } = build({ executor,
      publishFallback: async () => ({ published: false, reason: "pull request already exists" }),
      evidence: async () => { evidenceCalls++; return { ok: true, url: "https://github.com/rfcclub/anima/pull/12" }; } });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(evidenceCalls).toBe(1);
    expect(store.getWork("wabc1234ef0")?.state).toBe("in-review");
    expect(jobs.reports[0]?.report.outcome).toBe("done");
  });

  test("a max_reached session whose work is committed is published and reaches review", async () => {
    const executor = new FakeExecutor(); // default: max_reached
    const { jobs, consumer } = build({
      executor,
      publishFallback: async () => ({ published: true }),
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(store.getWork("wabc1234ef0")!.state).toBe("in-review");
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "done", evidenceRef: "https://github.com/rfcclub/anima/pull/12" } }]);
  });

  test("when the fallback publishes nothing the claim is released as before", async () => {
    const executor = new FakeExecutor();
    const { jobs, consumer } = build({
      executor,
      publishFallback: async () => ({ published: false, reason: "working tree is not clean" }),
      evidence: async () => ({ ok: false, reason: "no pull request" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.released).toEqual(["claim-1"]);
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).toBe("checkpointed");
  });

  test("the lease heartbeat keeps running while the fallback publishes", async () => {
    const executor = new FakeExecutor();
    const { jobs, consumer } = build({
      executor,
      publishFallback: async () => { await new Promise((r) => setTimeout(r, 60)); return { published: true }; },
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.heartbeats).toBeGreaterThanOrEqual(2);
  });

  test("the fallback gets a guard that fails once the work generation moves on", async () => {
    const executor = new FakeExecutor();
    let guard: (() => void) | undefined;
    const { jobs, consumer } = build({
      executor,
      publishFallback: (async (input: { guard?: () => void }) => { guard = input.guard; return { published: false }; }) as never,
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(guard).toBeDefined();
    expect(() => guard!()).not.toThrow();
    // a later session reserves the work: the generation moves on, so the earlier writer is stale
    expect(store.reserveSession("wabc1234ef0", { jobId: "job-2", claimId: "claim-2" }).ok).toBe(true);
    expect(() => guard!()).toThrow(/stale writer/);
  });

  test("a lease lost while the evidence is collected neither moves the work to review nor reports done", async () => {
    const executor = new FakeExecutor();
    const jobsRef = new FakeJobs();
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: async () => ({ published: true }),
      evidence: async () => {
        jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
        await new Promise((r) => setTimeout(r, 40)); // the heartbeat (10ms) notices while the GitHub call is in flight
        return { ok: true, url: "https://github.com/rfcclub/anima/pull/12" };
      },
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a lease lost while the evidence is collected does not block the work on a late failed evidence either", async () => {
    const executor = new FakeExecutor();
    const jobsRef = new FakeJobs();
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: async () => ({ published: true }),
      evidence: async () => {
        jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
        await new Promise((r) => setTimeout(r, 40));
        return { ok: false, reason: "no pull request" };
      },
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("blocked");
  });

  test("the collector gets a guard that settles the heartbeat and then checks lease and generation", async () => {
    const executor = new FakeExecutor();
    let publishGuard: (() => void) | undefined;
    let evidenceGuard: (() => void) | undefined;
    const { jobs, consumer } = build({
      executor,
      publishFallback: (async (input: { guard?: () => void }) => { publishGuard = input.guard; return { published: true }; }) as never,
      evidence: (async (_id: string, options: { guard?: () => void }) => { evidenceGuard = options.guard; return { ok: true, url: "u" }; }) as never,
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(publishGuard).toBeDefined();
    expect(evidenceGuard).toBeDefined();
    await expect(Promise.resolve(evidenceGuard!())).resolves.toBeUndefined();
    advanceGeneration("wabc1234ef0");
    await expect(Promise.resolve().then(() => evidenceGuard!())).rejects.toThrow(/stale writer/);
  });

  test("a heartbeat still in flight when the fallback publishes nothing cannot let a lost lease report done", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "done", iterations: 1, execMs: 1000, cessation: "proven" } as never);
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatDelayMs = 40;
    jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: async () => { await new Promise((r) => setTimeout(r, 25)); return { published: false, reason: "skipped" }; },
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a generation that moved on during the fallback keeps the old done path from reporting", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "done", iterations: 1, execMs: 1000, cessation: "proven" } as never);
    const { jobs, consumer } = build({
      executor,
      publishFallback: async () => {
        // what a stale-generation publish error becomes: the fallback reports nothing published
        advanceGeneration("wabc1234ef0");
        return { published: false, reason: "push failed: stale writer" };
      },
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    // a writer that lost the work reports failed (as when no session can be reserved), never done
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "failed" } }]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("without a fallback, a generation that moved on while the evidence was collected does not report done", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stopCause: "done", iterations: 1, execMs: 1000, cessation: "proven" } as never);
    const { jobs, consumer } = build({
      executor,
      evidence: async () => {
        advanceGeneration("wabc1234ef0");
        return { ok: true, url: "https://github.com/rfcclub/anima/pull/12" };
      },
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    // a writer that lost the work reports failed (as when no session can be reserved), never done
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "failed" } }]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a delayed lost lease that is still in flight when the fallback has published cannot report done", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 15; // the first heartbeat (10ms) is still unanswered when the session ends
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatDelayMs = 40;
    jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: async () => ({ published: true }),
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a delayed lost lease still in flight does not block the work on failed evidence either", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 15;
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatDelayMs = 40;
    jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: async () => ({ published: true }),
      evidence: async () => ({ ok: false, reason: "no pull request" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("blocked");
  });

  test("overlapping heartbeats cannot hide an older lost lease behind a newer success", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 35;
    const jobsRef = new FakeJobs();
    // the first request is slow and says 409; the ones issued after it would answer ok sooner
    jobsRef.heartbeatScript = [{ delayMs: 80, error: new LeaseLostError(409, "lease-lost") }, { delayMs: 2 }, { delayMs: 2 }, { delayMs: 2 }];
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: async () => ({ published: true }),
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("without a fallback, a lost lease still in flight when the session ends cannot report done", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 15;
    executor.results.push({ stopCause: "done", iterations: 1, execMs: 1000, cessation: "proven" } as never);
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatDelayMs = 40;
    jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a heartbeat issued during the fallback's PR lookup and answered 409 late stops the push and the PR", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 5;
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatDelayMs = 40;
    jobsRef.heartbeatError = new LeaseLostError(409, "lease-lost");
    const writes: string[] = [];
    const HEAD = "a".repeat(40);
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: ((input: Parameters<typeof publishCommittedWork>[1]) => publishCommittedWork({
        publish: async (_w, args) => { writes.push(String(args.action)); return JSON.stringify(args.action === "open_pr" ? { status: "ok", url: "u" } : { status: "ok" }); },
        findPullRequest: async () => { await new Promise((r) => setTimeout(r, 25)); return null; },
        issue: async () => ({ title: "Intent", body: "B" }),
        base: "master",
        git: (_cwd, args) => args[0] === "status" ? "" : args[0] === "symbolic-ref" ? `refs/heads/${input.work.branch}\n` : args[0] === "rev-list" ? "2\n" : `${HEAD}\n`,
      }, input)) as never,
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(writes).toEqual([]);
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a heartbeat the gateway never answers cannot hang the handler or let it report done", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 15; // the first heartbeat (10ms) is issued and never answered
    executor.results.push({ stopCause: "done", iterations: 1, execMs: 1000, cessation: "proven" } as never);
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatHangs = true;
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    const outcome = await Promise.race([consumer.tick().then(() => "returned"), new Promise((r) => setTimeout(() => r("hung"), 800))]);
    expect(outcome).toBe("returned");
    expect(jobs.reports).toEqual([]);
    expect(store.getWork("wabc1234ef0")!.state).not.toBe("in-review");
  });

  test("a heartbeat that never answers during the fallback also returns without writing or reporting", async () => {
    const executor = new FakeExecutor();
    executor.sessionMs = 15;
    const jobsRef = new FakeJobs();
    jobsRef.heartbeatHangs = true;
    const writes: string[] = [];
    const { jobs, consumer } = build({
      executor, jobs: jobsRef,
      publishFallback: (async (input: { settledGuard?: () => Promise<void> }) => {
        await input.settledGuard!(); // what the fallback awaits before its first write
        writes.push("push");
        return { published: true };
      }) as never,
      evidence: async () => ({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" }),
    });
    jobs.queued.push(workJob());
    const outcome = await Promise.race([consumer.tick().then(() => "returned"), new Promise((r) => setTimeout(() => r("hung"), 800))]);
    expect(outcome).toBe("returned");
    expect(writes).toEqual([]);
    expect(jobs.reports).toEqual([]);
  });

  test.each([
    ["an unanswered heartbeat", (j: FakeJobs) => { j.heartbeatHangs = true; }],
    ["a 409 heartbeat", (j: FakeJobs) => { j.heartbeatError = new LeaseLostError(409, "lease-lost"); }],
  ])("%s followed by an executor that rejects keeps the work blocked locally but reports nothing", async (_name, arrange) => {
    const executor = new FakeExecutor();
    executor.hangUntilAbort = true;
    executor.rejectAfterAbort = true;
    const jobsRef = new FakeJobs();
    arrange(jobsRef);
    const { jobs, consumer } = build({ executor, jobs: jobsRef });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([]); // the claim is no longer ours: no failed report
    const w = store.getWork("wabc1234ef0")!;
    expect(w.state).toBe("blocked"); // cessation is unknown, so no new session may start
    expect(w.blockedReason).toContain("session executor failed");
  });

  test("an executor that rejects without a lease problem still reports failed", async () => {
    const executor = new FakeExecutor();
    executor.runSession = async () => { throw new Error("provider exploded"); };
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "failed" } }]);
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
  });

  test("a retained preparation marker blocks the work with its recovery reason", async () => {
    const executor = new FakeExecutor();
    executor.runSession = async () => {
      throw new Error("workspace preparation is unproven or incomplete; recovery required");
    };
    const { jobs, consumer } = build({ executor });
    jobs.queued.push(workJob());
    await consumer.tick();
    const work = store.getWork("wabc1234ef0")!;
    expect(work.state).toBe("blocked");
    expect(work.blockedReason).toContain("workspace preparation is unproven or incomplete; recovery required");
    expect(store.listSessions(work.workId)[0]!.stopCause).toBe("executor-error");
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "failed" } }]);
  });

  test("a fallback that cannot produce verified evidence blocks instead of claiming done", async () => {
    const executor = new FakeExecutor();
    const { jobs, consumer } = build({
      executor,
      publishFallback: async () => ({ published: true }),
      evidence: async () => ({ ok: false, reason: "no pull request" }),
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.reports).toEqual([{ claimId: "claim-1", report: { outcome: "failed" } }]);
    expect(store.getWork("wabc1234ef0")!.state).toBe("blocked");
    expect(store.getWork("wabc1234ef0")!.blockedReason).toContain("fallback");
  });
});

describe("work not enabled", () => {
  test("a consumer without a work handler hands a start-work claim back and does not report it failed", async () => {
    const jobs = new FakeJobs();
    const consumer = new MeshJobConsumer({
      workers: [{ agent: "finn", jobs }], github, runTurn: async () => { throw new Error("not used"); },
      heartbeatMs: 10, turnTimeoutMs: 1000, now: () => clock, releaseBackoffMs: 30_000,
    });
    jobs.queued.push(workJob());
    await consumer.tick();
    expect(jobs.released).toEqual(["claim-1"]);
    expect(jobs.reports).toEqual([]);
    expect(store.listWorks().length).toBe(0);
  });
});

describe("host-observed deadline recovery", () => {
  async function runDeadline(options: { cessation?: "proven" | "unproven"; leaseLost?: boolean; leaseBeforeDeadline?: boolean; stale?: boolean; cause?: SessionResult["stopCause"]; source?: "abort" | "sigint" | "unknown" } = {}) {
    const work = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: DIGEST, workId: "wabc1234ef0",
      config: loadWorkConfig({ author: "finn", caps: { maxSessions: 2, sessionWallMs: 30, workWallMs: 10_000 } }) }).work;
    const jobs = new FakeJobs();
    if (options.leaseLost) jobs.heartbeatScript = [{ delayMs: 50, error: new LeaseLostError(409, "lease-lost") }];
    if (options.leaseBeforeDeadline) jobs.heartbeatError = new LeaseLostError(409, "lease-lost");
    const executor = new FakeExecutor();
    executor.hangUntilAbort = true;
    executor.results.push({ stopCause: options.cause ?? "interrupted", iterations: 1, execMs: 30, cessation: options.cessation ?? "proven", interruptionSource: options.source ?? "abort" } as SessionResult);
    const original = executor.runSession.bind(executor);
    executor.runSession = async (input) => { const result = await original(input); if (options.stale) advanceGeneration(work.workId); return result; };
    const handler = createWorkHandler({ store, executor, github, heartbeatMs: 5, heartbeatTimeoutMs: 100,
      recordStop: createStopRecorder({ store, read: (_tree, args) => args[0] === "rev-parse" ? "a".repeat(40) : "" }),
      collectEvidence: async () => ({ ok: false, reason: "unused" }) });
    const job = workJob();
    const outcome = await handler.run({ worker: "finn", claim: { id: "claim-1", jobId: job.id } as MeshClaim, job, jobs });
    const session = store.listSessions(work.workId)[0]!;
    return { work, session, stop: store.getStop(session.sessionId)!, outcome };
  }

  test("a proven host deadline records deadline and permits existing blocked-work recovery", async () => {
    const { work, session, stop } = await runDeadline();
    expect(session.stopCause).toBe("deadline");
    expect(stop).toMatchObject({ stopCause: "deadline", cessation: "proven", trusted: true });
    store.setState(work.workId, "blocked", "operator review");
    const recovered = store.recoverBlockedWork({ workId: work.workId, root: work.root, base: "a".repeat(40), caps: {}, check: () => ({ ok: true }) });
    expect(recovered.state).toBe("checkpointed");
  });

  test("unproven cessation remains interrupted and cannot be recovered", async () => {
    const { work, session, stop } = await runDeadline({ cessation: "unproven" });
    expect(session.stopCause).toBe("interrupted");
    expect(stop.trusted).toBe(false);
    expect(() => store.recoverBlockedWork({ workId: work.workId, root: work.root, base: "a".repeat(40), caps: {}, check: () => ({ ok: true }) })).toThrow();
  });

  test("heartbeat lease loss settling after deadline does not yield a trusted deadline", async () => {
    const { session, stop, outcome } = await runDeadline({ leaseLost: true });
    expect(session.stopCause).toBe("interrupted");
    expect(stop.trusted).toBe(false);
    expect(outcome.kind).toBe("lease-lost");
  });

  test("lease loss before deadline stays interrupted", async () => {
    const { session, stop, outcome } = await runDeadline({ leaseBeforeDeadline: true });
    expect(session.stopCause).toBe("interrupted");
    expect(stop.trusted).toBe(false);
    expect(outcome.kind).toBe("lease-lost");
  });

  test("a stale generation does not yield a trusted deadline", async () => {
    const { session, stop } = await runDeadline({ stale: true });
    expect(session.stopCause).toBe("interrupted");
    expect(stop.trusted).toBe(false);
  });

  test("a different executor outcome is not rewritten as deadline", async () => {
    const { session } = await runDeadline({ cause: "max_reached" });
    expect(session.stopCause).toBe("max_reached");
  });

  test.each(["sigint", "unknown"] as const)("an independent or unknown %s interruption stays interrupted even if the timer fired", async (source) => {
    const { session } = await runDeadline({ source });
    expect(session.stopCause).toBe("interrupted");
  });
});
