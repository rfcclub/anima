import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { Reconciler, type ReconcilerConfig } from "../../src/work/reconciler";
import { createWorkHandler } from "../../src/work/consumer";
import { issueDigest12 } from "../../src/work/approval";
import { reviewFeedback } from "../../src/work/runtime";
import type { PullRequestInfo, ReviewInfo } from "../../src/work/evidence";

const HEAD = "a".repeat(40);
const JOB = "52a16701-2060-4ab5-9afd-920e45131d44";
const BODY = "approved intent";
const DIGEST = issueDigest12(BODY);
const config: ReconcilerConfig = {
  base: "master", authorActor: "finn-gotako[bot]", authorMeshIds: ["finn@anima"],
  reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }], retryBackoffMs: 60_000,
};
let store: WorkStore;
let workId: string;
let pr: PullRequestInfo;
let feedback: ReviewInfo[];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "retry-revise-fixture-"));
  store = WorkStore.open(":memory:", { rootBase: root });
  const work = store.createWork({ repo: "test/anima", issue: 7, approvedDigest: DIGEST, config: loadWorkConfig({}) }).work;
  workId = work.workId;
  pr = { repo: work.repo, number: 12, url: "https://github.com/test/anima/pull/12", state: "open", merged: false,
    headSha: HEAD, headRef: work.branch, baseRef: "master", body: "Closes #7", authorLogin: config.authorActor };
  store.recordPullRequest(workId, { number: 12, head: HEAD, url: pr.url });
  store.setState(workId, "checkpointed");
  feedback = [
    { id: 1, state: "CHANGES_REQUESTED", commitId: HEAD, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "u", submittedAt: "t", body: "fix bootout" },
    { id: 2, state: "CHANGES_REQUESTED", commitId: HEAD, authorLogin: "rfcclub", authorType: "User", url: "u", submittedAt: "t", body: "verify dispatcher readiness" },
    { id: 3, state: "CHANGES_REQUESTED", commitId: HEAD, authorLogin: "unapproved", authorType: "User", url: "u", submittedAt: "t", body: "do not include" },
  ];
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function github() {
  return { findPullRequest: async () => pr, pullRequest: async () => pr, reviews: async () => feedback };
}
function priorJob(state: "failed" | "active" | "reported" = "failed") {
  return { id: JOB, enqueuer: "finn@anima", type: "revise", target: { repo: "test/anima", kind: "pr", number: 12, headSha: HEAD },
    slots: 1, eligible: ["finn@anima"], excluded: [], state: "queued", workRef: `${workId}.${DIGEST}`,
    claims: [{ id: "claim", jobId: JOB, worker: "finn@anima", state }] };
}
function enqueueRetry() {
  store.enqueueOutbox({ key: `revise-retry:${workId}@${HEAD}:recovery:23`, workId, purpose: "revise",
    payload: { repo: "test/anima", number: 12, head: HEAD, failedJobId: JOB, recoverySeq: 23, reviewers: ["rfcclub"] } });
}

describe("operator retry of a recovered revision", () => {
  test.each(["open session", "untrusted stop", "exhausted budget"] as const)(
    "retry refuses a recovered work with %s",
    (problem) => {
      const work = store.createWork({ repo: "test/anima", issue: 8, approvedDigest: DIGEST,
        config: loadWorkConfig({ caps: { maxSessions: problem === "exhausted budget" ? 1 : 3 } }) }).work;
      store.recordPullRequest(work.workId, { number: 12, head: HEAD, url: pr.url });
      const session = store.reserveSession(work.workId, { jobId: "old", claimId: "claim" });
      if (!session.ok) throw new Error("fixture session was not reserved");
      if (problem !== "open session") {
        store.closeSession(session.session.sessionId, { stopCause: "done", iterations: 1, execMs: 1 });
        store.recordStop({ sessionId: session.session.sessionId, workId: work.workId, adapter: "loop",
          stopCause: "done", cessation: "proven", cessationCheck: null, head: HEAD, status: "",
          evidence: "unavailable", trusted: problem !== "untrusted stop", interrupted: false });
      }
      store.setState(work.workId, "checkpointed");
      store.appendEvent(work.workId, "operator-recovery", {});
      const recovery = store.listEvents(work.workId).at(-1)!;
      expect(() => store.enqueueRecoveredRevision({ workId: work.workId, root: work.root, generation: session.session.generation,
        number: 12, head: HEAD, recoverySeq: recovery.seq, failedJobId: JOB, reviewers: [] })).toThrow(/checkpoint|budget/i);
      expect(store.listOutbox(work.workId)).toHaveLength(0);
    },
  );

  test("regression: a failed revise gets a new deterministic key while preserving the work, PR, head, and author", async () => {
    enqueueRetry();
    const sent: Record<string, unknown>[] = [];
    const mesh = { getJob: async () => priorJob(), enqueue: async (input: Record<string, unknown>) => { sent.push(input); return { id: "new" }; }, confirm: async () => {} };
    await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "revise", target: { repo: "test/anima", kind: "pr", number: 12, headSha: HEAD },
      eligible: ["finn@anima"], workRef: `${workId}.${DIGEST}` });
    expect(sent[0]!.idempotencyKey).toBe(`revise-retry:${workId}@${HEAD}:recovery:23`);
  });

  test.each(["active", "reported", "weird", "queued", "", null] as const)(
    "a prior job with a failed claim and a %s claim cannot be retried", async (state) => {
    enqueueRetry();
    const old: any = priorJob();
    old.claims.push({ ...old.claims[0], id: "other", state });
    const sent: Record<string, unknown>[] = [];
    const mesh = { getJob: async () => old, enqueue: async (input: Record<string, unknown>) => { sent.push(input); return { id: "new" }; }, confirm: async () => {} };
    await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
    expect(sent).toHaveLength(0);
    expect(store.listOutbox(workId)[0]!.status).toBe("pending");
  });

  test.each(["lost", "released"] as const)(
    "a prior job with failed and %s claims can be retried", async (state) => {
    enqueueRetry();
    const old: any = priorJob();
    old.claims.push({ ...old.claims[0], id: "other", state });
    const sent: Record<string, unknown>[] = [];
    const mesh = { getJob: async () => old, enqueue: async (input: Record<string, unknown>) => { sent.push(input); return { id: "new" }; }, confirm: async () => {} };
    await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
    expect(sent).toHaveLength(1);
  });

  test.each(["wrong-work", "wrong-head", "wrong-repo", "wrong-author", "wrong-enqueuer", "other-claimant", "another-eligible", "no-failed-claim"] as const)(
    "a %s prior job cannot be retried",
    async (problem) => {
      enqueueRetry();
      const old: any = priorJob();
      if (problem === "wrong-work") old.workRef = "another-work.d1d1d1d1d1d1";
      if (problem === "wrong-head") old.target.headSha = "b".repeat(40);
      if (problem === "wrong-repo") old.target.repo = "other/repo";
      if (problem === "wrong-author") old.claims[0].worker = "another@anima";
      if (problem === "wrong-enqueuer") old.enqueuer = "another@anima";
      if (problem === "other-claimant") old.claims.push({ ...old.claims[0], worker: "another@anima" });
      if (problem === "another-eligible") old.eligible.push("another@anima");
      if (problem === "no-failed-claim") old.claims = [];
      const sent: Record<string, unknown>[] = [];
      const mesh = { getJob: async () => old, enqueue: async (input: Record<string, unknown>) => { sent.push(input); return { id: "new" }; }, confirm: async () => {} };
      await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
      expect(sent).toHaveLength(0);
    },
  );

  test("a moved PR head does not enqueue a retry", async () => {
    enqueueRetry();
    pr.headSha = "b".repeat(40);
    const sent: Record<string, unknown>[] = [];
    const mesh = { getJob: async () => priorJob(), enqueue: async (input: Record<string, unknown>) => { sent.push(input); return { id: "new" }; }, confirm: async () => {} };
    await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
    expect(sent).toHaveLength(0);
  });

  test("a withdrawn operator-selected review does not enqueue a retry", async () => {
    enqueueRetry();
    feedback = feedback.filter((review) => review.authorLogin !== "rfcclub");
    const sent: Record<string, unknown>[] = [];
    const mesh = { getJob: async () => priorJob(), enqueue: async (input: Record<string, unknown>) => { sent.push(input); return { id: "new" }; }, confirm: async () => {} };
    await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
    expect(sent).toHaveLength(0);
    expect(store.listOutbox(workId)[0]!.status).toBe("pending");
  });

  test("a lost enqueue response retries with the same key and creates only one job", async () => {
    enqueueRetry();
    let now = 1_000_000;
    let calls = 0;
    const remote = new Map<string, string>();
    const mesh = {
      getJob: async () => priorJob(),
      enqueue: async (input: Record<string, unknown>) => {
        const key = String(input.idempotencyKey);
        const id = remote.get(key) ?? "new";
        remote.set(key, id);
        if (++calls === 1) throw new Error("response lost after enqueue");
        return { id };
      },
      confirm: async () => {},
    };
    const reconciler = new Reconciler({ store, github: github(), mesh, config, now: () => now });
    await reconciler.tick();
    expect(store.listOutbox(workId)[0]!.status).toBe("pending");
    now += 60_001;
    await reconciler.tick();
    expect(calls).toBe(2);
    expect(remote.size).toBe(1);
    expect(store.listOutbox(workId)[0]!.status).toBe("done");
  });

  test("the same Mesh capability is used for checking and enqueueing a retry", async () => {
    enqueueRetry();
    let usedSnapshot = false;
    const mesh = {
      getJob: async () => { throw new Error("rotating capability used"); },
      enqueue: async () => { throw new Error("rotating capability used"); },
      confirm: async () => {},
      retrySession: () => ({
        getJob: async () => priorJob(),
        enqueue: async () => { usedSnapshot = true; return { id: "new" }; },
      }),
    };
    await new Reconciler({ store, github: github(), mesh, config, now: () => 1_000_000 }).tick();
    expect(usedSnapshot).toBe(true);
    expect(store.listOutbox(workId)[0]!.status).toBe("done");
  });

  test("a prior recovery reviewer is not authorized by a later recovery at the same head", async () => {
    store.appendEvent(workId, "operator-recovery", {});
    const firstRecovery = store.listEvents(workId).at(-1)!;
    store.appendEvent(workId, "operator-revise-retry", {
      head: HEAD, recoverySeq: firstRecovery.seq, reviewers: ["rfcclub"],
    });
    store.appendEvent(workId, "operator-recovery", {});

    const { validateRevisionFeedback } = await import("../../src/work/runtime");
    const work = store.getWork(workId)!;
    const brief = await reviewFeedback(github(), config, store)(work);
    expect(brief).toContain("fix bootout");
    expect(brief).not.toContain("verify dispatcher readiness");
    feedback = feedback.filter((review) => review.authorLogin !== "cleo-gotako[bot]");
    expect((await validateRevisionFeedback(github(), config, store)(work)).ok).toBe(false);

    const secondRecovery = store.listEvents(workId).filter((event) => event.kind === "operator-recovery").at(-1)!;
    store.appendEvent(workId, "operator-revise-retry", {
      head: HEAD, recoverySeq: secondRecovery.seq, reviewers: ["unapproved"],
    });
    const currentBrief = await reviewFeedback(github(), config, store)(work);
    expect(currentBrief).toContain("do not include");
    expect(currentBrief).not.toContain("verify dispatcher readiness");
    expect((await validateRevisionFeedback(github(), config, store)(work)).ok).toBe(true);
  });

  test("only an operator-authorized additional current-head reviewer reaches the revision brief", async () => {
    store.appendEvent(workId, "operator-recovery", {});
    const recovery = store.listEvents(workId).at(-1)!;
    store.appendEvent(workId, "operator-revise-retry", { head: HEAD, recoverySeq: recovery.seq, reviewers: ["rfcclub"] });
    const source = {
      ...github(),
      reviewComments: async () => [
        { reviewId: 2, commitId: HEAD, authorLogin: "rfcclub", path: "scripts/deploy.sh", line: 271,
          body: "check that the replacement dispatcher initialized" },
        { reviewId: 3, commitId: HEAD, authorLogin: "unapproved", path: "x", line: 1, body: "unapproved inline" },
        { reviewId: 2, commitId: "b".repeat(40), authorLogin: "rfcclub", path: "x", line: 1, body: "stale inline" },
      ],
    };
    const read = (reviewFeedback as any)(source, { authorActor: config.authorActor, reviewers: config.reviewers }, store);
    const text: string = await read(store.getWork(workId)!);
    expect(text).toContain("fix bootout");
    expect(text).toContain("verify dispatcher readiness");
    expect(text).toContain("scripts/deploy.sh:271");
    expect(text).toContain("check that the replacement dispatcher initialized");
    expect(text).not.toContain("do not include");
    expect(text).not.toContain("unapproved inline");
    expect(text).not.toContain("stale inline");
  });

  test("the production preflight refuses a selected reviewer whose request was withdrawn", async () => {
    store.appendEvent(workId, "operator-recovery", {});
    const recovery = store.listEvents(workId).at(-1)!;
    store.appendEvent(workId, "operator-revise-retry", { head: HEAD, recoverySeq: recovery.seq, reviewers: ["rfcclub"] });
    feedback = feedback.filter((review) => review.authorLogin !== "rfcclub");
    const { validateRevisionFeedback } = await import("../../src/work/runtime");
    const result = await validateRevisionFeedback(github(), config, store)(store.getWork(workId)!);
    expect(result.ok).toBe(false);
  });

  test("a changed live PR head is refused before reserving a revision session", async () => {
    let ran = false;
    const handler = createWorkHandler({
      store, heartbeatMs: 60_000,
      executor: {
        ready: () => ({ ok: true }),
        runSession: async () => {
          ran = true;
          return { stopCause: "max_reached", iterations: 1, execMs: 1, cessation: "proven" };
        },
      },
      github: {
        issue: async () => ({ title: "issue", body: BODY }),
        pullRequest: async () => ({ headSha: "b".repeat(40), state: "open", merged: false, title: "PR", body: "", author: "author" }),
        diff: async () => "", reviews: async () => [],
      },
      collectEvidence: async () => ({ ok: false, reason: "not reached" }),
    });
    const claim = { id: "claim", jobId: JOB, worker: "finn@anima", state: "active", leaseExpiresAt: Date.now() + 60_000, evidenceRef: null } as const;
    const job = { ...priorJob(), expiresAt: Date.now() + 60_000, createdAt: Date.now() } as any;
    const jobs = { heartbeat: async () => claim } as any;
    await handler.run({ worker: "finn", claim, job, jobs });
    expect(ran).toBe(false);
    expect(store.getWork(workId)!.sessionsUsed).toBe(0);
  });

  test.each([
    { state: "closed", merged: false },
    { state: "closed", merged: true },
    { state: "open", merged: true },
    { state: "unknown", merged: false },
  ])("a closed or merged PR ($state, merged=$merged) is refused before session reservation", async ({ state, merged }) => {
    let ran = false;
    const handler = createWorkHandler({
      store, heartbeatMs: 60_000,
      executor: {
        ready: () => ({ ok: true }),
        runSession: async () => {
          ran = true;
          return { stopCause: "max_reached", iterations: 1, execMs: 1, cessation: "proven" };
        },
      },
      github: {
        issue: async () => ({ title: "issue", body: BODY }),
        pullRequest: async () => ({ headSha: HEAD, state, merged, title: "PR", body: "", author: "author" }),
        diff: async () => "", reviews: async () => [],
      },
      collectEvidence: async () => ({ ok: false, reason: "not reached" }),
    });
    const claim = { id: "claim", jobId: JOB, worker: "finn@anima", state: "active", leaseExpiresAt: Date.now() + 60_000, evidenceRef: null } as const;
    const job = { ...priorJob(), expiresAt: Date.now() + 60_000, createdAt: Date.now() } as any;
    await handler.run({ worker: "finn", claim, job, jobs: { heartbeat: async () => claim } as any });
    expect(ran).toBe(false);
    expect(store.getWork(workId)!.sessionsUsed).toBe(0);
  });

  test("withdrawn revision feedback is refused before reserving a session", async () => {
    let ran = false;
    const handler = createWorkHandler({
      store, heartbeatMs: 60_000,
      executor: {
        ready: () => ({ ok: true }),
        runSession: async () => {
          ran = true;
          return { stopCause: "max_reached", iterations: 1, execMs: 1, cessation: "proven" };
        },
      },
      github: {
        issue: async () => ({ title: "issue", body: BODY }),
        pullRequest: async () => ({ headSha: HEAD, state: "open", merged: false, title: "PR", body: "", author: "author" }),
        diff: async () => "", reviews: async () => [],
      },
      validateRevision: async () => ({ ok: false, reason: "review withdrawn" }),
      collectEvidence: async () => ({ ok: false, reason: "not reached" }),
    } as any);
    const claim = { id: "claim", jobId: JOB, worker: "finn@anima", state: "active", leaseExpiresAt: Date.now() + 60_000, evidenceRef: null } as const;
    const job = { ...priorJob(), expiresAt: Date.now() + 60_000, createdAt: Date.now() } as any;
    await handler.run({ worker: "finn", claim, job, jobs: { heartbeat: async () => claim } as any });
    expect(ran).toBe(false);
    expect(store.getWork(workId)!.sessionsUsed).toBe(0);
  });
});

describe("configured external reviewers reach the revise session", () => {
  test("the brief carries a listed outside reviewer's text and validation accepts it; an unlisted login stays out", async () => {
    const { validateRevisionFeedback } = await import("../../src/work/runtime");
    const work = store.getWork(workId)!;
    feedback = feedback.filter((r) => r.authorLogin !== "cleo-gotako[bot]"); // only outside reviewers stand
    const withList = { ...config, externalReviewers: ["rfcclub"] };
    const brief = await reviewFeedback(github(), withList, store)(work);
    expect(brief).toContain("verify dispatcher readiness");
    expect(brief).not.toContain("do not include");
    expect((await validateRevisionFeedback(github(), withList, store)(work)).ok).toBe(true);
    expect((await validateRevisionFeedback(github(), config, store)(work)).ok).toBe(false);
  });
});
