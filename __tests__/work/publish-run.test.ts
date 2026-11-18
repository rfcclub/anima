import { describe, expect, test } from "bun:test";
import type { JudgeFailure, JudgeOutcome } from "../../src/work/publish-judge";
import { HOST_PR_TITLE_PREFIX } from "../../src/work/publish-pr-text";
import { redactSecrets } from "../../src/work/publish-secrets";
import type { ChangedFile } from "../../src/work/publish-snapshot";
import { runHostPublish, type HostRunDeps } from "../../src/work/publish-run";

// Fake credential, assembled from parts so no credential-shaped literal sits in this file.
const fakeToken = "ghp_" + "a".repeat(36);

const TREE = "1".repeat(40);
const COMMIT = "2".repeat(40);

function file(path: string, added: number, deleted: number): ChangedFile {
  return { path, added, deleted, binary: false };
}

const judged: JudgeOutcome = {
  ok: true,
  treeHash: TREE,
  files: [file("src/a.ts", 10, 2), file("src/b.ts", 5, 3)],
  generated: [file(".orca-verify.json", 1, 1)],
  testOutput: " 5 pass\n 0 fail\n",
};

const OK_PUSH = JSON.stringify({ status: "ok" });
const OK_PR = JSON.stringify({ status: "ok", number: 12 });

/** Everything of HostPrTextInput the judge outcome does not supply. */
const text = {
  issue: 7,
  workId: "w0123456",
  stopCause: "deadline" as const,
  execMsUsed: 1_800_000,
  workWallMs: 3_600_000,
  sessionsUsed: 4,
  maxSessions: 6,
  testCommand: ["bun", "test", "./__tests__/work/x.test.ts"],
};

interface Fakes {
  deps: HostRunDeps;
  calls: string[];
  prArgs: () => { title: string; body: string }[];
}

function fakes(
  options: {
    outcome?: () => Promise<JudgeOutcome>;
    pushOutput?: () => Promise<string>;
    prOutput?: () => Promise<string>;
    fetchBase?: () => void;
    commit?: (treeHash: string) => string;
    recordBranch?: (sha: string) => void;
    guard?: (call: number) => Promise<void>;
  } = {},
): Fakes {
  const calls: string[] = [];
  const prArgs: { title: string; body: string }[] = [];
  let guards = 0;
  const deps: HostRunDeps = {
    guard: async () => {
      guards++;
      calls.push("guard");
      await (options.guard ?? (async () => {}))(guards);
    },
    fetchBase: () => {
      calls.push("fetchBase");
      (options.fetchBase ?? (() => {}))();
    },
    judge: async () => {
      calls.push("judge");
      return (options.outcome ?? (async () => judged))();
    },
    commit: (treeHash) => {
      calls.push("commit");
      return (options.commit ?? (() => COMMIT))(treeHash);
    },
    recordBranch: (sha) => {
      calls.push("recordBranch");
      (options.recordBranch ?? (() => {}))(sha);
    },
    push: async () => {
      calls.push("push");
      return (options.pushOutput ?? (async () => OK_PUSH))();
    },
    openDraftPr: async (title, body) => {
      calls.push("openDraftPr");
      prArgs.push({ title, body });
      return (options.prOutput ?? (async () => OK_PR))();
    },
    issueTitle: "Add the thing",
    text,
  };
  return { deps, calls, prArgs };
}

const failure = (check: JudgeFailure): JudgeOutcome => ({ ok: false, check, detail: "no" });

const JUDGE_FAILURES: JudgeFailure[] = [
  "no-change",
  "outside-repo",
  "denied-path",
  "too-large",
  "secret-found",
  "no-tests",
  "tests-failed",
  "tests-timeout",
  "tree-changed",
];

describe("runHostPublish success", () => {
  test("SC-018 runs the steps in order and returns the published result", async () => {
    const { deps, calls, prArgs } = fakes();
    const result = await runHostPublish(deps);

    expect(calls).toEqual([
      "guard",
      "fetchBase",
      "judge",
      "guard",
      "commit",
      "recordBranch",
      "guard",
      "push",
      "guard",
      "openDraftPr",
    ]);
    expect(result).toEqual({
      published: true,
      sha: COMMIT,
      prOutput: OK_PR,
      checks: ["no-change", "outside-repo", "denied-path", "too-large", "secret-found", "tests", "tree-unchanged"],
    });

    const pr = prArgs[0]!;
    expect(pr.title.startsWith("[host-published] ")).toBe(true);
    expect(pr.title).toBe(HOST_PR_TITLE_PREFIX + "Add the thing");
    expect(pr.body).toContain("Closes #7");
    expect(pr.body).toContain("<!-- host-published work=w0123456 -->");
    // The sums come from the outcome's files, not from the caller's text.
    expect(pr.body).toContain("Change: 2 files (+15 / -5 lines); 1 generated files left out.");
    expect(pr.body).toContain(" 5 pass\n 0 fail");
  });
});

describe("runHostPublish judge failures", () => {
  for (const check of JUDGE_FAILURES) {
    test(`SC-006 stops after judge when the judge reports ${check}`, async () => {
      const { deps, calls, prArgs } = fakes({ outcome: async () => failure(check) });
      const result = await runHostPublish(deps);

      expect(result).toEqual({ published: false, reason: check, pushed: false });
      expect(calls).toEqual(["guard", "fetchBase", "judge"]);
      expect(prArgs).toHaveLength(0);
    });
  }
});

describe("runHostPublish push failures", () => {
  const outputs: [string, () => Promise<string>][] = [
    ["an error string", async () => "Error: x"],
    ["not JSON", async () => "not json at all"],
    ["status error", async () => JSON.stringify({ status: "error" })],
  ];
  for (const [name, pushOutput] of outputs) {
    test(`returns error and opens no pull request when the push output is ${name}`, async () => {
      const { deps, calls, prArgs } = fakes({ pushOutput });
      const result = await runHostPublish(deps);

      expect(result).toEqual({ published: false, reason: "error", pushed: false });
      // The lease is asked again after a failed push, because the publisher reports a lost lease as an error string.
      expect(calls).toEqual(["guard", "fetchBase", "judge", "guard", "commit", "recordBranch", "guard", "push", "guard"]);
      expect(prArgs).toHaveLength(0);
    });
  }
});

describe("runHostPublish pull request failure", () => {
  test("SC-027 records that the branch was pushed when the pull request is not created", async () => {
    const { deps } = fakes({ prOutput: async () => JSON.stringify({ status: "error" }) });
    const result = await runHostPublish(deps);

    expect(result).toEqual({ published: false, reason: "pr-create-failed (branch pushed)", pushed: true, sha: COMMIT });
  });
});

describe("runHostPublish exceptions", () => {
  const boom = "boom-" + "do-not-copy";

  const cases: { name: string; patch: () => Partial<Parameters<typeof fakes>[0]>; pushed: boolean; after: string }[] = [
    { name: "fetchBase", patch: () => ({ fetchBase: () => { throw new Error(boom); } }), pushed: false, after: "fetchBase" },
    { name: "judge", patch: () => ({ outcome: async () => { throw new Error(boom); } }), pushed: false, after: "judge" },
    { name: "commit", patch: () => ({ commit: () => { throw new Error(boom); } }), pushed: false, after: "commit" },
    { name: "recordBranch", patch: () => ({ recordBranch: () => { throw new Error(boom); } }), pushed: false, after: "recordBranch" },
    { name: "push", patch: () => ({ pushOutput: async () => { throw new Error(boom); } }), pushed: false, after: "guard" },
  ];

  for (const item of cases) {
    test(`an exception from ${item.name} is returned as error without its message`, async () => {
      const { deps, calls } = fakes(item.patch());
      const result = await runHostPublish(deps);

      expect(result).toEqual({ published: false, reason: "error", pushed: item.pushed });
      expect(calls[calls.length - 1]).toBe(item.after === "guard" ? "guard" : item.after);
      expect(JSON.stringify(result)).not.toContain(boom);
    });
  }

  test("an exception from openDraftPr after a good push is the generic error with pushed true, without its message", async () => {
    const { deps, calls } = fakes({ prOutput: async () => { throw new Error(boom); } });
    const result = await runHostPublish(deps);

    expect(result).toEqual({ published: false, reason: "error", pushed: true, sha: COMMIT });
    expect(calls[calls.length - 2]).toBe("openDraftPr");
    expect(JSON.stringify(result)).not.toContain(boom);
  });
});

describe("runHostPublish lease lost inside the publisher", () => {
  // The real publisher returns "Error: <message>" when its own guard throws, instead of throwing.
  const leaseLostAfter = (call: number) => async (n: number): Promise<void> => {
    if (n === call) throw new Error("lease lost");
  };

  test("a push that returns an error string because the lease was lost propagates the lease loss", async () => {
    const { deps, calls, prArgs } = fakes({ pushOutput: async () => "Error: lease lost", guard: leaseLostAfter(4) });

    await expect(runHostPublish(deps)).rejects.toThrow("lease lost");
    expect(calls[calls.length - 1]).toBe("guard");
    expect(prArgs).toHaveLength(0);
  });

  test("a push that throws and then finds the lease lost propagates the lease loss", async () => {
    const { deps } = fakes({ pushOutput: async () => { throw new Error("push died"); }, guard: leaseLostAfter(4) });
    await expect(runHostPublish(deps)).rejects.toThrow("lease lost");
  });

  test("a pull request call that returns an error string because the lease was lost propagates it, not pr-create-failed", async () => {
    const { deps } = fakes({ prOutput: async () => "Error: lease lost", guard: leaseLostAfter(5) });
    await expect(runHostPublish(deps)).rejects.toThrow("lease lost");
  });

  test("a pull request call that throws and then finds the lease lost propagates the lease loss", async () => {
    const { deps } = fakes({ prOutput: async () => { throw new Error("pr died"); }, guard: leaseLostAfter(5) });
    await expect(runHostPublish(deps)).rejects.toThrow("lease lost");
  });
});

describe("runHostPublish lease", () => {
  for (const call of [1, 2, 3, 4]) {
    test(`SC-023 propagates a guard that throws on call ${call} and stops there`, async () => {
      const { deps, calls } = fakes({
        guard: async (n) => {
          if (n === call) throw new Error("lease lost");
        },
      });

      await expect(runHostPublish(deps)).rejects.toThrow("lease lost");
      const expected = [
        ["guard"],
        ["guard", "fetchBase", "judge", "guard"],
        ["guard", "fetchBase", "judge", "guard", "commit", "recordBranch", "guard"],
        ["guard", "fetchBase", "judge", "guard", "commit", "recordBranch", "guard", "push", "guard"],
      ][call - 1]!;
      expect(calls).toEqual(expected);
      expect(calls.filter((name) => name === "guard")).toHaveLength(call);
    });
  }
});

describe("runHostPublish secrets", () => {
  test("the redacted test output carries no token into the body", async () => {
    const raw = ` 5 pass\n 0 fail\n$ GH_TOKEN=${fakeToken}\n`;
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain(fakeToken);
    const { deps, prArgs } = fakes({ outcome: async () => ({ ...judged, testOutput: redacted }) });
    const result = await runHostPublish(deps);

    const body = prArgs[0]!.body;
    expect(body).not.toContain(fakeToken);
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });
});
