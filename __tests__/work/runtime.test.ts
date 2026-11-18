/**
 * castle-work-loop: the assembly of the work loop from its config block.
 */

import { test, expect } from "bun:test";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { buildWorkRuntime } from "../../src/work/runtime";
import type { MeshJobsWorkConfig } from "../../src/mesh-jobs/config";

const config: MeshJobsWorkConfig = {
  author: "finn", authorActor: "finn-gotako[bot]", authorMeshId: "finn-anima-1@mac", enqueuer: "bruno", base: "master",
  reviewers: [{ agent: "cleo", meshId: "cleo-anima-1@mac", login: "cleo-gotako[bot]" }],
  releaseBackoffMs: 30_000, reconcileIntervalMs: 60_000, perToolCallMs: 120_000, cloneUrl: "https://github.com/{repo}.git",
};

const fakes = (store: WorkStore, logs: string[] = []) => ({
  store,
  executor: { ready: () => ({ ok: true as const }), runSession: async () => { throw new Error("not used"); } },
  github: { pullRequest: async () => { throw new Error("x"); }, diff: async () => "", issue: async () => ({ title: "t", body: "b" }), reviews: async () => [] },
  workGithub: { findPullRequest: async () => null, pullRequest: async () => { throw new Error("x"); }, reviews: async () => [] },
  enqueuer: { enqueue: async () => ({ id: "j" }), confirm: async () => {} },
  heartbeatMs: 1000,
  log: (_l: string, message: string) => { logs.push(message); },
});

test("sessions a dead process left open are charged in full when the runtime is built", () => {
  const store = WorkStore.open(":memory:", { rootBase: "/w" });
  const w = store.createWork({ repo: "a/x", issue: 1, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
  store.reserveSession(w.workId, { jobId: "j", claimId: "c" });
  const logs: string[] = [];
  buildWorkRuntime(config, fakes(store, logs) as never);
  expect(store.getWork(w.workId)!.execMsUsed).toBe(10 * 60_000);
  expect(logs.join(" ")).toContain("charged in full");
  store.close();
});

test("a runtime from a config pins the author, and a missing evidence source is a refusal, not a pass", async () => {
  const store = WorkStore.open(":memory:", { rootBase: "/w" });
  const { reconciler } = buildWorkRuntime(config, fakes(store) as never);
  const w = store.createWork({ repo: "a/x", issue: 2, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({ author: "finn" }) }).work;
  expect(w.author).toBe("finn");
  expect(await reconciler.collectEvidence(w.workId)).toEqual({ ok: false, reason: expect.stringContaining("no pull request") });
  store.close();
});

test("the production module loads, and its deny-read list names only credential and state paths that exist", async () => {
  const { mkdtempSync, mkdirSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultDenyReadRoots } = await import("../../src/work/production");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "work-deny-")));
  expect(defaultDenyReadRoots(home)).toEqual([]);
  mkdirSync(join(home, ".ssh"));
  mkdirSync(join(home, ".anima", "secrets"), { recursive: true });
  expect(defaultDenyReadRoots(home)).toEqual([join(home, ".anima", "secrets"), join(home, ".ssh")]);
});

test("reviewFeedback returns the standing changes-requested text on the current head and nothing else", async () => {
  const { reviewFeedback } = await import("../../src/work/runtime");
  const head = "a".repeat(40);
  const github = {
    findPullRequest: async () => null, pullRequest: async () => { throw new Error("x"); },
    reviews: async () => [
      { id: 1, state: "CHANGES_REQUESTED", commitId: head, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "u", submittedAt: "t", body: "add a test for the empty case" },
      { id: 2, state: "CHANGES_REQUESTED", commitId: "b".repeat(40), authorLogin: "pia-gotako[bot]", authorType: "Bot", url: "u", submittedAt: "t", body: "old head, ignore" },
      { id: 3, state: "CHANGES_REQUESTED", commitId: head, authorLogin: "stranger", authorType: "User", url: "u", submittedAt: "t", body: "not a reviewer" },
    ],
  };
  const text = await reviewFeedback(github as never, { authorActor: "finn-gotako[bot]", reviewers: config.reviewers })({ repo: "a/x", prNumber: 12, prHead: head });
  expect(text).toContain("add a test for the empty case");
  expect(text).not.toContain("old head");
  expect(text).not.toContain("not a reviewer");
  expect(await reviewFeedback(github as never, config)({ repo: "a/x", prNumber: null, prHead: null })).toBe("");
});
