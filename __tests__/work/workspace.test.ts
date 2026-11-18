import { seatbeltTest } from "../helpers/seatbelt";
/**
 * castle-work-loop: per-work root, dedicated Git metadata.
 * Real git against a local repository in a temp directory; nothing else is touched.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, existsSync, realpathSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { prepareWorkspace, isDirty } from "../../src/work/workspace";

let tmp: string;
let source: string;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "work-ws-")));
  source = join(tmp, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "README.md"), "hello\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "first");
});
afterEach(() => {
  // temp directories are left to the OS; the test never deletes by pattern
});

const under = (path: string, root: string) => realpathSync(path).startsWith(realpathSync(root) + sep);

describe("prepareWorkspace", () => {
  seatbeltTest("lays out tree, git, tmp and home under the work root on branch work/<issue>-<workId>", async () => {
    const root = join(tmp, "work", "a", "x", "wabc");
    const ws = await prepareWorkspace({ root, source, branch: "work/7-wabc" });
    expect(ws.created).toBe(true);
    for (const dir of [ws.tree, ws.gitDir, ws.tmp, ws.home]) expect(under(dir, root)).toBe(true);
    expect(existsSync(join(ws.tree, "README.md"))).toBe(true);
    expect(git(ws.tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work/7-wabc");
  });

  seatbeltTest("the host records the base commit next to the work root before the author touches the tree", async () => {
    const root = join(tmp, "work", "a", "x", "wabc");
    const ws = await prepareWorkspace({ root, source, branch: "work/7-wabc" });
    const recorded = readFileSync(`${root}.base-sha`, "utf8").trim();

    expect(recorded).toBe(git(source, "rev-parse", "HEAD"));
    expect(under(`${root}.base-sha`, join(tmp, "work"))).toBe(true);
    // a later commit in the author's tree does not move it
    writeFileSync(join(ws.tree, "leak.txt"), "x\n");
    git(ws.tree, "add", "leak.txt");
    git(ws.tree, "commit", "-qm", "author commit");
    expect(readFileSync(`${root}.base-sha`, "utf8").trim()).toBe(recorded);
  });

  seatbeltTest("the git directory of the tree is under the work root and is not the source checkout's", async () => {
    const root = join(tmp, "work", "a", "x", "wabc");
    const ws = await prepareWorkspace({ root, source, branch: "work/7-wabc" });
    const abs = git(ws.tree, "rev-parse", "--absolute-git-dir");
    expect(under(abs, root)).toBe(true);
    expect(realpathSync(abs).startsWith(realpathSync(join(source, ".git")))).toBe(false);
  });

  seatbeltTest("a second call reuses the tree and keeps uncommitted files", async () => {
    const root = join(tmp, "work", "a", "x", "wabc");
    const first = await prepareWorkspace({ root, source, branch: "work/7-wabc" });
    writeFileSync(join(first.tree, "wip.txt"), "unfinished\n");
    writeFileSync(join(first.tree, "README.md"), "edited\n");
    const second = await prepareWorkspace({ root, source, branch: "work/7-wabc" });
    expect(second.created).toBe(false);
    expect(readFileSync(join(second.tree, "wip.txt"), "utf-8")).toBe("unfinished\n");
    expect(readFileSync(join(second.tree, "README.md"), "utf-8")).toBe("edited\n");
    expect(git(second.tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work/7-wabc");
  });

  seatbeltTest("retry after a checkout failure on an existing workspace does not retain the preparation marker", async () => {
    const root = join(tmp, "work", "a", "x", "wretry");
    const input = { root, source, branch: "work/7-wretry" };
    const ws = await prepareWorkspace(input);
    git(ws.tree, "checkout", "-qb", "other");
    writeFileSync(join(ws.tree, "README.md"), "other branch\n");
    git(ws.tree, "add", "README.md");
    git(ws.tree, "commit", "-qm", "other branch");
    writeFileSync(join(ws.tree, "README.md"), "uncommitted change\n");

    await expect(prepareWorkspace(input)).rejects.toThrow(/git checkout failed/);
    expect(existsSync(join(root, ".anima-work-preparing"))).toBe(false);
    expect(readFileSync(join(ws.tree, "README.md"), "utf8")).toBe("uncommitted change\n");
    git(ws.tree, "checkout", "--", "README.md");
    expect((await prepareWorkspace(input)).created).toBe(false);
    expect(git(ws.tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(input.branch);
  });

  seatbeltTest("reuse refuses an external Git filter before checkout and releases the marker", async () => {
    writeFileSync(join(source, ".gitattributes"), "README.md filter=x\n");
    git(source, "add", ".gitattributes");
    git(source, "commit", "-qm", "attributes");
    const root = join(tmp, "work", "a", "x", "wfilter");
    const input = { root, source, branch: "work/7-wfilter" };
    const ws = await prepareWorkspace(input);
    git(ws.tree, "checkout", "-qb", "other");
    writeFileSync(join(ws.tree, "README.md"), "other branch\n");
    git(ws.tree, "add", "README.md");
    git(ws.tree, "commit", "-qm", "other branch");

    const marker = join(root, "filter-ran");
    const filter = join(root, "filter.sh");
    writeFileSync(filter, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`);
    chmodSync(filter, 0o700);
    git(ws.tree, "config", "filter.x.clean", "cat");
    git(ws.tree, "config", "filter.x.smudge", filter);
    git(ws.tree, "config", "filter.x.required", "true");

    await expect(prepareWorkspace(input)).rejects.toThrow(/external Git filter/i);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, ".anima-work-preparing"))).toBe(false);
    git(ws.tree, "config", "--remove-section", "filter.x");
    for (const operation of ["clean", "smudge", "process"]) {
      git(ws.tree, "config", `filter.x.${operation}`, filter);
      await expect(prepareWorkspace(input)).rejects.toThrow(/external Git filter/i);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, ".anima-work-preparing"))).toBe(false);
      git(ws.tree, "config", "--remove-section", "filter.x");
    }
    expect((await prepareWorkspace(input)).created).toBe(false);
  });

  seatbeltTest("a clone from a local checkout copies the objects instead of hardlinking them, so the author cannot alter the source's", async () => {
    const root = join(tmp, "work", "a", "x", "wlocal");
    const ws = await prepareWorkspace({ root, source, branch: "work/7-wlocal" });
    const blob = git(source, "rev-parse", "HEAD:README.md");
    const rel = `objects/${blob.slice(0, 2)}/${blob.slice(2)}`;
    const original = join(source, ".git", rel);
    const copied = join(ws.gitDir, rel);
    if (existsSync(original) && existsSync(copied)) expect(statSync(copied).ino).not.toBe(statSync(original).ino);
    // loose objects may have been packed by the clone; the guarantee that matters is that no object file is shared
    const shared = Bun.spawnSync(["sh", "-c", `find "${ws.gitDir}/objects" -type f -links +1 | head -1`]).stdout.toString().trim();
    expect(shared).toBe("");
  });

  seatbeltTest("two works get separate trees and git directories", async () => {
    const a = await prepareWorkspace({ root: join(tmp, "work", "a", "x", "w1"), source, branch: "work/7-w1" });
    const b = await prepareWorkspace({ root: join(tmp, "work", "b", "x", "w2"), source, branch: "work/7-w2" });
    expect(a.tree).not.toBe(b.tree);
    expect(a.gitDir).not.toBe(b.gitDir);
    writeFileSync(join(a.tree, "only-a.txt"), "a\n");
    expect(existsSync(join(b.tree, "only-a.txt"))).toBe(false);
  });

  seatbeltTest("a tree whose git directory is outside the work root is refused", async () => {
    const root = join(tmp, "work", "a", "x", "wbad");
    mkdirSync(root, { recursive: true });
    // a linked worktree of the developer checkout keeps its metadata inside that checkout's .git
    git(source, "worktree", "add", "-q", "-b", "work/9-wbad", join(root, "tree"));
    await expect(prepareWorkspace({ root, source, branch: "work/9-wbad" })).rejects.toThrow(/outside the work root/);
  });

  test("a relative root, a root with .. and an empty branch are refused", async () => {
    await expect(prepareWorkspace({ root: "work/a", source, branch: "work/7-w" })).rejects.toThrow(RangeError);
    await expect(prepareWorkspace({ root: `${tmp}/x/../y`, source, branch: "work/7-w" })).rejects.toThrow(RangeError);
    await expect(prepareWorkspace({ root: join(tmp, "ok"), source, branch: "" })).rejects.toThrow(RangeError);
    await expect(prepareWorkspace({ root: join(tmp, "ok"), source, branch: "-bad" })).rejects.toThrow(RangeError);
  });

  seatbeltTest("a failed clone leaves no half-made tree behind that a later call would trust", async () => {
    const root = join(tmp, "work", "a", "x", "wfail");
    await expect(prepareWorkspace({ root, source: join(tmp, "does-not-exist"), branch: "work/7-wfail" })).rejects.toThrow();
    const ws = await prepareWorkspace({ root, source, branch: "work/7-wfail" });
    expect(ws.created).toBe(true);
    expect(existsSync(join(ws.tree, "README.md"))).toBe(true);
  });
});

describe("isDirty", () => {
  seatbeltTest("false when clean, true for an edit, true for an untracked file, true for a commit not on the source", async () => {
    const root = join(tmp, "work", "a", "x", "wdirty");
    const ws = await prepareWorkspace({ root, source, branch: "work/7-wdirty" });
    expect(isDirty(ws.tree)).toBe(false);
    writeFileSync(join(ws.tree, "new.txt"), "x\n");
    expect(isDirty(ws.tree)).toBe(true);
    git(ws.tree, "add", "new.txt");
    git(ws.tree, "commit", "-q", "-m", "work");
    // committed but never pushed anywhere: still unmerged work, so it still counts
    expect(isDirty(ws.tree)).toBe(true);
  });
});
