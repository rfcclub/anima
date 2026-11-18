/**
 * A work that has recorded a pull request is bounded by sessionWallMs and maxSessions, not by the running work wall,
 * so review rounds cannot strand the PR.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../src/work/store";
import { recoverWork } from "../../src/work/recover";
import type { TreeRead } from "../../src/work/stops";
import { loadWorkConfig } from "../../src/work/config";

const WORK_WALL = 1_800_000;
const SESSION_WALL = 600_000;
const HEAD = "a".repeat(40);

let store: WorkStore;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "revise-wall-")));
  store = WorkStore.open(":memory:", { rootBase: root });
});
afterEach(() => store.close());

function newWork(workId: string, maxSessions = 9): string {
  store.createWork({
    repo: "rfcclub/anima", issue: 7, approvedDigest: "d".repeat(12), workId,
    config: loadWorkConfig({ caps: { maxSessions, workWallMs: WORK_WALL, sessionWallMs: SESSION_WALL } }),
  });
  return workId;
}

/** Reserve and close one session that used `execMs`. */
function spend(workId: string, execMs: number, n: number): void {
  const reserved = store.reserveSession(workId, { jobId: `job-${n}`, claimId: `claim-${n}` });
  if (!reserved.ok) throw new Error(`reserve ${n} refused: ${reserved.reason}`);
  store.closeSession(reserved.session.sessionId, { iterations: 1, execMs, stopCause: "done" });
}

function publish(workId: string): void {
  store.recordPullRequest(workId, { number: 12, head: HEAD, url: "https://github.com/rfcclub/anima/pull/12" });
  store.setState(workId, "revising");
}

describe("the running work wall and published pull requests", () => {
  test("1. a work with a recorded PR and 1_790_000 ms used reserves a session with the session deadline", () => {
    const workId = newWork("wrevise0001");
    spend(workId, 1_790_000, 1);
    publish(workId);
    const next = store.reserveSession(workId, { jobId: "job-2", claimId: "claim-2" });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.deadlineMs).toBe(SESSION_WALL);
  });

  test("2. a work with no recorded PR and 1_700_000 ms used gets only the remaining 100_000 ms", () => {
    const workId = newWork("wrevise0002");
    spend(workId, 1_700_000, 1);
    const next = store.reserveSession(workId, { jobId: "job-2", claimId: "claim-2" });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.deadlineMs).toBe(100_000);
  });

  test("3. a work with no recorded PR and the whole wall used is refused as time", () => {
    const workId = newWork("wrevise0003");
    spend(workId, WORK_WALL, 1);
    const next = store.reserveSession(workId, { jobId: "job-2", claimId: "claim-2" });
    expect(next).toMatchObject({ ok: false, reason: "time" });
    expect(store.getWork(workId)).toMatchObject({ state: "blocked", blockedReason: "execution time limit reached" });
  });

  test("4. a work with a recorded PR and maxSessions used is still refused as sessions", () => {
    const workId = newWork("wrevise0004", 2);
    spend(workId, 1_000, 1);
    publish(workId);
    spend(workId, 1_000, 2);
    store.setState(workId, "revising");
    const next = store.reserveSession(workId, { jobId: "job-3", claimId: "claim-3" });
    expect(next).toMatchObject({ ok: false, reason: "sessions" });
    expect(store.getWork(workId)!.blockedReason).toContain("sessions exhausted");
  });

  test("5. review rounds past the wall keep the work reviewable", () => {
    const workId = newWork("wrevise0005");
    spend(workId, 600_000, 1);
    spend(workId, 179_000, 2);
    publish(workId);
    spend(workId, 384_000, 3);
    store.setState(workId, "revising");
    spend(workId, 379_000, 4);
    store.setState(workId, "revising");
    expect(store.getWork(workId)!.execMsUsed).toBe(1_542_000);
    spend(workId, 300_000, 5);
    store.setState(workId, "revising");
    const sixth = store.reserveSession(workId, { jobId: "job-6", claimId: "claim-6" });
    expect(sixth.ok).toBe(true);
    expect(store.getWork(workId)!.execMsUsed).toBe(1_842_000);
    expect(store.getWork(workId)!.state).not.toBe("blocked");
  });
});

describe("operator recovery and retry use the same wall rule", () => {
  const read: TreeRead = (_path, args) => (args[0] === "rev-parse" ? `${HEAD}\n` : "");

  /** A blocked work with one trusted, proven stop that used `execMs`, with or without a recorded PR. */
  function blockedWork(workId: string, execMs: number, withPr: boolean): void {
    newWork(workId);
    const reserved = store.reserveSession(workId, { jobId: "job", claimId: "claim" });
    if (!reserved.ok) throw new Error("reserve refused");
    store.closeSession(reserved.session.sessionId, { iterations: 3, execMs, stopCause: "max_reached" });
    store.recordStop({
      sessionId: reserved.session.sessionId, workId, adapter: "loop", stopCause: "max_reached", cessation: "proven",
      cessationCheck: null, head: HEAD, status: "", evidence: "unavailable", trusted: true, interrupted: false,
    });
    if (withPr) store.recordPullRequest(workId, { number: 12, head: HEAD, url: "https://github.com/rfcclub/anima/pull/12" });
    store.setState(workId, "blocked", "approval changed");
  }

  test("6. recovery of a work with a recorded PR is not refused for the spent work wall", async () => {
    blockedWork("wrevise0006", 1_900_000, true);
    const out = await recoverWork({ store, read }, { workId: "wrevise0006", caps: {}, base: HEAD });
    expect(out.state).toBe("checkpointed");
  });

  test("7. recovery of a work with NO recorded PR is still refused for the spent work wall", async () => {
    blockedWork("wrevise0007", 1_900_000, false);
    await expect(recoverWork({ store, read }, { workId: "wrevise0007", caps: {}, base: HEAD })).rejects.toThrow(/time limit/i);
  });

  test("8. the recovered retry of a work with a recorded PR is not refused as an exhausted budget", async () => {
    blockedWork("wrevise0008", 1_900_000, true);
    const recovered = await recoverWork({ store, read }, { workId: "wrevise0008", caps: {}, base: HEAD });
    const recovery = store.listEvents("wrevise0008").filter((event) => event.kind === "operator-recovery").at(-1)!;
    const out = store.enqueueRecoveredRevision({
      workId: "wrevise0008", root: recovered.root, generation: recovered.generation, head: HEAD, number: 12,
      recoverySeq: recovery.seq, failedJobId: "job", reviewers: [],
    });
    expect(out.inserted).toBe(true);
  });
});
