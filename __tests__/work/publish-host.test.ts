/**
 * The real bindings of the host publish run: real Git in temporary directories, a fake
 * publisher and a fake test runner. Nothing reaches GitHub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostPublish, gitSubcommand, sandboxedFetchSpawn, spawnGitSync, type HostPublishDeps } from "../../src/work/publish-host";
import { SANDBOX_BINARY } from "../../src/work/sandbox";
import type { TestOutcome } from "../../src/work/publish-tests";
import type { WorkRecord } from "../../src/work/store";

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH ?? "" };
const run = (cwd: string, args: string[]): string => spawnGitSync(args, { cwd, env: GIT_ENV });
const COMMITTER = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

let tmp: string;
let root: string;
let tree: string;
let base: string;
let work: WorkRecord;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "publish-host-")));
  const origin = join(tmp, "origin");
  mkdirSync(origin);
  run(origin, ["init", "-q", "."]);
  writeFileSync(join(origin, "base.txt"), "base\n");
  run(origin, ["add", "."]);
  run(origin, [...COMMITTER, "commit", "-q", "-m", "base"]);
  base = run(origin, ["rev-parse", "HEAD"]).trim();

  root = join(tmp, "work", "w0123456");
  mkdirSync(join(tmp, "work"), { recursive: true });
  run(tmp, ["clone", "-q", "--separate-git-dir", join(root, "git"), origin, join(root, "tree")]);
  tree = join(root, "tree");
  run(tree, ["checkout", "-q", "-b", "work/7-w0123456"]);
  work = {
    workId: "w0123456", repo: "rfcclub/anima", issue: 7, branch: "work/7-w0123456", root,
    execMsUsed: 1_801_000, sessionsUsed: 3,
    caps: { maxSessions: 9, maxIterationsPerSession: 40, sessionWallMs: 600_000, workWallMs: 1_800_000 },
  } as unknown as WorkRecord;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeChange(): void {
  mkdirSync(join(tree, "src"), { recursive: true });
  mkdirSync(join(tree, "__tests__"), { recursive: true });
  mkdirSync(join(tree, "openspec", "changes", "c1"), { recursive: true });
  writeFileSync(join(tree, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(tree, "__tests__", "x.test.ts"), "// test\n");
  writeFileSync(join(tree, "openspec", "changes", "c1", ".orca-verify.json"), "{}\n");
}

interface Rig {
  deps: HostPublishDeps;
  pushed: Array<{ branchSha: string; files: string[]; message: string; parent: string }>;
  prs: Array<{ title: string; body: string }>;
  testRuns: Array<{ argv: string[]; cwd: string }>;
}

function rig(options: { tests?: (argv: string[]) => Promise<TestOutcome>; pushOutput?: string } = {}): Rig {
  const bare = `${root}.push.git`;
  const state: Rig = { deps: undefined as unknown as HostPublishDeps, pushed: [], prs: [], testRuns: [] };
  state.deps = {
    baseSha: () => base,
    runTests: async (argv, cwd) => {
      state.testRuns.push({ argv, cwd });
      return options.tests ? options.tests(argv) : { ok: true, output: " 1 pass\n 0 fail\n" };
    },
    publisher: {
      pushHostStaged: async () => {
        const sha = run(bare, ["rev-parse", "refs/heads/work/7-w0123456"]).trim();
        state.pushed.push({
          branchSha: sha,
          files: run(bare, ["ls-tree", "-r", "--name-only", sha]).trim().split("\n"),
          message: run(bare, ["log", "-1", "--format=%s|%cn", sha]).trim(),
          parent: run(bare, ["rev-parse", `${sha}^`]).trim(),
        });
        return options.pushOutput ?? JSON.stringify({ status: "ok" });
      },
      openDraftPr: async (_work, args) => {
        state.prs.push({ title: String(args.title), body: String(args.body) });
        return JSON.stringify({ status: "ok", number: 12, url: "https://github.com/rfcclub/anima/pull/12" });
      },
    },
  };
  return state;
}

const input = (guard: () => Promise<void> = async () => {}) => ({
  work, stopCause: "deadline" as const, guard,
  issue: { title: "Add the thing", body: "Do it.\n\nbun test __tests__/x.test.ts\n" },
});

describe("createHostPublish (real Git)", () => {
  test("SC-006 an uncommitted change is committed by the host, pushed from the staging repository and opened as a draft", async () => {
    writeChange();
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toMatchObject({ published: true });
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]!.files.sort()).toEqual(["__tests__/x.test.ts", "base.txt", "src/x.ts"]);
    expect(r.pushed[0]!.message).toBe("Host-published work for #7 (w0123456)|ANIMA host publish");
    expect(r.pushed[0]!.parent).toBe(base);
    expect(r.testRuns).toHaveLength(1);
    expect(r.testRuns[0]!.argv).toEqual(["bun", "test", "./__tests__/x.test.ts"]);
    expect(r.testRuns[0]!.cwd).toBe(tree);
    expect(r.prs).toHaveLength(1);
    expect(r.prs[0]!.title).toBe("[host-published] Add the thing");
    expect(r.prs[0]!.body).toContain("Closes #7");
    expect(r.prs[0]!.body).toContain("<!-- host-published work=w0123456 -->");
    expect(r.prs[0]!.body).toContain("bun test ./__tests__/x.test.ts");
    expect(r.prs[0]!.body).toContain("1 generated files left out");
  });

  test("SC-012 failing tests publish nothing and name the check", async () => {
    writeChange();
    const r = rig({ tests: async () => ({ ok: false, check: "tests-failed", output: "boom" }) });
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "tests-failed", pushed: false });
    expect(r.pushed).toHaveLength(0);
    expect(r.prs).toHaveLength(0);
  });

  test("SC-009 a workflow file is refused before any test runs", async () => {
    writeChange();
    mkdirSync(join(tree, ".github", "workflows"), { recursive: true });
    writeFileSync(join(tree, ".github", "workflows", "ci.yml"), "on: push\n");
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "denied-path", pushed: false });
    expect(r.testRuns).toHaveLength(0);
    expect(r.pushed).toHaveLength(0);
  });

  test("SC-031 a test that writes into the work tree is refused as tree-changed", async () => {
    writeChange();
    const r = rig({
      tests: async () => {
        writeFileSync(join(tree, "src", "planted.ts"), "export const p = 1;\n");
        return { ok: true, output: " 1 pass\n" };
      },
    });
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "tree-changed", pushed: false });
    expect(r.pushed).toHaveLength(0);
  });

  test("SC-032 and SC-033: a filter and fsmonitor planted in the author's Git directory and .gitattributes never run", async () => {
    writeChange();
    const marker = join(tmp, "marker");
    writeFileSync(join(tree, ".gitattributes"), "* filter=evil\n");
    run(tree, ["config", "filter.evil.clean", `touch ${marker}; cat`]);
    run(tree, ["config", "core.fsmonitor", `touch ${marker}`]);
    mkdirSync(join(root, "git", "hooks"), { recursive: true });
    writeFileSync(join(root, "git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toMatchObject({ published: true });
    expect(existsSync(marker)).toBe(false);
  });

  test("SC-011 a secret in a file the work tree stores in another encoding is scanned as the committed blob, not the raw bytes", async () => {
    writeChange();
    writeFileSync(join(tree, ".gitattributes"), "notes.txt working-tree-encoding=UTF-16LE\n");
    writeFileSync(join(tree, "notes.txt"), Buffer.from("token = ghp_" + "a".repeat(36) + "\n", "utf16le"));
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "secret-found", pushed: false });
    expect(r.testRuns).toHaveLength(0);
    expect(r.pushed).toHaveLength(0);
  });

  test("SC-011 a file named like an index stage (0:a) is scanned as its own blob, not as another file's", async () => {
    writeChange();
    writeFileSync(join(tree, "a"), "harmless\n");
    writeFileSync(join(tree, "0:a"), "token = ghp_" + "a".repeat(36) + "\n");
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "secret-found", pushed: false });
    expect(r.testRuns).toHaveLength(0);
    expect(r.pushed).toHaveLength(0);
  });

  test("SC-011 a file that changes between the kept and the unfiltered snapshot is scanned as committed, not as it is afterwards", async () => {
    writeChange();
    writeFileSync(join(tree, "src", "s.txt"), "token = ghp_" + "a".repeat(36) + "\n");
    const r = rig();
    let readTrees = 0;
    r.deps.spawnGit = (args, options) => {
      if (args.includes("read-tree") && ++readTrees === 2) writeFileSync(join(tree, "src", "s.txt"), "harmless\n");
      return spawnGitSync(args, options);
    };
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "secret-found", pushed: false });
    expect(r.testRuns).toHaveLength(0);
    expect(r.pushed).toHaveLength(0);
  });

  test("a hooks directory that is not empty stops the publish before anything runs", async () => {
    writeChange();
    mkdirSync(`${root}.empty-hooks`, { recursive: true });
    writeFileSync(join(`${root}.empty-hooks`, "pre-commit"), "#!/bin/sh\n");
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toMatchObject({ published: false, reason: "error", pushed: false });
    expect(r.testRuns).toHaveLength(0);
    expect(r.pushed).toHaveLength(0);
  });

  test("an encoding attribute that Git cannot apply to a file stops the publish (fail closed), nothing is pushed", async () => {
    writeChange();
    writeFileSync(join(tree, ".gitattributes"), "*.txt working-tree-encoding=UTF-16LE\n");
    writeFileSync(join(tree, "notes.txt"), "plain ascii, not UTF-16\n");
    const r = rig();
    const result = await createHostPublish(r.deps)(input());

    expect(result).toMatchObject({ published: false, reason: "error", pushed: false });
    expect(r.pushed).toHaveLength(0);
    expect(r.testRuns).toHaveLength(0);
  });

  test("SC-023 a lost lease propagates and nothing is pushed", async () => {
    writeChange();
    const r = rig();
    let calls = 0;
    await expect(createHostPublish(r.deps)(input(async () => { if (++calls === 3) throw new Error("lease lost"); })))
      .rejects.toThrow("lease lost");
    expect(r.pushed).toHaveLength(0);
    expect(r.prs).toHaveLength(0);
  });

  test("a push that is not ok stops before the pull request", async () => {
    writeChange();
    const r = rig({ pushOutput: "Error: rejected" });
    const result = await createHostPublish(r.deps)(input());

    expect(result).toEqual({ published: false, reason: "error", pushed: false });
    expect(r.prs).toHaveLength(0);
  });
});

describe("sandboxedFetchSpawn", () => {
  const sandboxed = existsSync(SANDBOX_BINARY) ? test : test.skip;

  sandboxed("a fetch runs under the write sandbox: it can fill the staging repository and nothing else", async () => {
    const calls: string[][] = [];
    const spawn = sandboxedFetchSpawn({ denyReadRoots: [], inner: (args, options) => { calls.push(args); return spawnGitSync(args, options); } });
    const bare = join(tmp, "stage.git");
    run(tmp, ["init", "--bare", "-q", "--template=", bare]);
    const env = { ...GIT_ENV, GIT_TERMINAL_PROMPT: "0" };

    spawn(["--git-dir", bare, "-c", "protocol.file.allow=always", "fetch", "-q", "--no-tags", "--no-write-fetch-head", join(root, "git"), `${base}:refs/host/base`], { cwd: root, env });

    expect(run(bare, ["rev-parse", "refs/host/base"]).trim()).toBe(base);
    expect(calls).toHaveLength(0); // the fetch did not go through the plain runner
  });

  test("only the Git subcommand decides: an argument that merely equals fetch does not", () => {
    expect(gitSubcommand(["--git-dir", "/x", "-c", "protocol.file.allow=always", "fetch", "-q"])).toBe("fetch");
    expect(gitSubcommand(["--git-dir", "/x", "config", "fetch"])).toBe("config");
    expect(gitSubcommand(["--git-dir", "/x", "-c", "fetch", "rev-parse"])).toBe("rev-parse");
    const calls: string[][] = [];
    const spawn = sandboxedFetchSpawn({ denyReadRoots: [], inner: (args) => { calls.push(args); return "ok"; } });
    expect(spawn(["--git-dir", "/x", "config", "fetch"], { cwd: "/", env: {} })).toBe("ok");
    expect(spawn(["--git-dir", "/x", "-c", "fetch", "rev-parse"], { cwd: "/", env: {} })).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("every other Git command goes through the plain runner", () => {
    const calls: string[][] = [];
    const spawn = sandboxedFetchSpawn({ denyReadRoots: [], inner: (args) => { calls.push(args); return "ok"; } });
    expect(spawn(["--git-dir", "/x", "rev-parse", "HEAD"], { cwd: "/", env: {} })).toBe("ok");
    expect(spawn(["init", "--bare", "/x"], { cwd: "/", env: {} })).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});
