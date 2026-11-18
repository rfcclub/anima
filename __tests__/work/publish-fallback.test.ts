import { describe, expect, test } from "bun:test";
import { publishCommittedWork, type PublishFallbackDeps } from "../../src/work/publish-fallback";
import type { WorkRecord } from "../../src/work/store";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function work(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    workId: "w1", repo: "rfcclub/anima", issue: 7, approvedDigest: "abcdef123456",
    author: "finn", provider: "hypercharm", model: "glm-5.3", state: "running",
    generation: 1, branch: "work/7-w1", root: "/tmp/w1", caps: {} as WorkRecord["caps"],
    sessionsUsed: 0, iterationsUsed: 0, execMsUsed: 0, blockedReason: null,
    prNumber: null, prHead: null, prUrl: null, startJobId: null,
    createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  };
}

function deps(over: Partial<PublishFallbackDeps> = {}) {
  const calls: string[] = [];
  const gitCalls: string[] = [];
  const base: PublishFallbackDeps = {
    publish: async (_w, args) => {
      calls.push(String(args.action));
      if (args.action === "open_pr") return JSON.stringify({ status: "ok", url: "https://github.com/rfcclub/anima/pull/12" });
      return JSON.stringify({ status: "ok" });
    },
    findPullRequest: async () => null,
    issue: async () => ({ title: "Intent", body: "B" }),
    base: "master",
    git: (_cwd, args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "status") return "";
      if (args[0] === "symbolic-ref") return "refs/heads/work/7-w1\n";
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      if (args[0] === "rev-list") return "2\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    ...over,
  };
  return { deps: base, calls, gitCalls };
}

describe("publishCommittedWork", () => {
  test("a clean start-work branch ahead of base is pushed and gets a PR", async () => {
    const { deps: d, calls } = deps();
    const result = await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result.published).toBe(true);
    expect(calls).toEqual(["push", "open_pr"]);
  });

  test("a dirty tree is never published", async () => {
    const { deps: d, calls } = deps({ git: (_c, args) => args[0] === "status" ? " M file\n" : "" });
    const result = await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result.published).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an existing PR is left to the normal flow: no push, and not reported as published", async () => {
    const { deps: d, calls } = deps({ findPullRequest: async () => ({ number: 12 }) });
    const result = await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result).toEqual({ published: false, reason: "pull request already exists" });
    expect(calls).toEqual([]);
  });

  test("the commit checked is the work branch the push stages, not HEAD", async () => {
    const { deps: d, gitCalls } = deps();
    await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(gitCalls).toContain("rev-parse --verify refs/heads/work/7-w1^{commit}");
    expect(gitCalls).toContain("rev-list --count refs/heads/work/7-w1 --not master");
    expect(gitCalls.some((c) => c.split(" ").includes("HEAD") && c.startsWith("rev-"))).toBe(false);
  });

  test("a tree whose HEAD is not on the work branch is not published", async () => {
    const { deps: d, calls } = deps({
      git: (_c, args) => args[0] === "status" ? "" : args[0] === "symbolic-ref" ? "refs/heads/elsewhere\n" : `${HEAD}\n`,
    });
    const result = await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result.published).toBe(false);
    expect(result.reason).toContain("not on the work branch");
    expect(calls).toEqual([]);
  });

  test("a detached HEAD is not published", async () => {
    const { deps: d, calls } = deps({
      git: (_c, args) => { if (args[0] === "symbolic-ref") throw new Error("not a symbolic ref"); return args[0] === "status" ? "" : args[0] === "rev-list" ? "2\n" : `${HEAD}\n`; },
    });
    const result = await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result.published).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the guard handed to the publisher settles first, then checks lease and generation", async () => {
    const seen: Array<(() => void | Promise<void>) | undefined> = [];
    const order: string[] = [];
    const guard = () => { order.push("guard"); };
    const settledGuard = async () => { order.push("settled"); };
    const { deps: d } = deps({ publish: async (_w, args, g) => { seen.push(g); return JSON.stringify(args.action === "open_pr" ? { status: "ok", url: "u" } : { status: "ok" }); } });
    await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached", guard, settledGuard });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeDefined();
    order.length = 0;
    await seen[0]!();
    expect(order).toEqual(["settled", "guard"]);
  });

  test("the settled guard runs before the push and again before the PR, each time right before a write", async () => {
    const order: string[] = [];
    const settledGuard = async () => { order.push("settled"); };
    const { deps: d } = deps({ publish: async (_w, args) => { order.push(String(args.action)); return JSON.stringify(args.action === "open_pr" ? { status: "ok", url: "u" } : { status: "ok" }); } });
    await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached", settledGuard });
    expect(order).toEqual(["settled", "push", "settled", "open_pr"]);
  });

  test("a settled guard that rejects stops the write it precedes", async () => {
    let n = 0;
    const settledGuard = async () => { if (++n === 2) throw new Error("lease lost"); };
    const { deps: d, calls } = deps();
    await expect(publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached", settledGuard })).rejects.toThrow("lease lost");
    expect(calls).toEqual(["push"]); // the push went before the lease was seen lost; the PR did not
  });

  test("a guard that throws stops the publish before anything is written", async () => {
    const { deps: d, calls } = deps();
    const guard = () => { throw new Error("stale writer"); };
    await expect(publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached", guard })).rejects.toThrow("stale writer");
    expect(calls).toEqual([]);
  });

  test("a revise with no new head is not published", async () => {
    const { deps: d, calls } = deps({ git: (_c, args) => args[0] === "status" ? "" : args[0] === "symbolic-ref" ? "refs/heads/work/7-w1\n" : args[0] === "rev-parse" ? `${OLD}\n` : "0\n" });
    const result = await publishCommittedWork(d, {
      work: work({ prNumber: 12, prHead: OLD }), kind: "revise", stopCause: "done",
    });
    expect(result.published).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a revise with a new head pushes only", async () => {
    const { deps: d, calls } = deps();
    const result = await publishCommittedWork(d, {
      work: work({ prNumber: 12, prHead: OLD }), kind: "revise", stopCause: "done",
    });
    expect(result.published).toBe(true);
    expect(calls).toEqual(["push"]);
  });

  test("a failed push is reported and does not open a PR", async () => {
    const { deps: d, calls } = deps({
      publish: async (_w, args) => {
        calls.push(String(args.action));
        return JSON.stringify({ error: "push refused" });
      },
    });
    const result = await publishCommittedWork(d, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result.published).toBe(false);
    expect(calls).toEqual(["push"]);
  });
});

describe("publishCommittedWork: host publish of an uncommitted tree", () => {
  const dirty = (args: string[]) => (args[0] === "status" ? " M file\n?? new.ts\n" : undefined);
  const hostInput = { work: work(), kind: "start-work" as const, stopCause: "deadline" as const, limitTerminal: true };

  function host(result: Awaited<ReturnType<NonNullable<PublishFallbackDeps["hostPublish"]>>> | Error) {
    const calls: Array<{ stopCause: string; issueTitle: string; guard: boolean }> = [];
    const hostPublish: NonNullable<PublishFallbackDeps["hostPublish"]> = async (input) => {
      calls.push({ stopCause: input.stopCause, issueTitle: input.issue.title, guard: typeof input.guard === "function" });
      if (result instanceof Error) throw result;
      return result;
    };
    return { hostPublish, calls };
  }

  test("SC-006 a dirty limit-terminal start-work tree goes to the host publish and is reported as published with its facts", async () => {
    const h = host({ published: true, sha: "c".repeat(40), prOutput: "{}", checks: ["no-change", "tests"] });
    const { deps: d, calls } = deps({ hostPublish: h.hostPublish, git: (_c, args) => dirty(args) ?? "" });
    const result = await publishCommittedWork(d, hostInput);

    expect(result).toEqual({ published: true, host: { sha: "c".repeat(40), prOutput: "{}", checks: ["no-change", "tests"] } });
    expect(h.calls).toEqual([{ stopCause: "deadline", issueTitle: "Intent", guard: true }]);
    expect(calls).toEqual([]); // the model-facing publish path was not used
  });

  test("without a host publish the dirty tree is declined as before", async () => {
    const { deps: d } = deps({ git: (_c, args) => dirty(args) ?? "" });
    expect(await publishCommittedWork(d, hostInput)).toEqual({ published: false, reason: "working tree is not clean" });
  });

  test("only a limit-terminal start-work session in deadline or max_reached uses the host publish", async () => {
    for (const input of [
      { ...hostInput, limitTerminal: false },
      { ...hostInput, limitTerminal: undefined },
      { ...hostInput, kind: "revise" as const },
      { ...hostInput, stopCause: "done" as const },
      { ...hostInput, stopCause: "failed" as const },
    ]) {
      const h = host({ published: true, sha: "c".repeat(40), prOutput: "{}", checks: [] });
      const { deps: d } = deps({ hostPublish: h.hostPublish, git: (_c, args) => dirty(args) ?? "" });
      expect(await publishCommittedWork(d, input as never)).toEqual({ published: false, reason: "working tree is not clean" });
      expect(h.calls).toHaveLength(0);
    }
  });

  test("SC-025 an existing pull request is not a decline and the host publish does not run", async () => {
    const h = host({ published: true, sha: "c".repeat(40), prOutput: "{}", checks: [] });
    const { deps: d } = deps({ hostPublish: h.hostPublish, findPullRequest: async () => ({ number: 12 }), git: (_c, args) => dirty(args) ?? "" });
    expect(await publishCommittedWork(d, hostInput)).toEqual({ published: false, reason: "pull request already exists" });
    expect(h.calls).toHaveLength(0);
  });

  test("SC-021 a failed check is returned by name", async () => {
    const h = host({ published: false, reason: "tests-failed", pushed: false });
    const { deps: d } = deps({ hostPublish: h.hostPublish, git: (_c, args) => dirty(args) ?? "" });
    expect(await publishCommittedWork(d, hostInput)).toEqual({ published: false, reason: "tests-failed" });
  });

  test("SC-027 a pushed branch without a pull request is reported with the recorded reason, whichever result produced it", async () => {
    for (const reason of ["pr-create-failed (branch pushed)", "error"]) {
      const h = host({ published: false, reason, pushed: true, sha: "d".repeat(40) });
      const { deps: d } = deps({ hostPublish: h.hostPublish, git: (_c, args) => dirty(args) ?? "" });
      expect(await publishCommittedWork(d, hostInput))
        .toEqual({ published: false, reason: "pr-create-failed (branch pushed)", hostPushed: true, hostSha: "d".repeat(40) });
    }
  });

  test("SC-023 a lost lease thrown by the host publish propagates", async () => {
    const h = host(new Error("lease lost"));
    const { deps: d } = deps({ hostPublish: h.hostPublish, git: (_c, args) => dirty(args) ?? "" });
    await expect(publishCommittedWork(d, hostInput)).rejects.toThrow("lease lost");
  });

  test("a clean tree is not sent to the host publish", async () => {
    const h = host({ published: true, sha: "c".repeat(40), prOutput: "{}", checks: [] });
    const { deps: d, calls } = deps({ hostPublish: h.hostPublish });
    const result = await publishCommittedWork(d, hostInput);
    expect(result.published).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect(calls).toEqual(["push", "open_pr"]);
  });
});
