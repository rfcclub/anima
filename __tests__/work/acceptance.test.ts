/**
 * castle-work-loop, WL-5: a work is accepted only for a verified merge with an independent
 * approval of the merged head. Transport completion, `<DONE>` and a forged URL are not acceptance.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { Reconciler, type MeshEnqueuer, type ReconcilerConfig } from "../../src/work/reconciler";
import { decideAcceptance, type PullRequestInfo, type ReviewInfo, type WorkGitHub } from "../../src/work/evidence";

const HEAD = "a".repeat(40);
const OLD = "9".repeat(40);
const CTX = { head: HEAD, authorActor: "finn-gotako[bot]", reviewerLogins: ["cleo-gotako[bot]", "pia-gotako[bot]"] };

const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  repo: "rfcclub/anima", number: 12, url: "https://github.com/rfcclub/anima/pull/12", state: "open", merged: false, headSha: HEAD,
  headRef: "work/7-wabc", baseRef: "master", body: "Closes #7", authorLogin: "finn-gotako[bot]", ...over,
});
const rev = (over: Partial<ReviewInfo> = {}): ReviewInfo => ({
  id: 1, state: "APPROVED", commitId: HEAD, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "https://github.com/x/pull/12#pullrequestreview-1", submittedAt: "2026-10-22T13:00:00Z", ...over,
});

describe("decideAcceptance", () => {
  const merged = pr({ state: "closed", merged: true });
  const closed = pr({ state: "closed", merged: false });

  test.each([
    ["open, no reviews", pr(), [], "open"],
    ["open, approved", pr(), [rev()], "open"],
    ["merged with an independent approval of the merged head", merged, [rev()], "accepted"],
    ["merged with two approvals", merged, [rev(), rev({ id: 2, authorLogin: "pia-gotako[bot]" })], "accepted"],
    ["merged, no review at all", merged, [], "blocked"],
    ["merged, only the author approved", merged, [rev({ authorLogin: "finn-gotako[bot]" })], "blocked"],
    ["merged, approval by a login outside the reviewers", merged, [rev({ authorLogin: "random-user", authorType: "User" })], "blocked"],
    ["merged, approval was of an older head", merged, [rev({ commitId: OLD })], "blocked"],
    ["merged, approved then changes requested by the same reviewer", merged, [rev({ id: 1 }), rev({ id: 2, state: "CHANGES_REQUESTED" })], "blocked"],
    ["merged, one approves and another has changes standing", merged, [rev({ id: 1 }), rev({ id: 2, authorLogin: "pia-gotako[bot]", state: "CHANGES_REQUESTED" })], "blocked"],
    ["merged, changes requested then approved by the same reviewer", merged, [rev({ id: 1, state: "CHANGES_REQUESTED" }), rev({ id: 2 })], "accepted"],
    ["closed without merge", closed, [rev()], "blocked"],
  ])("%s -> %s", (_name, request, reviews, expected) => {
    expect(decideAcceptance(request as PullRequestInfo, reviews as ReviewInfo[], CTX).kind).toBe(expected as string);
  });

  test("a blocked decision says why", () => {
    expect((decideAcceptance(closed, [rev()], CTX) as { reason: string }).reason).toContain("closed without merge");
    expect((decideAcceptance(merged, [], CTX) as { reason: string }).reason).toContain("reconcil");
  });
});

describe("reconciler acceptance", () => {
  let store: WorkStore;
  let workId: string;
  let clock: number;
  const config: ReconcilerConfig = {
    base: "master", authorActor: "finn-gotako[bot]", authorMeshIds: ["finn@anima"],
    reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }, { agent: "pia", meshId: "pia@anima", login: "pia-gotako[bot]" }],
    retryBackoffMs: 60_000,
  };
  class GH implements WorkGitHub {
    current = pr({ headRef: "x" });
    list: ReviewInfo[] = [];
    async findPullRequest() { return null; }
    async pullRequest() { return this.current; }
    async reviews() { return this.list; }
  }
  class Mesh implements MeshEnqueuer {
    confirmed: string[] = [];
    failing = false;
    notReported = new Set<string>();
    notMine = new Set<string>();
    enqueued = 0;
    async enqueue() { this.enqueued++; return { id: "j" }; }
    async confirm(id: string) {
      if (this.failing) throw new Error("gateway down");
      if (this.notReported.has(id)) throw new Error(`job ${id} is not reported (state completed)`);
      if (this.notMine.has(id)) throw new Error("mesh jobs gateway returned 403: authorization failed: only the enqueuer confirms a job");
      this.confirmed.push(id);
    }
  }

  beforeEach(() => {
    store = WorkStore.open(":memory:", { rootBase: "/w" });
    clock = 1_000_000;
    workId = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work.workId;
    store.recordPullRequest(workId, { number: 12, head: HEAD, url: "https://github.com/rfcclub/anima/pull/12" });
    store.setState(workId, "in-review");
    store.appendEvent(workId, "job-reported", { jobId: "job-start", type: "start-work" });
    store.appendEvent(workId, "job-reported", { jobId: "job-revise", type: "revise" });
  });
  afterEach(() => store.close());

  function rig() {
    const github = new GH();
    const mesh = new Mesh();
    const reconciler = new Reconciler({ store, github, mesh, config, now: () => clock });
    return { github, mesh, reconciler };
  }

  test("a merge with an independent approval accepts the work and confirms every reported job", async () => {
    const { github, mesh, reconciler } = rig();
    github.current = pr({ state: "closed", merged: true });
    github.list = [rev()];
    await reconciler.tick();
    expect(store.getWork(workId)!.state).toBe("accepted");
    expect(mesh.confirmed.sort()).toEqual(["job-revise", "job-start"]);
  });

  test("a merge with only the author's approval is flagged for reconciliation, not accepted, and nothing is confirmed", async () => {
    const { github, mesh, reconciler } = rig();
    github.current = pr({ state: "closed", merged: true });
    github.list = [rev({ authorLogin: "finn-gotako[bot]" })];
    await reconciler.tick();
    const w = store.getWork(workId)!;
    expect(w.state).toBe("blocked");
    expect(w.blockedReason).toContain("reconcil");
    expect(mesh.confirmed).toEqual([]);
  });

  test("a pull request closed without merge blocks the work", async () => {
    const { github, reconciler } = rig();
    github.current = pr({ state: "closed", merged: false });
    await reconciler.tick();
    expect(store.getWork(workId)!.state).toBe("blocked");
    expect(store.getWork(workId)!.blockedReason).toContain("closed without merge");
  });

  test("an open pull request stays in review whatever else happens; the model saying done does not accept it", async () => {
    const { github, mesh, reconciler } = rig();
    github.list = [rev()];
    await reconciler.tick();
    await mesh.confirm("job-start"); // a stray confirmation of the transport job
    await reconciler.tick();
    expect(store.getWork(workId)!.state).toBe("in-review");
  });

  test("when confirmation is unavailable after a merge the work stays accepted with the confirmation pending, and no session can start", async () => {
    const { github, mesh, reconciler } = rig();
    github.current = pr({ state: "closed", merged: true });
    github.list = [rev()];
    mesh.failing = true;
    await reconciler.tick();
    expect(store.getWork(workId)!.state).toBe("accepted");
    expect(store.listOutbox(workId).find((o) => o.purpose === "confirm")!.status).toBe("pending");
    const reserve = store.reserveSession(workId, { jobId: "j", claimId: "c" });
    expect(reserve.ok).toBe(false);

    mesh.failing = false;
    clock += 61_000;
    await reconciler.tick();
    expect(store.listOutbox(workId).find((o) => o.purpose === "confirm")!.status).toBe("done");
    expect(mesh.confirmed.sort()).toEqual(["job-revise", "job-start"]);
    expect(mesh.enqueued).toBe(0);
  });

  test("a job already confirmed elsewhere does not make the confirmation retry forever", async () => {
    const { github, mesh, reconciler } = rig();
    github.current = pr({ state: "closed", merged: true });
    github.list = [rev()];
    mesh.notReported.add("job-start");
    await reconciler.tick();
    expect(store.listOutbox(workId).find((o) => o.purpose === "confirm")!.status).toBe("done");
    expect(mesh.confirmed).toEqual(["job-revise"]);
  });

  test("a job another identity enqueued is left for that enqueuer, noted in the work's events, and does not block the rest", async () => {
    const { github, mesh, reconciler } = rig();
    github.current = pr({ state: "closed", merged: true });
    github.list = [rev()];
    mesh.notMine.add("job-start");
    await reconciler.tick();
    expect(mesh.confirmed).toEqual(["job-revise"]);
    expect(store.listOutbox(workId).find((o) => o.purpose === "confirm")!.status).toBe("done");
    const note = store.listEvents(workId).find((e) => e.kind === "confirm-left-to-enqueuer");
    expect(note?.detail).toMatchObject({ jobIds: ["job-start"] });
  });

  test("accepting twice confirms once", async () => {
    const { github, mesh, reconciler } = rig();
    github.current = pr({ state: "closed", merged: true });
    github.list = [rev()];
    await reconciler.tick();
    await reconciler.tick();
    expect(mesh.confirmed.length).toBe(2);
  });
});
