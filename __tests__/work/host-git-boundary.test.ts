import { seatbeltDescribe } from "../helpers/seatbelt";
/**
 * castle-work-loop: the author can write the work's Git directory, so nothing the
 * host runs may trust it. Real git against local repositories in a temp directory; nothing else is touched.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { prepareWorkspace, isDirty, readTreeGit, stageBranchForPush, recordPushed } from "../../src/work/workspace";
import { completeWork } from "../../src/work/complete";
import type { StopRecord, WorkRecord } from "../../src/work/store";
import { gitInTree } from "../../src/work/production";

let tmp: string;
let source: string;
let remote: string;
let n = 0;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const under = (path: string, root: string) => (realpathSync(path) + sep).startsWith(realpathSync(root) + sep);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "work-hgb-")));
  source = join(tmp, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "README.md"), "hello\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "first");
  remote = join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", remote);
});

async function workspace() {
  const root = join(tmp, "work", "a", "x", `w${++n}`);
  const branch = `work/7-w${n}`;
  return { root, branch, ws: await prepareWorkspace({ root, source, branch }) };
}

seatbeltDescribe("git run by the host on the author's tree", () => {
  test("the publish fallback refuses status before a planted clean filter runs", async () => {
    const { root, ws } = await workspace();
    writeFileSync(join(ws.tree, "f"), "one\n");
    git(ws.tree, "add", "f");
    git(ws.tree, "commit", "-q", "-m", "f");
    const marker = join(root, "tmp", "filter-ran");
    git(ws.tree, "config", "filter.x.clean", `sh -c 'touch ${marker}; cat'`);
    mkdirSync(join(ws.gitDir, "info"), { recursive: true });
    writeFileSync(join(ws.gitDir, "info", "attributes"), "f filter=x\n");
    writeFileSync(join(ws.tree, "f"), "one\n"); // same content, new stat: git re-reads it through the clean filter
    expect(() => gitInTree(ws.tree, ["status", "--porcelain", "--untracked-files=all"])).toThrow("filter");
    expect(existsSync(marker)).toBe(false);
  });

  test("a core.fsmonitor command the author planted is not run by isDirty", async () => {
    const { root, ws } = await workspace();
    const marker = join(root, "tmp", "fsmonitor-ran");
    git(ws.tree, "config", "core.fsmonitor", `sh -c 'echo ran > ${marker}'`);
    writeFileSync(join(ws.tree, "README.md"), "edited\n");
    expect(isDirty(ws.tree)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("real fsmonitor runs under plain git but not readTreeGit or host completion", async () => {
    const { root, branch, ws } = await workspace();
    const marker = join(root, "tmp", "fsmonitor-marker");
    const script = join(root, "tmp", "monitor.sh");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    const head = git(ws.tree, "rev-parse", "HEAD");
    git(ws.tree, "config", "core.fsmonitor", script);
    writeFileSync(join(ws.tree, "README.md"), "changed\n");
    git(ws.tree, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(marker);
    expect(readTreeGit(ws.tree, ["status", "--porcelain"])).toContain("README.md");
    expect(existsSync(marker)).toBe(false);
    const result = completeWork({ git: readTreeGit }, {
      work: { root, branch, workId: "w1" } as WorkRecord,
      stop: { workId: "w1", head, cessation: "proven" } as StopRecord,
      guard: () => {}, author: { name: "test", email: "test@example.invalid" }, message: "test",
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("Git") });
    expect(existsSync(marker)).toBe(false);
    expect(git(ws.tree, "-c", "core.fsmonitor=false", "rev-parse", "HEAD")).toBe(head);

    // Isolate the command-line protection: hide the config entry from completion's
    // inspection only; real Git still sees it when completion runs status/add.
    const neutral = completeWork({ git: (tree, args) => {
      const output = readTreeGit(tree, args);
      return args.includes("config")
        ? output.split("\0").filter((entry) => !/^core\.fsmonitor\n/i.test(entry)).join("\0")
        : output;
    } }, {
      work: { root, branch, workId: "w1" } as WorkRecord,
      stop: { workId: "w1", head, cessation: "proven" } as StopRecord,
      guard: () => {}, author: { name: "test", email: "test@example.invalid" }, message: "test",
    });
    expect(neutral.ok).toBe(true);
    if (neutral.ok) expect(neutral.committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("a post-checkout hook the author planted is not run when a later session finds the tree on another branch", async () => {
    const { root, branch, ws } = await workspace();
    git(ws.tree, "checkout", "-q", "-b", "elsewhere");
    const marker = join(root, "tmp", "hook-ran");
    mkdirSync(join(ws.gitDir, "hooks"), { recursive: true });
    writeFileSync(join(ws.gitDir, "hooks", "post-checkout"), `#!/bin/sh\necho ran > ${marker}\n`);
    chmodSync(join(ws.gitDir, "hooks", "post-checkout"), 0o755);
    const again = await prepareWorkspace({ root, source, branch });
    expect(again.created).toBe(false);
    expect(git(again.tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(existsSync(marker)).toBe(false);
  });
});

seatbeltDescribe("publishing the author's branch", () => {
  function plant(ws: Awaited<ReturnType<typeof workspace>>["ws"], root: string) {
    mkdirSync(join(ws.gitDir, "hooks"), { recursive: true });
    writeFileSync(join(ws.gitDir, "hooks", "pre-push"), `#!/bin/sh\necho ran > ${root}/tmp/pre-push-ran\n`);
    chmodSync(join(ws.gitDir, "hooks", "pre-push"), 0o755);
    git(ws.tree, "config", "url.https://attacker.invalid/.pushInsteadOf", `file://${remote}`);
    git(ws.tree, "config", "core.hooksPath", join(ws.gitDir, "hooks"));
    writeFileSync(join(ws.tree, "feature.txt"), "work\n");
    git(ws.tree, "add", "feature.txt");
    git(ws.tree, "commit", "-q", "-m", "work");
  }

  test("the directory the host pushes from is host-owned: outside the work root, with no hook and none of the author's config", async () => {
    const { root, branch, ws } = await workspace();
    plant(ws, root);
    const dir = stageBranchForPush({ root, branch });
    expect(under(dir, root)).toBe(false);
    expect(existsSync(join(dir, "hooks", "pre-push"))).toBe(false);
    expect(readFileSync(join(dir, "config"), "utf-8")).not.toMatch(/attacker|pushInsteadOf|hooksPath/);
  });

  test("a push from it delivers the author's commit, runs no hook of the author's and is not redirected", async () => {
    const { root, branch, ws } = await workspace();
    plant(ws, root);
    const dir = stageBranchForPush({ root, branch });
    git(dir, "push", `file://${remote}`, `HEAD:refs/heads/${branch}`);
    expect(git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(git(ws.tree, "rev-parse", "HEAD"));
    expect(existsSync(join(root, "tmp", "pre-push-ran"))).toBe(false);
  });

  test("staging again after more commits moves the branch forward", async () => {
    const { root, branch, ws } = await workspace();
    plant(ws, root);
    stageBranchForPush({ root, branch });
    writeFileSync(join(ws.tree, "second.txt"), "more\n");
    git(ws.tree, "add", "second.txt");
    git(ws.tree, "commit", "-q", "-m", "more");
    const dir = stageBranchForPush({ root, branch });
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(ws.tree, "rev-parse", "HEAD"));
  });

  test("a published, clean tree is no longer unmerged work once the push is recorded", async () => {
    const { root, branch, ws } = await workspace();
    plant(ws, root);
    expect(isDirty(ws.tree)).toBe(true);
    const dir = stageBranchForPush({ root, branch });
    recordPushed({ root, branch }, git(dir, "rev-parse", "HEAD"));
    expect(isDirty(ws.tree)).toBe(false);
  });

  test("recording a commit that is not the tree's own is refused", async () => {
    const { root, branch } = await workspace();
    expect(() => recordPushed({ root, branch }, "f".repeat(40))).toThrow();
  });
});
