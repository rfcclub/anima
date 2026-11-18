/**
 * The work loop assumed one base branch for every repo. Each repo it serves may name its own base;
 * a repo without an entry keeps `work.base`, and every consumer (workspace, publisher, reconciler, publish
 * fallback) resolves the same per-repo base. A wrong base still fails closed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeshJobsConfig } from "../../src/mesh-jobs/config";
import { baseForRepo } from "../../src/work/config";
import { createSessionExecutor, type ExecutorDeps } from "../../src/work/executor";
import { createPublisher } from "../../src/work/publish";
import { publishCommittedWork, type PublishFallbackDeps } from "../../src/work/publish-fallback";
import { Reconciler, type ReconcilerConfig } from "../../src/work/reconciler";
import { verifyPullRequest } from "../../src/work/evidence";
import { WorkStore, type WorkRecord } from "../../src/work/store";

const GARDEN = "rfcclub/garden-hub";
const HEAD = "a".repeat(40);

let dir: string;
let path: string;

function write(value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, 0o600);
}

function valid(work: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayUrl: "http://127.0.0.1:1526",
    workers: [{ agent: "finn" }],
    work: {
      enabled: true, author: "finn", authorActor: "finn-gotako[bot]", authorMeshId: "finn@anima", enqueuer: "finn",
      base: "master", reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }], ...work,
    },
  };
}

function errorOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a throw");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "work-repo-base-"));
  path = join(dir, "mesh-jobs.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("work.repoBases", () => {
  test("a repo's own base is kept, keyed by its normalised name", () => {
    write(valid({ repoBases: { "RFCClub/Garden-Hub": "main", "rfcclub/anima": "develop" } }));
    expect(loadMeshJobsConfig(path)!.work!.repoBases).toEqual({ "rfcclub/garden-hub": "main", "rfcclub/anima": "develop" });
  });

  test("absent means every repo uses work.base", () => {
    write(valid());
    expect(loadMeshJobsConfig(path)!.work!.repoBases).toBeUndefined();
    expect(baseForRepo(undefined, "master", GARDEN)).toBe("master");
  });

  test.each([
    ["a bare branch", "main"],
    ["an array", ["main"]],
    ["a repo without an owner", { "garden-hub": "main" }],
    ["a repo with a path segment", { "rfcclub/../garden-hub": "main" }],
    ["an empty branch", { [GARDEN]: "" }],
    ["a non-string branch", { [GARDEN]: 7 }],
    ["a branch ending in .lock", { [GARDEN]: "main.lock" }],
    ["a branch with a range", { [GARDEN]: "ma..in" }],
    ["a branch ending in a dot", { [GARDEN]: "main." }],
    ["a branch with an empty component", { [GARDEN]: "foo//bar" }],
    ["a component ending in .lock", { [GARDEN]: "release.lock/hotfix" }],
    ["a component starting with a dot", { [GARDEN]: "release/.hidden" }],
    ["the same repo twice in another case", { [GARDEN]: "main", "rfcclub/GARDEN-HUB": "develop" }],
  ])("%s is rejected, naming the field and not the value", (_name, value) => {
    write(valid({ repoBases: value }));
    const message = errorOf(() => loadMeshJobsConfig(path));
    expect(message).toMatch(/mesh jobs config: invalid work\.repoBases/);
    expect(message).not.toContain("garden-hub");
  });
});

describe("work.repoBases branch names follow git's ref rules", () => {
  const candidates = [
    "main", "develop", "release/1.2", "feature/a-b_c", "a.b", "a./b", "v1.0.0", "x/y/z", "main.", "foo//bar", "release.lock/hotfix",
    "release/.hidden", ".hidden", "a/b.lock", "a..b", "a/", "x.lock", "dir/x.lock/y", "a/b./c.", "9lives",
  ];
  test.each(candidates)("%s is accepted exactly when git check-ref-format accepts it", (branch) => {
    const git = Bun.spawnSync(["git", "check-ref-format", "--branch", branch]).exitCode === 0;
    write(valid({ repoBases: { [GARDEN]: branch } }));
    let accepted = true;
    try { loadMeshJobsConfig(path); } catch { accepted = false; }
    expect(accepted).toBe(git);
  });
});

describe("baseForRepo", () => {
  const repoBases = { [GARDEN]: "main" };

  test("a repo with an entry gets its own base", () => {
    expect(baseForRepo(repoBases, "master", GARDEN)).toBe("main");
  });

  test("the repository name is matched without regard to case", () => {
    expect(baseForRepo(repoBases, "master", "RFCClub/Garden-Hub")).toBe("main");
  });

  test("a repo without an entry keeps the configured default", () => {
    expect(baseForRepo(repoBases, "master", "rfcclub/anima")).toBe("master");
  });
});

function work(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    workId: "w372", repo: GARDEN, issue: 11, approvedDigest: "abcdef123456", author: "finn",
    provider: "agnes", model: "agnes-3.0-flash", state: "running", generation: 1,
    branch: "work/11-w372", root: "/w/garden/w372", caps: {} as WorkRecord["caps"],
    sessionsUsed: 0, iterationsUsed: 0, execMsUsed: 0, blockedReason: null,
    prNumber: null, prHead: null, prUrl: null, startJobId: null,
    createdAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z",
    ...over,
  };
}

describe("consumers resolve the same per-repo base", () => {
  test("the session executor prepares the workspace from the repo's own base", async () => {
    const store = WorkStore.open(":memory:", { rootBase: "/w" });
    try {
      const created = store.createWork({
        repo: GARDEN, issue: 11, approvedDigest: "d1d1d1d1d1d1",
        config: { author: "finn", provider: "agnes", model: "agnes-3.0-flash", externalAdapter: "off", caps: { maxSessions: 3, maxIterationsPerSession: 5, sessionWallMs: 600_000, workWallMs: 1_800_000 } },
      }).work;
      const bases: Array<string | undefined> = [];
      const deps: ExecutorDeps = {
        store, sessionStore: {} as never, sessionManager: {} as never,
        createProvider: async () => { throw new Error("not used"); },
        loadIdentity: async (name) => ({ name, label: name }),
        issue: async () => ({ title: "T", body: "B" }),
        cloneSource: () => "/clones/garden",
        base: "master", repoBases: { [GARDEN]: "main" },
        prepare: async (input) => {
          bases.push(input.base);
          throw new Error("stop after recording the base");
        },
      };
      const executor = createSessionExecutor(deps);
      await expect(executor.runSession({ work: created, kind: "start-work", maxIterations: 5, deadlineMs: 60_000, signal: new AbortController().signal })).rejects.toThrow("stop after recording the base");
      expect(bases).toEqual(["main"]);
    } finally {
      store.close();
    }
  });

  test("the publisher opens the pull request against the repo's own base", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const publish = createPublisher({
      base: "master", repoBases: { [GARDEN]: "main" },
      stage: () => ({ dir: "/w/stage.git", sha: HEAD }),
      record: () => {},
      handle: async (args) => { calls.push(args); return JSON.stringify({ status: "ok" }); },
    });
    await publish(work(), { action: "open_pr", title: "T", body: "Closes #11" });
    expect(calls[0]).toMatchObject({ action: "pr_create", base: "main", head: "work/11-w372" });
  });

  test("the reconciler accepts a pull request based on the repo's own base", async () => {
    const store = WorkStore.open(":memory:", { rootBase: "/w" });
    try {
      const created = store.createWork({ repo: GARDEN, issue: 11, approvedDigest: "d1d1d1d1d1d1", config: { author: "finn", provider: "agnes", model: "agnes-3.0-flash", externalAdapter: "off", caps: { maxSessions: 3, maxIterationsPerSession: 5, sessionWallMs: 600_000, workWallMs: 1_800_000 } } }).work;
      store.setState(created.workId, "running");
      const config: ReconcilerConfig = {
        base: "master", repoBases: { [GARDEN]: "main" }, authorActor: "finn-gotako[bot]", authorMeshIds: ["finn@anima"],
        reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }], retryBackoffMs: 60_000,
      };
      const pr = (baseRef: string) => ({
        repo: GARDEN, number: 12, url: "https://github.com/rfcclub/garden-hub/pull/12", state: "open" as const, merged: false,
        headSha: HEAD, headRef: created.branch, baseRef, body: "Closes #11", authorLogin: "finn-gotako[bot]",
      });
      const run = async (baseRef: string) => {
        const reconciler = new Reconciler({
          store, config, now: () => 1_000_000,
          github: { findPullRequest: async () => pr(baseRef), pullRequest: async () => { throw new Error("x"); }, reviews: async () => [] } as never,
          mesh: { enqueue: async () => ({ id: "j" }), confirm: async () => {} },
        });
        return reconciler.collectEvidence(created.workId);
      };
      expect(await run("main")).toEqual({ ok: true, url: pr("main").url });
      expect(await run("master")).toEqual({ ok: false, reason: expect.stringContaining("pull request base is master") });
    } finally {
      store.close();
    }
  });

  test("the publish fallback measures the branch against the repo's own base", async () => {
    const gitCalls: string[] = [];
    const deps: PublishFallbackDeps = {
      publish: async (_w, args) => JSON.stringify({ status: "ok", action: args.action }),
      findPullRequest: async () => null,
      issue: async () => ({ title: "T", body: "B" }),
      base: "master", repoBases: { [GARDEN]: "main" },
      git: (_cwd, args) => {
        gitCalls.push(args.join(" "));
        if (args[0] === "status") return "";
        if (args[0] === "symbolic-ref") return "refs/heads/work/11-w372\n";
        if (args[0] === "rev-parse") return `${HEAD}\n`;
        if (args[0] === "rev-list") return "2\n";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    };
    const result = await publishCommittedWork(deps, { work: work(), kind: "start-work", stopCause: "max_reached" });
    expect(result.published).toBe(true);
    expect(gitCalls).toContain("rev-list --count refs/heads/work/11-w372 --not main");
  });

  test("a repo with no entry still uses work.base everywhere", async () => {
    const deps: PublishFallbackDeps = {
      publish: async (_w, args) => JSON.stringify({ status: "ok", action: args.action }),
      findPullRequest: async () => null,
      issue: async () => ({ title: "T", body: "B" }),
      base: "master", repoBases: { [GARDEN]: "main" },
      git: (_cwd, args) => {
        if (args[0] === "status") return "";
        if (args[0] === "symbolic-ref") return "refs/heads/work/11-w372\n";
        if (args[0] === "rev-parse") return `${HEAD}\n`;
        if (args[0] === "rev-list") return "2\n";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    };
    const calls: Array<Record<string, unknown>> = [];
    const publish = createPublisher({
      base: "master", repoBases: { [GARDEN]: "main" },
      stage: () => ({ dir: "/w/stage.git", sha: HEAD }),
      record: () => {},
      handle: async (args) => { calls.push(args); return JSON.stringify({ status: "ok" }); },
    });
    await publish(work({ repo: "rfcclub/anima", branch: "work/7-w372" }), { action: "open_pr", title: "T", body: "Closes #11" });
    expect(calls[0]).toMatchObject({ base: "master" });
    expect(verifyPullRequest(work({ repo: "rfcclub/anima", branch: "work/7-w372" }), {
      repo: "rfcclub/anima", number: 3, url: "https://github.com/rfcclub/anima/pull/3", state: "open", merged: false,
      headSha: HEAD, headRef: "work/7-w372", baseRef: "master", body: "Closes #11", authorLogin: "finn-gotako[bot]",
    }, { base: baseForRepo(deps.repoBases, deps.base, "rfcclub/anima"), authorActor: "finn-gotako[bot]" })).toEqual({ ok: true });
  });
});
