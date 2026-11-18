/**
 * castle-work-loop: a revise session that says it is done without pushing a new
 * commit must not be accepted as a revision. The real work handler with the real reconciler; a scripted GitHub,
 * a Mesh idempotent by key and a scripted executor.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { createWorkHandler, type SessionExecutor, type SessionResult } from "../../src/work/consumer";
import { Reconciler, type MeshEnqueuer, type ReconcilerConfig } from "../../src/work/reconciler";
import { issueDigest12 } from "../../src/work/approval";
import type { PullRequestInfo, ReviewInfo, WorkGitHub } from "../../src/work/evidence";
import type { GitHubReader, JobsPort } from "../../src/mesh-jobs/consumer";
import type { MeshClaim, MeshJob } from "../../src/mesh-jobs/client";

const BODY = "Intent body v1";
const DIGEST = issueDigest12(BODY);
const WORK_ID = "wabc1234ef0";
const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);

const config: ReconcilerConfig = {
  base: "master", authorActor: "finn-gotako[bot]", authorMeshIds: ["finn@anima"],
  reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }], retryBackoffMs: 60_000,
};

let root: string;
let store: WorkStore;
let github: Gh;

class Gh implements WorkGitHub {
  current: PullRequestInfo = {
    repo: "rfcclub/anima", number: 12, url: "https://github.com/rfcclub/anima/pull/12", state: "open", merged: false,
    headSha: HEAD1, headRef: `work/7-${WORK_ID}`, baseRef: "master", body: "Closes #7", authorLogin: "finn-gotako[bot]",
  };
  reviewList: ReviewInfo[] = [];
  async findPullRequest() { return this.current; }
  async pullRequest() { return this.current; }
  async reviews() { return this.reviewList; }
}

class Mesh implements MeshEnqueuer {
  byKey = new Map<string, { id: string; input: Record<string, any> }>();
  async enqueue(input: Record<string, any>) {
    let job = this.byKey.get(input.idempotencyKey);
    if (!job) { job = { id: `job-${this.byKey.size + 1}`, input }; this.byKey.set(input.idempotencyKey, job); }
    return { id: job.id };
  }
  async confirm() {}
  jobs(type: string) { return [...this.byKey.values()].filter((j) => j.input.type === type); }
}

const issues: GitHubReader = {
  async pullRequest() { return { headSha: github.current.headSha, state: github.current.state, merged: github.current.merged, title: "PR", body: "", author: "author" }; },
  async diff() { throw new Error("not used"); },
  async issue() { return { title: "t", body: BODY }; },
  async reviews() { return []; },
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "work-rev-")));
  store = WorkStore.open(":memory:", { rootBase: root });
  github = new Gh();
});
afterEach(() => store.close());

class Executor implements SessionExecutor {
  constructor(private readonly results: SessionResult[], private readonly duringRun: () => void = () => {}) {}
  ready() { return { ok: true } as const; }
  async runSession() { this.duringRun(); return this.results.shift()!; }
}

const DONE: SessionResult = { stopCause: "done", iterations: 2, execMs: 1000, cessation: "proven" };

function claimAndJob(type: "start-work" | "revise", n: number) {
  const claim = { id: `claim-${n}`, jobId: `job-x${n}`, worker: "finn", state: "active", leaseExpiresAt: 9e12, evidenceRef: null } as MeshClaim;
  const job = {
    id: claim.jobId, enqueuer: "owner@mesh", type, target: {
      repo: "rfcclub/anima", kind: type === "revise" ? "pr" : "issue", number: type === "revise" ? 12 : 7,
      ...(type === "revise" ? { headSha: HEAD1 } : {}),
    },
    slots: 1, expiresAt: 9e12, state: "queued", createdAt: 0, workRef: `${WORK_ID}.${DIGEST}`,
  } as MeshJob;
  const jobs = { heartbeat: async () => claim, getJob: async () => job } as unknown as JobsPort;
  return { claim, job, jobs };
}

test("a revise session that says done without a new commit is not accepted, and the work does not sit in review forever", async () => {
  const mesh = new Mesh();
  const reconciler = new Reconciler({ store, github, mesh, config, now: () => 1_000_000 });
  const handler = (results: SessionResult[], duringRun?: () => void) => createWorkHandler({
    store, executor: new Executor(results, duringRun), github: issues, heartbeatMs: 10, now: () => 1_000_000,
    collectEvidence: (workId, options) => reconciler.collectEvidence(workId, options),
  });

  // session 1 publishes the pull request
  const first = claimAndJob("start-work", 1);
  const outcome1 = await handler([DONE]).run({ worker: "finn", ...first });
  expect(outcome1).toMatchObject({ kind: "report", report: { outcome: "done" } });
  expect(store.getWork(WORK_ID)!.state).toBe("in-review");

  // a reviewer asks for changes on that head; the reconciler queues the author-only revise job
  github.reviewList = [{ id: 1, state: "CHANGES_REQUESTED", commitId: HEAD1, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "https://github.com/rfcclub/anima/pull/12#pullrequestreview-1", submittedAt: "2026-10-22T13:00:00Z" }];
  await reconciler.tick();
  expect(mesh.jobs("revise").length).toBe(1);
  expect(store.getWork(WORK_ID)!.state).toBe("revising");

  // the revise session says done but the pull request head is still the reviewed one
  const second = claimAndJob("revise", 2);
  const outcome2 = await handler([DONE]).run({ worker: "finn", ...second });
  expect(outcome2).toMatchObject({ kind: "report", report: { outcome: "failed" } });
  const work = store.getWork(WORK_ID)!;
  expect(work.state).toBe("blocked");
  expect(work.blockedReason).toMatch(/no new commit/);
});

test("a revise session that did push a new commit goes back to review on the new head", async () => {
  const mesh = new Mesh();
  const reconciler = new Reconciler({ store, github, mesh, config, now: () => 1_000_000 });
  const handler = (results: SessionResult[], duringRun?: () => void) => createWorkHandler({
    store, executor: new Executor(results, duringRun), github: issues, heartbeatMs: 10, now: () => 1_000_000,
    collectEvidence: (workId, options) => reconciler.collectEvidence(workId, options),
  });
  await handler([DONE]).run({ worker: "finn", ...claimAndJob("start-work", 1) });
  github.reviewList = [{ id: 1, state: "CHANGES_REQUESTED", commitId: HEAD1, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "https://github.com/rfcclub/anima/pull/12#pullrequestreview-1", submittedAt: "2026-10-22T13:00:00Z" }];
  await reconciler.tick();
  const outcome = await handler([DONE], () => { github.current = { ...github.current, headSha: HEAD2 }; })
    .run({ worker: "finn", ...claimAndJob("revise", 2) });
  expect(outcome).toMatchObject({ kind: "report", report: { outcome: "done" } });
  expect(store.getWork(WORK_ID)!.state).toBe("in-review");
  expect(store.getWork(WORK_ID)!.prHead).toBe(HEAD2);
});
