import { describe, expect, test } from "bun:test";
import {
  createHostCommit,
  HOST_COMMITTER_EMAIL,
  HOST_COMMITTER_NAME,
  hostCommitMessage,
  type HostCommitInput,
} from "../../src/work/publish-commit";
import { isolatedGit, type IsolatedGit } from "../../src/work/publish-snapshot";

const iso = isolatedGit({
  gitDir: "/host/git", indexFile: "/host/index", tree: "/work/tree", emptyHooksDir: "/host/empty-hooks",
});

const TREE = "1".repeat(40);
const BASE = "2".repeat(40);
const SHA = "3".repeat(40);

interface Fakes {
  input: HostCommitInput;
  calls: Array<[IsolatedGit, string[]]>;
}

function fakes(overrides: Partial<HostCommitInput> = {}, output = SHA): Fakes {
  const calls: Array<[IsolatedGit, string[]]> = [];
  const input: HostCommitInput = { iso, treeHash: TREE, base: BASE, issue: 7, workId: "wabc1234ef0", ...overrides };
  return { input, calls };
}

function runWith(calls: Array<[IsolatedGit, string[]]>, output: string) {
  return (isoArg: IsolatedGit, args: string[]): string => {
    calls.push([isoArg, args]);
    return output;
  };
}

describe("hostCommitMessage", () => {
  test("names the host and the work: issue and work id of the commit", () => {
    expect(hostCommitMessage(7, "wabc1234ef0")).toBe("Host-published work for #7 (wabc1234ef0)");
  });
});

describe("createHostCommit", () => {
  test("makes exactly one commit-tree call in the host's Git directory and returns the sha", () => {
    const { input, calls } = fakes();
    const sha = createHostCommit(runWith(calls, SHA), input);

    expect(sha).toBe(SHA);
    expect(calls).toHaveLength(1);
    const [calledIso, args] = calls[0]!;
    expect(calledIso).toBe(iso);
    expect(args).toEqual([
      "-c", "user.name=" + HOST_COMMITTER_NAME,
      "-c", "user.email=" + HOST_COMMITTER_EMAIL,
      "commit-tree", TREE, "-p", BASE, "-m", "Host-published work for #7 (wabc1234ef0)",
    ]);
    expect(args.join(" ")).not.toContain("update-ref");
    expect(args.filter((arg) => arg === "commit" || arg === "push")).toEqual([]);
  });

  test("trims a trailing newline from the sha", () => {
    const { input, calls } = fakes();
    expect(createHostCommit(runWith(calls, SHA + "\n"), input)).toBe(SHA);
  });

  test("commits as the host, never as the author App", () => {
    expect(HOST_COMMITTER_NAME).toBe("ANIMA host publish");
    expect(HOST_COMMITTER_EMAIL).toBe("host-publish@anima.invalid");
    expect(HOST_COMMITTER_NAME).not.toContain("gotako");
    expect(HOST_COMMITTER_EMAIL).not.toContain("gotako");
    expect(HOST_COMMITTER_EMAIL.endsWith(".invalid")).toBe(true);
  });

  test("rejects invalid commit input before any call", () => {
    const invalid: Array<Partial<HostCommitInput>> = [
      { issue: 0 },
      { issue: -1 },
      { issue: 1.5 },
      { issue: NaN },
      { issue: Number.MAX_SAFE_INTEGER + 1 },
      { workId: "" },
      { workId: "abc" },
      { workId: "w12" },
      { workId: "wABCDEF12" },
      { workId: "w1; rm" },
      { treeHash: "a".repeat(39) },
      { treeHash: "A".repeat(40) },
      { treeHash: "z".repeat(40) },
      { base: "b".repeat(41) },
      { base: "" },
      { base: "B".repeat(40) },
      { treeHash: "1".repeat(39) + "g" },
    ];
    for (const overrides of invalid) {
      const { input, calls } = fakes(overrides);
      expect(() => createHostCommit(runWith(calls, SHA), input)).toThrow("Invalid commit input");
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects a commit-tree output that is not a lower-case 40-hex sha", () => {
    for (const output of ["", "\n", "a".repeat(39), "a".repeat(41), "A".repeat(40), "fatal: x", "a".repeat(39) + "g"]) {
      const { input, calls } = fakes();
      expect(() => createHostCommit(runWith(calls, output), input)).toThrow(/Invalid commit hash/);
      expect(calls).toHaveLength(1);
    }
  });
});
