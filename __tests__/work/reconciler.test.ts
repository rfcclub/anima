/**
 * castle-work-loop, WL-4: pull request evidence, the outbox, one review cycle per head and
 * one revise cycle per head. A scripted GitHub and a Mesh that is idempotent by key, like the real gateway.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { Reconciler, type MeshEnqueuer, type ReconcilerConfig } from "../../src/work/reconciler";
import type { CheckInfo, PullRequestInfo, ReviewInfo, WorkGitHub } from "../../src/work/evidence";
import type { MeshJobDetails } from "../../src/mesh-jobs/client";

const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);
let store: WorkStore;
let clock: number;
let workId: string;

const config: ReconcilerConfig = {
  base: "master",
  authorActor: "finn-gotako[bot]",
  authorMeshIds: ["finn@anima"],
  reviewers: [
    { agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" },
    { agent: "pia", meshId: "pia@anima", login: "pia-gotako[bot]" },
  ],
  retryBackoffMs: 60_000,
};

beforeEach(() => {
  store = WorkStore.open(":memory:", { rootBase: "/w" });
  clock = 1_000_000;
  workId = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work.workId;
  store.setState(workId, "running");
});
afterEach(() => store.close());

function pr(over: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    repo: "rfcclub/anima", number: 12, url: "https://github.com/rfcclub/anima/pull/12", state: "open", merged: false,
    headSha: HEAD1, headRef: `work/7-${workId}`, baseRef: "master", body: "Closes #7", authorLogin: "finn-gotako[bot]",
    mergeable: true, ...over,
  };
}
function review(over: Partial<ReviewInfo> = {}): ReviewInfo {
  return { id: 1, state: "CHANGES_REQUESTED", commitId: HEAD1, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "https://github.com/rfcclub/anima/pull/12#pullrequestreview-1", submittedAt: "2026-10-22T13:00:00Z", ...over };
}

class FakeGitHub implements WorkGitHub {
  prByBranch: PullRequestInfo | null = null;
  current: PullRequestInfo = pr();
  reviewList: ReviewInfo[] = [];
  checksList: CheckInfo[] = [];
  threads = 0;
  mergeCalls: Array<{ repo: string; number: number; head: string }> = [];
  mergeAttempts = 0;
  mergeError: Error | null = null;
  async findPullRequest() { return this.prByBranch; }
  async pullRequest() { return this.current; }
  async reviews() { return this.reviewList; }
  async checks() { return this.checksList; }
  async unresolvedThreads() { return this.threads; }
  async merge(repo: string, number: number, head: string) {
    this.mergeAttempts += 1;
    if (this.mergeError) throw this.mergeError;
    this.mergeCalls.push({ repo, number, head });
  }
}

class FakeMesh implements MeshEnqueuer {
  byKey = new Map<string, { id: string; input: Record<string, any> }>();
  failNext: "before" | "after" | null = null;
  failNewAfter = false;
  readError: Error | null = null;
  onGetJob: (() => void) | null = null;
  jobOverrides = new Map<string, Partial<MeshJobDetails>>();
  readJobIds: string[] = [];
  confirmed: string[] = [];
  confirmFails = false;
  async enqueue(input: Record<string, any>) {
    if (this.failNext === "before") { this.failNext = null; throw new Error("gateway down"); }
    let job = this.byKey.get(input.idempotencyKey);
    if (!job) {
      job = { id: `job-${this.byKey.size + 1}`, input };
      this.byKey.set(input.idempotencyKey, job);
      if (this.failNewAfter) { this.failNewAfter = false; throw new Error("new job response lost"); }
    }
    if (this.failNext === "after") { this.failNext = null; throw new Error("response lost"); }
    return { id: job.id };
  }
  async getJob(id: string): Promise<MeshJobDetails> {
    this.readJobIds.push(id);
    this.onGetJob?.();
    if (this.readError) throw this.readError;
    const job = [...this.byKey.values()].find((item) => item.id === id);
    if (!job) throw new Error("job not found");
    return {
      id, enqueuer: "enqueuer", type: job.input.type, target: job.input.target,
      slots: job.input.slots, eligible: job.input.eligible, excluded: job.input.excluded,
      state: "queued", expiresAt: job.input.expiresAt, createdAt: clock, claims: [],
      ...this.jobOverrides.get(id),
    };
  }
  async confirm(jobId: string) { if (this.confirmFails) throw new Error("gateway down"); this.confirmed.push(jobId); }
  jobs(type: string) { return [...this.byKey.values()].filter((j) => j.input.type === type); }
}

function make() {
  const github = new FakeGitHub();
  const mesh = new FakeMesh();
  const make = () => new Reconciler({ store, github, mesh, config, now: () => clock });
  return { github, mesh, reconciler: make(), restart: make };
}

describe("pull request evidence", () => {
  test.each([
    ["another repository", { repo: "rfcclub/other" }],
    ["the wrong base branch", { baseRef: "release" }],
    ["another head branch", { headRef: "other-branch" }],
    ["no link to the approved issue", { body: "no link here" }],
    ["a link to another issue", { body: "Closes #8" }],
    ["another author", { authorLogin: "someone-else" }],
    ["a pull request that is not open", { state: "closed" as const }],
  ])("a pull request with %s is not evidence", async (_name, over) => {
    const { github, reconciler, mesh } = make();
    github.prByBranch = pr(over);
    const r = await reconciler.collectEvidence(workId);
    expect(r.ok).toBe(false);
    expect(store.getWork(workId)!.prNumber).toBeNull();
    expect(store.listOutbox(workId)).toEqual([]);
    expect(mesh.byKey.size).toBe(0);
  });

  test("a guard that throws after the GitHub lookup records nothing and queues no review", async () => {
    const { github, reconciler, mesh } = make();
    github.prByBranch = pr();
    const guard = () => { throw new Error("stale writer"); };
    await expect(reconciler.collectEvidence(workId, { guard })).rejects.toThrow("stale writer");
    expect(store.getWork(workId)!.prNumber).toBeNull();
    expect(store.listOutbox(workId)).toEqual([]);
    expect(mesh.byKey.size).toBe(0);
  });

  test("a guard is checked after the lookup, not before it", async () => {
    const { github, reconciler } = make();
    github.prByBranch = pr();
    let lost = false;
    github.findPullRequest = async () => { lost = true; return github.prByBranch; };
    const guard = () => { if (lost) throw new Error("lost during lookup"); };
    await expect(reconciler.collectEvidence(workId, { guard })).rejects.toThrow("lost during lookup");
    expect(store.getWork(workId)!.prNumber).toBeNull();
  });

  test("no pull request from the work branch is not evidence", async () => {
    const { reconciler } = make();
    const r = await reconciler.collectEvidence(workId);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("no pull request") });
  });

  test("a matching pull request is recorded with its head and queues exactly one review operation", async () => {
    const { github, reconciler } = make();
    github.prByBranch = pr();
    const r = await reconciler.collectEvidence(workId);
    expect(r).toEqual({ ok: true, url: "https://github.com/rfcclub/anima/pull/12" });
    const w = store.getWork(workId)!;
    expect([w.prNumber, w.prHead]).toEqual([12, HEAD1]);
    expect(store.listOutbox(workId).map((o) => [o.purpose, o.status])).toEqual([["review", "pending"]]);
    await reconciler.collectEvidence(workId); // again: nothing new
    expect(store.listOutbox(workId).length).toBe(1);
  });

  test("the review job goes to the independent reviewers only and excludes the author", async () => {
    const { github, reconciler, mesh } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    await reconciler.tick();
    const job = mesh.jobs("review")[0]!.input;
    expect(job.eligible.sort()).toEqual(["cleo@anima", "pia@anima"]);
    expect(job.excluded).toEqual(["finn@anima"]);
    expect(job.target).toEqual({ repo: "rfcclub/anima", kind: "pr", number: 12, headSha: HEAD1 });
  });
});

describe("crashes around the review enqueue", () => {
  test("a restart after the pull request was recorded and before anything was enqueued yields one review job", async () => {
    const { github, mesh, reconciler, restart } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    // the process dies here; a new one starts twice
    await restart().tick();
    await restart().tick();
    expect(mesh.jobs("review").length).toBe(1);
    expect(store.listOutbox(workId)[0]!.status).toBe("done");
  });

  test("a lost response after the gateway took the job does not make a second job", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    mesh.failNext = "after";
    await reconciler.tick();
    expect(store.listOutbox(workId)[0]!.status).toBe("pending");
    clock += 61_000; // past the retry time
    await reconciler.tick();
    expect(mesh.jobs("review").length).toBe(1);
    expect(store.listOutbox(workId)[0]!.status).toBe("done");
  });

  test("a gateway that is down is retried later, not hammered", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    mesh.failNext = "before";
    await reconciler.tick();
    await reconciler.tick(); // inside the backoff: not tried again
    expect(mesh.byKey.size).toBe(0);
    clock += 61_000;
    await reconciler.tick();
    expect(mesh.jobs("review").length).toBe(1);
  });
});

describe("revise cycle", () => {
  async function inReview() {
    const ctx = make();
    ctx.github.prByBranch = pr();
    await ctx.reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await ctx.reconciler.tick();
    return ctx;
  }

  test("a changes-requested review on the current head yields one author-only revise job, however often it is seen", async () => {
    const { github, mesh, reconciler } = await inReview();
    github.reviewList = [review()];
    for (let i = 0; i < 3; i++) await reconciler.tick();
    const revise = mesh.jobs("revise");
    expect(revise.length).toBe(1);
    expect(revise[0]!.input.eligible).toEqual(["finn@anima"]);
    expect(revise[0]!.input.workRef).toBe(`${workId}.d1d1d1d1d1d1`);
    expect(revise[0]!.input.target).toEqual({ repo: "rfcclub/anima", kind: "pr", number: 12, headSha: HEAD1 });
    expect(store.getWork(workId)!.state).toBe("revising");
  });

  test("a review of a head that is no longer current changes nothing", async () => {
    const { github, mesh, reconciler } = await inReview();
    github.reviewList = [review({ commitId: "c".repeat(40) })];
    await reconciler.tick();
    expect(mesh.jobs("revise").length).toBe(0);
    expect(store.getWork(workId)!.state).toBe("in-review");
  });

  test("the author's own changes-requested review and a stranger's are not independent", async () => {
    const { github, mesh, reconciler } = await inReview();
    github.reviewList = [review({ id: 2, authorLogin: "finn-gotako[bot]" }), review({ id: 3, authorLogin: "random-user", authorType: "User" })];
    await reconciler.tick();
    expect(mesh.jobs("revise").length).toBe(0);
  });

  test("a later approval by the same reviewer on the same head clears an earlier changes-requested", async () => {
    const { github, mesh, reconciler } = await inReview();
    github.reviewList = [review({ id: 1 }), review({ id: 2, state: "APPROVED", submittedAt: "2026-10-22T14:00:00Z" })];
    await reconciler.tick();
    expect(mesh.jobs("revise").length).toBe(0);
  });

  test("after the author pushes a new head the work returns to review and the new head gets its own review job", async () => {
    const { github, mesh, reconciler } = await inReview();
    github.reviewList = [review()];
    await reconciler.tick();
    expect(store.getWork(workId)!.state).toBe("revising");
    github.current = pr({ headSha: HEAD2 });
    github.reviewList = [review()]; // the old review is now stale history
    await reconciler.tick();
    expect(store.getWork(workId)!.prHead).toBe(HEAD2);
    expect(store.getWork(workId)!.state).toBe("in-review");
    expect(mesh.jobs("review").map((j) => j.input.target.headSha).sort()).toEqual([HEAD1, HEAD2]);
    expect(mesh.jobs("revise").length).toBe(1);
  });

  test("a revise session that left the head unchanged is not evidence of a revision", async () => {
    const { github, reconciler } = await inReview();
    github.reviewList = [review()];
    await reconciler.tick();
    github.prByBranch = pr(); // same head as before
    const r = await reconciler.collectEvidence(workId, { revise: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("new commit");
  });

  test("the same unchanged head is fine for a start-work session, whatever the work's state says", async () => {
    const { github, reconciler } = await inReview();
    github.prByBranch = pr();
    expect((await reconciler.collectEvidence(workId)).ok).toBe(true);
  });
});

describe("current-head reconciliation", () => {
  test("a checkpointed revision gets exactly one review for a moved head", async () => {
    const { github, mesh, reconciler } = make();
    store.recordPullRequest(workId, { number: 12, head: HEAD1, url: pr().url });
    store.setState(workId, "checkpointed");
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    await reconciler.tick();
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD2]);
    expect(store.getWork(workId)).toMatchObject({ prHead: HEAD2, state: "in-review" });
  });

  test("a move retires both kinds of older pending operations", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "revising");
    store.enqueueOutbox({
      key: `revise:${workId}@${HEAD1}`, workId, purpose: "revise",
      payload: { repo: pr().repo, number: 12, head: HEAD1 },
    });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD2]);
    expect(mesh.jobs("revise")).toEqual([]);
    expect(store.listOutbox(workId).map((entry) => entry.status)).toEqual(["superseded", "superseded", "done"]);
    expect(store.listEvents(workId).filter((event) => event.kind === "head-jobs-retired")).toHaveLength(1);
  });

  test("a retired pending review can dispatch if its head returns", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    await reconciler.tick();
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD2, HEAD1]);
  });

  test("a dispatched review is recovered when its head returns", async () => {
    const { github, mesh, reconciler, restart } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    mesh.jobOverrides.set(earlier.id, { state: "expired", expiresAt: clock - 1 });

    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    await restart().tick();
    const jobs = mesh.jobs("review");
    expect(jobs.map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2, HEAD1]);
    expect(new Set(jobs.map((job) => job.input.idempotencyKey)).size).toBe(3);
  });

  test("a returned head reuses a review that can still run", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    await reconciler.tick();
    expect(mesh.readJobIds).toContain(earlier.id);
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2]);
    expect(store.listOutbox(workId).every((entry) => entry.status === "done")).toBe(true);
  });

  test.each(["active", "reported", "completed"] as const)(
    "a returned head reuses a review with %s work",
    async (state) => {
      const { github, mesh, reconciler } = make();
      github.prByBranch = pr();
      await reconciler.collectEvidence(workId);
      store.setState(workId, "in-review");
      await reconciler.tick();
      const earlier = mesh.jobs("review")[0]!;
      mesh.jobOverrides.set(earlier.id, state === "active" ? {
        claims: config.reviewers.map((reviewer, index) => ({
          id: `claim-${index}`, jobId: earlier.id, worker: reviewer.meshId,
          state: index === 0 ? "active" : "failed", leaseExpiresAt: clock + 100,
          evidenceRef: null,
        })),
      } : { state });
      if (state !== "active") github.reviewList = [review({ state: "APPROVED" })];
      github.current = pr({ headSha: HEAD2 });
      await reconciler.tick();
      github.current = pr();
      await reconciler.tick();
      expect(mesh.readJobIds).toContain(earlier.id);
      expect(mesh.jobs("review")).toHaveLength(2);
    },
  );

  test("a completed review with no standing verdict is replaced on return", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    mesh.jobOverrides.set(earlier.id, { state: "completed" });
    github.reviewList = [review({ state: "DISMISSED" })];
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    expect(mesh.readJobIds).toContain(earlier.id);
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2, HEAD1]);
  });

  test("a completed review is not replaced when its GitHub verdict cannot be read", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    mesh.jobOverrides.set(mesh.jobs("review")[0]!.id, { state: "reported" });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    github.reviews = async () => { throw new Error("review lookup unavailable"); };
    await reconciler.tick();
    expect(mesh.jobs("review")).toHaveLength(2);
    expect(store.listOutbox(workId).filter((entry) => entry.status === "pending")).toHaveLength(1);
  });

  test("a returned head replaces a queued job after all eligible reviewers failed", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    mesh.jobOverrides.set(earlier.id, {
      claims: config.reviewers.map((reviewer, index) => ({
        id: `claim-${index}`, jobId: earlier.id, worker: reviewer.meshId,
        state: "failed", leaseExpiresAt: clock - 1, evidenceRef: null,
      })),
    });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2, HEAD1]);
  });

  test("reviews reported during a non-atomic job lookup do not trigger a duplicate", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    // Mesh can read state=queued immediately before its separate claims read sees both reports.
    mesh.jobOverrides.set(earlier.id, {
      claims: config.reviewers.map((reviewer, index) => ({
        id: `claim-${index}`, jobId: earlier.id, worker: reviewer.meshId,
        state: "reported", leaseExpiresAt: clock, evidenceRef: `review-${index}`,
      })),
    });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.reviewList = [review({ state: "APPROVED" })];
    github.current = pr();
    await reconciler.tick();
    expect(mesh.readJobIds).toContain(earlier.id);
    expect(mesh.jobs("review")).toHaveLength(2);
  });

  test("reports observed during a non-atomic lookup with no standing verdict are replaced", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    mesh.jobOverrides.set(earlier.id, {
      claims: config.reviewers.map((reviewer, index) => ({
        id: `claim-${index}`, jobId: earlier.id, worker: reviewer.meshId,
        state: "reported", leaseExpiresAt: clock, evidenceRef: `review-${index}`,
      })),
    });
    github.reviewList = [review({ state: "DISMISSED" })];
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    expect(mesh.readJobIds).toContain(earlier.id);
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2, HEAD1]);
  });

  test("reported claims in a non-atomic lookup defer when the verdict cannot be read", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    mesh.jobOverrides.set(earlier.id, {
      claims: config.reviewers.map((reviewer, index) => ({
        id: `claim-${index}`, jobId: earlier.id, worker: reviewer.meshId,
        state: "reported", leaseExpiresAt: clock, evidenceRef: `review-${index}`,
      })),
    });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    github.reviews = async () => { throw new Error("review lookup unavailable"); };
    await reconciler.tick();
    expect(mesh.jobs("review")).toHaveLength(2);
    expect(store.listOutbox(workId).filter((entry) => entry.status === "pending")).toHaveLength(1);
  });

  test.each(["unavailable", "mismatched", "malformed"] as const)("a %s previous job defers a returned review", async (problem) => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const earlier = mesh.jobs("review")[0]!;
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    if (problem === "unavailable") mesh.readError = new Error("gateway lookup unavailable");
    else if (problem === "mismatched") mesh.jobOverrides.set(earlier.id, { target: { repo: "other/repo", kind: "pr", number: 12, headSha: HEAD1 } });
    else mesh.jobOverrides.set(earlier.id, { eligible: null });
    github.current = pr();
    await reconciler.tick();
    expect(mesh.jobs("review")).toHaveLength(2);
    expect(store.listOutbox(workId).filter((entry) => entry.status === "pending")).toHaveLength(1);
  });

  test("a lost replacement response reuses the same job after restart", async () => {
    const { github, mesh, reconciler, restart } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    mesh.jobOverrides.set(mesh.jobs("review")[0]!.id, { state: "expired", expiresAt: clock - 1 });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    mesh.failNewAfter = true;
    await reconciler.tick();
    expect(mesh.jobs("review")).toHaveLength(3);
    expect(store.listOutbox(workId).filter((entry) => entry.status === "pending")).toHaveLength(1);
    clock += config.retryBackoffMs;
    await restart().tick();
    expect(mesh.jobs("review")).toHaveLength(3);
    expect(store.listOutbox(workId).every((entry) => entry.status === "done")).toBe(true);
  });

  test("a lost response followed by another head move resolves the attempted job on return", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    mesh.jobOverrides.set(mesh.jobs("review")[0]!.id, { state: "expired", expiresAt: clock - 1 });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    mesh.failNewAfter = true;
    await reconciler.tick();
    const replacement = mesh.jobs("review").at(-1)!;
    expect(mesh.jobs("review")).toHaveLength(3);
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    expect(mesh.readJobIds).toContain(replacement.id);
    expect(mesh.jobs("review")).toHaveLength(3);
  });

  test("a head that moves during the prior-job lookup does not dispatch a stale replacement", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    mesh.jobOverrides.set(mesh.jobs("review")[0]!.id, { state: "expired", expiresAt: clock - 1 });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    mesh.onGetJob = () => { github.current = pr({ headSha: HEAD2 }); };
    await reconciler.tick();
    expect(mesh.readJobIds).toHaveLength(1);
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2]);
    expect(store.listOutbox(workId).at(-1)!.status).toBe("superseded");
  });

  test("a stored head that changes during the prior-job lookup prevents replacement", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    mesh.jobOverrides.set(mesh.jobs("review")[0]!.id, { state: "expired", expiresAt: clock - 1 });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    mesh.onGetJob = () => store.recordPullRequest(workId, { number: 12, head: HEAD2, url: pr().url });
    await reconciler.tick();
    expect(mesh.readJobIds).toHaveLength(1);
    expect(mesh.jobs("review")).toHaveLength(2);
    expect(store.listOutbox(workId).at(-1)!.status).toBe("superseded");
  });

  test("repeated returns inspect the latest dispatched review", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await reconciler.tick();
    const first = mesh.jobs("review")[0]!;
    mesh.jobOverrides.set(first.id, { state: "expired", expiresAt: clock - 1 });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    const replacement = mesh.jobs("review").at(-1)!;
    expect(replacement.id).not.toBe(first.id);
    mesh.jobOverrides.set(replacement.id, { state: "expired", expiresAt: clock - 1 });
    github.current = pr({ headSha: HEAD2 });
    await reconciler.tick();
    github.current = pr();
    await reconciler.tick();
    expect(mesh.readJobIds).toContain(replacement.id);
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1, HEAD2, HEAD1, HEAD1]);
  });

  test("a failing head lookup defers dispatch and records the lookup error", async () => {
    const { github, mesh, reconciler } = make();
    github.prByBranch = pr();
    await reconciler.collectEvidence(workId);
    store.setState(workId, "revising");
    store.enqueueOutbox({
      key: `revise:${workId}@${HEAD1}`, workId, purpose: "revise",
      payload: { repo: pr().repo, number: 12, head: HEAD1 },
    });
    const pullRequest = github.pullRequest.bind(github);
    github.pullRequest = async () => { throw new Error("head lookup unavailable"); };
    await reconciler.tick();
    expect(mesh.byKey.size).toBe(0);
    expect(store.listOutbox(workId).map((entry) => entry.lastError)).toEqual([
      "head lookup unavailable", "head lookup unavailable",
    ]);
    github.pullRequest = pullRequest;
    clock += config.retryBackoffMs;
    await reconciler.tick();
    expect(mesh.jobs("review")).toHaveLength(1);
    expect(mesh.jobs("revise")).toHaveLength(1);
  });

  test("an already recorded head with a missing review entry is repaired", async () => {
    const { mesh, reconciler } = make();
    store.recordPullRequest(workId, { number: 12, head: HEAD1, url: pr().url });
    store.setState(workId, "in-review");
    await reconciler.tick();
    await reconciler.tick();
    expect(mesh.jobs("review").map((job) => job.input.target.headSha)).toEqual([HEAD1]);
  });
});

describe("auto merge", () => {
  async function inReview() {
    const ctx = make();
    ctx.github.prByBranch = pr();
    await ctx.reconciler.collectEvidence(workId);
    store.setState(workId, "in-review");
    await ctx.reconciler.tick(); // no reviews yet: nothing to merge
    return ctx;
  }
  function approved(github: FakeGitHub) {
    github.reviewList = [review({ state: "APPROVED" })];
    github.checksList = [{ name: "ci", state: "SUCCESS" }];
  }

  test("an approval on the current head with green checks and no open threads merges once", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([{ repo: "rfcclub/anima", number: 12, head: HEAD1 }]);
    expect(store.listEvents(workId).some((event) => event.kind === "merge-requested")).toBe(true);
    await reconciler.tick();
    expect(github.mergeCalls.length).toBe(1);
  });

  test("pending or failing checks block the merge", async () => {
    for (const state of ["IN_PROGRESS", "FAILURE", "PENDING", "CANCELLED"]) {
      const { github, reconciler } = await inReview();
      approved(github);
      github.checksList = [{ name: "ci", state }];
      await reconciler.tick();
      expect(github.mergeCalls).toEqual([]);
    }
  });

  test("no checks is not green", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    github.checksList = [];
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([]);
  });

  test("a check that only skipped is not a green check", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    github.checksList = [{ name: "ci", state: "SKIPPED" }];
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([]);
  });

  test("unresolved review threads block the merge", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    github.threads = 1;
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([]);
  });

  test("a draft pull request is not merged", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    github.current = pr({ draft: true });
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([]);
  });

  test("a standing changes-requested review yields a revise job, not a merge", async () => {
    const { github, mesh, reconciler } = await inReview();
    approved(github);
    github.reviewList = [review({ state: "CHANGES_REQUESTED" }), review({ id: 2, state: "APPROVED", authorLogin: "pia-gotako[bot]" })];
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([]);
    expect(mesh.jobs("revise").length).toBe(1);
  });

  test("a standing change request from outside the configured reviewer set blocks the merge", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    github.reviewList = [review({ state: "APPROVED" }), review({ id: 2, state: "CHANGES_REQUESTED", authorLogin: "review-bot" })];
    await reconciler.tick();
    expect(github.mergeCalls).toEqual([]);
  });

  describe("configured external reviewers", () => {
    async function withExternal(logins: string[] | undefined) {
      const github = new FakeGitHub();
      const mesh = new FakeMesh();
      const reconciler = new Reconciler({ store, github, mesh, config: { ...config, ...(logins ? { externalReviewers: logins } : {}) }, now: () => clock });
      github.prByBranch = pr();
      await reconciler.collectEvidence(workId);
      store.setState(workId, "in-review");
      await reconciler.tick();
      return { github, mesh, reconciler };
    }

    test("a standing change request from a listed external reviewer on the current head starts a revise", async () => {
      const { github, mesh, reconciler } = await withExternal(["review-bot[bot]"]);
      github.reviewList = [review({ id: 1, state: "APPROVED" }), review({ id: 2, state: "CHANGES_REQUESTED", authorLogin: "review-bot[bot]" })];
      await reconciler.tick();
      expect(mesh.jobs("revise").length).toBe(1);
      expect(store.getWork(workId)!.state).toBe("revising");
    });

    test("the same request from a login that is not listed starts nothing", async () => {
      const { github, mesh, reconciler } = await withExternal(["someone-else"]);
      github.reviewList = [review({ id: 2, state: "CHANGES_REQUESTED", authorLogin: "review-bot[bot]" })];
      await reconciler.tick();
      expect(mesh.jobs("revise").length).toBe(0);
      expect(store.getWork(workId)!.state).toBe("in-review");
    });

    test("without the setting nothing changes (default is empty)", async () => {
      const { github, mesh, reconciler } = await withExternal(undefined);
      github.reviewList = [review({ id: 2, state: "CHANGES_REQUESTED", authorLogin: "review-bot[bot]" })];
      await reconciler.tick();
      expect(mesh.jobs("revise").length).toBe(0);
    });

    test("a change request from a listed login on an older head starts nothing", async () => {
      const { github, mesh, reconciler } = await withExternal(["review-bot[bot]"]);
      github.reviewList = [review({ id: 2, state: "CHANGES_REQUESTED", authorLogin: "review-bot[bot]", commitId: "c".repeat(40) })];
      await reconciler.tick();
      expect(mesh.jobs("revise").length).toBe(0);
    });

    test("an approval by a listed external reviewer alone does not merge", async () => {
      const { github, reconciler } = await withExternal(["review-bot[bot]"]);
      github.reviewList = [review({ id: 2, state: "APPROVED", authorLogin: "review-bot[bot]" })];
      github.checksList = [{ name: "ci", state: "SUCCESS" }];
      await reconciler.tick();
      expect(github.mergeCalls).toEqual([]);
    });
  });

  test("a failed merge is retried only after the backoff", async () => {
    const { github, reconciler } = await inReview();
    approved(github);
    github.mergeError = new Error("branch protection refused");
    await reconciler.tick();
    await reconciler.tick();
    expect(github.mergeAttempts).toBe(1);
    clock += 5 * 60_000 + 1;
    github.mergeError = null;
    await reconciler.tick();
    expect(github.mergeAttempts).toBe(2);
    expect(github.mergeCalls.length).toBe(1);
  });
});
