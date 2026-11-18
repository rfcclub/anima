/**
 * castle-work-loop: the production publisher over the existing GitHub App tool. A recording
 * stand-in for the tool; nothing reaches GitHub.
 */

import { test, expect, describe } from "bun:test";
import { createPublisher } from "../../src/work/publish";
import type { WorkRecord } from "../../src/work/store";

const work = { workId: "wabc1234ef0", repo: "rfcclub/anima", issue: 7, author: "finn", branch: "work/7-wabc1234ef0", root: "/w/rfcclub/anima/wabc1234ef0" } as WorkRecord;

const STAGING = "/w/rfcclub/anima/wabc1234ef0.push.git";
const SHA = "c".repeat(40);

function rig(over: {
  stage?: () => { dir: string; sha: string };
  stageExisting?: () => { dir: string; sha: string };
  handle?: () => Promise<string>;
} = {}) {
  const calls: Array<{ args: Record<string, unknown>; ctx: any }> = [];
  const recorded: string[] = [];
  let stageCalls = 0;
  let existingCalls = 0;
  const publish = createPublisher({
    base: "master",
    stage: over.stage ?? (() => { stageCalls += 1; return { dir: STAGING, sha: SHA }; }),
    stageExisting: over.stageExisting ?? (() => { existingCalls += 1; return { dir: STAGING, sha: SHA }; }),
    record: (_work, sha) => { recorded.push(sha); },
    handle: async (args, ctx) => {
      calls.push({ args, ctx });
      return over.handle ? over.handle() : JSON.stringify({ status: "ok", number: 12, url: "https://github.com/rfcclub/anima/pull/12" });
    },
  });
  return { calls, recorded, publish, get stageCalls() { return stageCalls; }, get existingCalls() { return existingCalls; } };
}

describe("publisher", () => {
  test("push publishes the work's own branch from the host-owned staging repository, whatever the model says", async () => {
    const { calls, publish } = rig();
    await publish(work, { action: "push", branch: "master", dir: "/etc", repo: "rfcclub/other" });
    expect(calls[0]!.args).toEqual({ action: "push", repo: "rfcclub/anima", branch: "work/7-wabc1234ef0", dir: STAGING });
    expect(calls[0]!.ctx.agentName).toBe("finn");
    expect(calls[0]!.ctx.policy.allowedTools).toEqual(["anima_github"]);
    expect(calls[0]!.ctx.policy.allowedRoots).toEqual([STAGING]);
  });

  test("a successful push is noted against the staged commit; a failed one is not", async () => {
    const ok = rig();
    await ok.publish(work, { action: "push" });
    expect(ok.recorded).toEqual([SHA]);
    const bad = rig({ handle: async () => "Error: push failed (1): rejected" });
    expect(await bad.publish(work, { action: "push" })).toContain("push failed");
    expect(bad.recorded).toEqual([]);
  });

  test("when the branch cannot be staged nothing is pushed", async () => {
    const { calls, publish } = rig({ stage: () => { throw new Error("fetch failed"); } });
    expect(await publish(work, { action: "push" })).toMatch(/could not stage.*fetch failed/);
    expect(calls.length).toBe(0);
  });

  test("open_pr uses the work branch as head and the configured base, and needs the issue link", async () => {
    const { calls, publish } = rig();
    const out = await publish(work, { action: "open_pr", title: "Add the thing", body: "What and why.\n\nCloses #7", head: "other", base: "release" });
    expect(calls[0]!.args).toEqual({ action: "pr_create", repo: "rfcclub/anima", head: "work/7-wabc1234ef0", base: "master", title: "Add the thing", body: "What and why.\n\nCloses #7" });
    expect(JSON.parse(out).number).toBe(12);
  });

  test("SC-018: openDraftPr sends a draft PR for the work branch and configured base", async () => {
    const { calls, publish } = rig();
    const out = await publish.openDraftPr(work, { title: "Add the thing", body: "What and why.\n\nCloses #7" });
    expect(calls[0]!.args).toEqual({ action: "pr_create", repo: "rfcclub/anima", head: "work/7-wabc1234ef0", base: "master", title: "Add the thing", body: "What and why.\n\nCloses #7", draft: true });
    expect(JSON.parse(out).number).toBe(12);
    expect(calls[0]!.ctx.agentName).toBe("finn");
  });

  test.each([
    [{ title: " ", body: "Closes #7" }, /title must be a non-empty string of at most 256 characters/],
    [{ title: "x".repeat(257), body: "Closes #7" }, /title must be a non-empty string of at most 256 characters/],
    [{ title: "t", body: "no link" }, /the pull request body must contain "Closes #7"/],
    [{ title: "t", body: "Closes #8" }, /the pull request body must contain "Closes #7"/],
    [{ title: "t", body: `Closes #7${"x".repeat(60_000)}` }, /the pull request body must contain "Closes #7"/],
  ])("SC-018: openDraftPr validates title and body %#", async (args, message) => {
    const { calls, publish } = rig();
    expect(await publish.openDraftPr(work, args)).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  test("SC-018: openDraftPr runs the guard before requesting the draft PR", async () => {
    const events: string[] = [];
    const publish = createPublisher({
      base: "master",
      handle: async (args) => { events.push(`request:${String(args.draft)}`); return "ok"; },
    });
    await publish.openDraftPr(work, { title: "Add the thing", body: "Closes #7" }, () => { events.push("guard"); });
    expect(events).toEqual(["guard", "request:true"]);
  });

  test("SC-019: open_pr ignores a model-supplied draft argument", async () => {
    const { calls, publish } = rig();
    await publish(work, { action: "open_pr", title: "Add the thing", body: "Closes #7", draft: true });
    expect(calls[0]!.args).not.toHaveProperty("draft");
  });

  test.each([
    [{ action: "open_pr", title: "t", body: "no link" }, /Closes #7/],
    [{ action: "open_pr", title: "t", body: "Closes #8" }, /Closes #7/],
    [{ action: "open_pr", body: "Closes #7" }, /title/],
    [{ action: "open_pr", title: "x".repeat(300), body: "Closes #7" }, /title/],
    [{ action: "merge", number: 12 }, /unknown publish action/],
    [{ action: "approve_intent", issue: 7 }, /unknown publish action/],
    [{ action: "review", pr: 12, event: "APPROVE" }, /unknown publish action/],
    [{}, /unknown publish action/],
  ])("%j is refused without calling the tool", async (args, message) => {
    const { calls, publish } = rig();
    const out = await publish(work, args as Record<string, unknown>);
    expect(out).toMatch(message);
    expect(calls.length).toBe(0);
  });
});

describe("publisher: host push of the staging repository as it is", () => {
  test("pushHostStaged pushes the staging repository as it is, without staging the author's branch", async () => {
    const r = rig();
    await r.publish.pushHostStaged(work);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.args).toEqual({ action: "push", repo: "rfcclub/anima", branch: "work/7-wabc1234ef0", dir: STAGING });
    expect(r.calls[0]!.ctx.agentName).toBe("finn");
    expect(r.calls[0]!.ctx.policy.allowedRoots).toEqual([STAGING]);
    expect(r.stageCalls).toBe(0);
    expect(r.existingCalls).toBe(1);
  });

  test("a successful host push is not noted against the staging repository's commit", async () => {
    const r = rig();
    await r.publish.pushHostStaged(work);
    expect(r.recorded).toEqual([]);
  });

  test("a failing host push returns the tool output unchanged", async () => {
    const r = rig({ handle: async () => "Error: push failed (1): rejected" });
    expect(await r.publish.pushHostStaged(work)).toBe("Error: push failed (1): rejected");
  });

  test("when the host branch cannot be read from the staging repository nothing is pushed", async () => {
    const r = rig({ stageExisting: () => { throw new Error("no head"); } });
    expect(await r.publish.pushHostStaged(work)).toMatch(/could not stage the host branch.*no head/);
    expect(r.calls).toHaveLength(0);
  });

  test("a guard that throws stops the host push before anything is staged or pushed", async () => {
    const r = rig();
    const out = await r.publish.pushHostStaged(work, () => { throw new Error("lease lost"); });
    expect(out).toBe("Error: lease lost");
    expect(r.existingCalls).toBe(0);
    expect(r.calls).toHaveLength(0);
  });

  test("the model-facing publish cannot reach the host push", async () => {
    const r = rig();
    expect(await r.publish(work, { action: "pushHostStaged" })).toMatch(/unknown publish action/);
    expect(r.calls).toHaveLength(0);
  });
});

