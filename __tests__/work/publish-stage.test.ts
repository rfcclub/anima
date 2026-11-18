import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBase, recordHostBranch, type GitRun } from "../../src/work/publish-stage";

const bare = "/host/work.push.git";
const authorGitDir = "/host/git";
const base = "a".repeat(40);
const sha = "b".repeat(40);
const branch = "work/7-wabc1234ef0";
const env = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** A run that records its argument lists and returns the scripted output for the n-th call. */
function scripted(outputs: string[]) {
  const calls: string[][] = [];
  const run: GitRun = (args) => {
    calls.push(args);
    const out = outputs[calls.length - 1];
    return out ?? "";
  };
  return { calls, run };
}

/** A run that must never be reached. */
function forbidden(calls: string[][]): GitRun {
  return (args) => {
    calls.push(args);
    throw new Error("run must not be called");
  };
}

function message(thunk: () => void): string {
  try {
    thunk();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

describe("fetchBase", () => {
  test("SC-E2-1 fetches the base into the staging repository and verifies the ref", () => {
    const { calls, run } = scripted(["", `${base}\n`]);
    fetchBase(run, { bare, authorGitDir, base });
    expect(calls).toEqual([
      [
        "--git-dir", bare, "-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true",
        "fetch", "-q", "--no-tags", "--no-write-fetch-head", authorGitDir, `+${base}:refs/host/base`,
      ],
      ["--git-dir", bare, "rev-parse", "--verify", "-q", "refs/host/base^{commit}"],
    ]);
  });

  test("rejects a relative, empty, NUL or newline path before calling run", () => {
    for (const key of ["bare", "authorGitDir"] as const) {
      for (const value of ["", "relative/path", "/x\0y", "/x\ny", "/x\ry"]) {
        const calls: string[][] = [];
        const input = { bare, authorGitDir, base };
        input[key] = value;
        const error = message(() => fetchBase(forbidden(calls), input));
        expect(error).toBe("Invalid stage input");
        if (value.length > 1) expect(error).not.toContain(value.slice(1));
        expect(calls).toEqual([]);
      }
    }
  });

  test("rejects a base that is not forty lower-case hex characters before calling run", () => {
    for (const value of ["", "bad", base.toUpperCase(), base.slice(1), `${base}0`, `${"g".repeat(40)}`, ` ${base}`]) {
      const calls: string[][] = [];
      expect(message(() => fetchBase(forbidden(calls), { bare, authorGitDir, base: value }))).toBe(
        "Invalid stage input",
      );
      expect(calls).toEqual([]);
    }
  });

  test("throws when the staged ref does not resolve to the base", () => {
    for (const out of ["", `${sha}\n`, `${base}0\n`]) {
      const { calls, run } = scripted(["", out]);
      expect(message(() => fetchBase(run, { bare, authorGitDir, base }))).toBe("Base not staged");
      expect(calls).toHaveLength(2);
    }
  });
});

describe("recordHostBranch", () => {
  test("SC-E2-2 points the host branch and HEAD at the host commit", () => {
    const { calls, run } = scripted(["", "", `${sha}\n`]);
    recordHostBranch(run, { bare, branch, sha });
    expect(calls).toEqual([
      ["--git-dir", bare, "update-ref", `refs/heads/${branch}`, sha],
      ["--git-dir", bare, "symbolic-ref", "HEAD", `refs/heads/${branch}`],
      ["--git-dir", bare, "rev-parse", "--verify", "-q", "HEAD^{commit}"],
    ]);
  });

  test("rejects an empty, relative, NUL or newline bare path before calling run", () => {
    for (const value of ["", "relative/path", "/x\0y", "/x\ny", "/x\ry"]) {
      const calls: string[][] = [];
      expect(message(() => recordHostBranch(forbidden(calls), { bare: value, branch, sha }))).toBe(
        "Invalid stage input",
      );
      expect(calls).toEqual([]);
    }
  });

  test("rejects a branch that is not a work branch before calling run", () => {
    for (const value of [
      "work/x", "main", "work/7-W123456", "refs/heads/work/7-wabc1234ef0",
      "work/7-wabc12", "work/-wabc1234ef0", "work/7-wabc1234ef0\n",
    ]) {
      const calls: string[][] = [];
      const error = message(() => recordHostBranch(forbidden(calls), { bare, branch: value, sha }));
      expect(error).toBe("Invalid stage input");
      expect(error).not.toContain("wabc");
      expect(calls).toEqual([]);
    }
  });

  test("rejects a sha that is not forty lower-case hex characters before calling run", () => {
    for (const value of ["", "bad", sha.toUpperCase(), sha.slice(1), `${sha}0`, `${"g".repeat(40)}`]) {
      const calls: string[][] = [];
      expect(message(() => recordHostBranch(forbidden(calls), { bare, branch, sha: value }))).toBe(
        "Invalid stage input",
      );
      expect(calls).toEqual([]);
    }
  });

  test("throws when HEAD does not resolve to the host commit", () => {
    for (const out of ["", `${base}\n`, "not-a-hash\n"]) {
      const { calls, run } = scripted(["", "", out]);
      expect(message(() => recordHostBranch(run, { bare, branch, sha }))).toBe("Branch not staged");
      expect(calls).toHaveLength(3);
    }
  });
});

describe("publish stage with real Git", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const git = (cwd: string, args: string[]): string => {
    const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };

  test("SC-E2-3 stages the base and the host branch in the staging repository", () => {
    dir = mkdtempSync(join(tmpdir(), "publish-stage-"));
    const source = join(dir, "source");
    git(dir, ["init", "-q", "-b", "main", source]);
    writeFileSync(join(source, "README.md"), "hello\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "first"]);
    writeFileSync(join(source, "README.md"), "hello again\n");
    git(source, ["commit", "-q", "-am", "second"]);
    const base = git(source, ["rev-parse", "HEAD"]).trim();

    const host = join(dir, "work.push.git");
    git(dir, ["init", "-q", "--bare", "--template=", host]);

    const run: GitRun = (args) => git(dir, args);

    fetchBase(run, { bare: host, authorGitDir: join(source, ".git"), base });
    expect(git(dir, ["--git-dir", host, "rev-parse", "refs/host/base"]).trim()).toBe(base);

    const tree = git(dir, ["--git-dir", host, "rev-parse", `${base}^{tree}`]).trim();
    const commit = git(dir, ["--git-dir", host, "commit-tree", tree, "-p", base, "-m", "staged"])
      .trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    recordHostBranch(run, { bare: host, branch: "work/7-wabc1234ef0", sha: commit });
    expect(git(dir, ["--git-dir", host, "rev-parse", "refs/heads/work/7-wabc1234ef0"]).trim()).toBe(commit);
    expect(git(dir, ["--git-dir", host, "symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/work/7-wabc1234ef0");
  });

  test("SC-E2-4 replaces an existing staged base with a divergent one", () => {
    dir = mkdtempSync(join(tmpdir(), "publish-stage-"));
    const source = join(dir, "source");
    git(dir, ["init", "-q", "-b", "main", source]);
    writeFileSync(join(source, "README.md"), "hello\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "first"]);
    const first = git(source, ["rev-parse", "HEAD"]).trim();
    git(source, ["checkout", "-q", "--orphan", "other"]);
    git(source, ["commit", "-q", "-m", "other", "--allow-empty"]);
    const second = git(source, ["rev-parse", "HEAD"]).trim();
    git(source, ["checkout", "-q", "main"]);
    expect(second).not.toBe(first);

    const host = join(dir, "work.push.git");
    git(dir, ["init", "-q", "--bare", "--template=", host]);

    const run: GitRun = (args) => git(dir, args);
    const authorGitDir = join(source, ".git");

    fetchBase(run, { bare: host, authorGitDir, base: first });
    expect(git(dir, ["--git-dir", host, "rev-parse", "refs/host/base"]).trim()).toBe(first);

    // The staging repository is reused across publishes: the next base need not be a descendant.
    fetchBase(run, { bare: host, authorGitDir, base: second });
    expect(git(dir, ["--git-dir", host, "rev-parse", "refs/host/base"]).trim()).toBe(second);
  });
});
