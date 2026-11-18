import { describe, expect, test } from "bun:test";
import { HOST_PR_TITLE_PREFIX, hostPrBody, hostPrTitle, type HostPrTextInput } from "../../src/work/publish-pr-text";
import { redactSecrets } from "../../src/work/publish-secrets";

const sample: HostPrTextInput = {
  issue: 7,
  workId: "w0123456",
  issueTitle: "Add the thing",
  stopCause: "deadline",
  execMsUsed: 1_801_400,
  workWallMs: 3_600_000,
  sessionsUsed: 4,
  maxSessions: 6,
  testCommand: ["bun", "test", "./__tests__/work/x.test.ts"],
  testOutput: "one\ntwo\nthree\n",
  fileCount: 3,
  addedLines: 42,
  deletedLines: 7,
  generatedCount: 2,
};

const withInput = (patch: Partial<HostPrTextInput>) => hostPrBody({ ...sample, ...patch });

describe("hostPrTitle", () => {
  test("SC-018 prefixes the issue title", () => {
    expect(hostPrTitle("Add the thing")).toBe("[host-published] Add the thing");
    expect(HOST_PR_TITLE_PREFIX).toBe("[host-published] ");
  });

  test("collapses whitespace runs into one space and trims", () => {
    expect(hostPrTitle("  Add \n\t the   thing  ")).toBe("[host-published] Add the thing");
  });

  test("uses a fallback title when the issue title is blank", () => {
    expect(hostPrTitle("   \n\t ")).toBe("[host-published] work for the issue");
  });

  test("cuts a long title to 256 characters ending in an ellipsis", () => {
    const title = hostPrTitle("a".repeat(300));
    expect(title.length).toBe(256);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith(HOST_PR_TITLE_PREFIX)).toBe(true);
  });
});

describe("hostPrBody", () => {
  test("SC-018 has the pull request parts in order", () => {
    const body = hostPrBody(sample);
    const parts = [
      "Closes #7",
      "<!-- host-published work=w0123456 -->",
      "Published by the host, not by the author agent: the work reached a limit before it opened a pull request. This is unfinished work for review, not for merge.",
      "Stop cause: deadline. Time: 1801 s of 3600 s. Sessions: 4 of 6.",
      "Change: 3 files (+42 / -7 lines); 2 generated files left out.",
      "Tests: `bun test ./__tests__/work/x.test.ts` exited 0.",
      "one\ntwo\nthree",
    ];
    for (const part of parts) expect(body).toContain(part);
    const indexes = parts.map((part) => body.indexOf(part));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  test("SC-018 carries the hidden marker exactly", () => {
    expect(hostPrBody(sample)).toContain("<!-- host-published work=w0123456 -->");
  });

  test("rounds the times to whole seconds", () => {
    expect(withInput({ execMsUsed: 1_801_400 })).toContain("Time: 1801 s");
    expect(withInput({ execMsUsed: 1_400 })).toContain("Time: 1 s");
  });

  test("keeps only the last 40 lines of the test output", () => {
    const output = Array.from({ length: 100 }, (_, index) => `out-${index + 1}`).join("\n");
    const body = withInput({ testOutput: output });
    expect(body).toContain("out-61");
    expect(body).not.toContain("out-60");
    expect(body).toContain("\n```\nout-61\n");
  });

  test("keeps every line when the output is shorter than 40 lines", () => {
    expect(hostPrBody(sample)).toContain("```\none\ntwo\nthree\n```");
  });

  test("redacts a secret in the test output", () => {
    const token = "ghp_" + "a".repeat(36);
    const body = withInput({ testOutput: `before ${token} after` });
    expect(body).not.toContain(token);
    expect(body).toContain("[redacted]");
    expect(body).toBe(withInput({ testOutput: redactSecrets(`before ${token} after`) }));
  });

  test("cannot close the fence with backticks in the output", () => {
    const body = withInput({ testOutput: "`````\nafter" });
    expect(body).not.toContain("`````");
    expect(body.split("\n").filter((line) => line === "```")).toHaveLength(2);
    expect(body).toContain("'''");
  });

  test("cuts the output block to keep the body within 60 000 characters", () => {
    const output = Array.from({ length: 4000 }, (_, index) => `${index}-${"x".repeat(60)}`).join("\n");
    expect(output.length).toBeGreaterThan(200_000);
    const body = withInput({ testOutput: output });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("Closes #7");
    expect(body).toContain("<!-- host-published work=w0123456 -->");
    expect(body).toContain("Stop cause: deadline.");
  });

  test("rejects invalid input with a message that does not echo it", () => {
    const invalid: Array<Partial<HostPrTextInput>> = [
      { issue: 0 },
      { issue: -1 },
      { issue: 1.5 },
      { workId: "x" },
      { workId: "wXYZ123" },
      { execMsUsed: -1 },
      { workWallMs: 1.5 },
      { sessionsUsed: -1 },
      { maxSessions: Number.NaN },
      { fileCount: -1 },
      { addedLines: 1.5 },
      { deletedLines: -2 },
      { generatedCount: 0.5 },
      { testCommand: [] },
    ];
    for (const patch of invalid) {
      expect(() => withInput(patch)).toThrow(/Invalid pull request text input/);
    }
    try {
      withInput({ workId: "hidden-work-id" });
      throw new Error("expected hostPrBody to throw");
    } catch (error) {
      expect((error as Error).message).toBe("Invalid pull request text input");
      expect((error as Error).message).not.toContain("hidden-work-id");
    }
  });
});

describe("hostPrBody body cap", () => {
  test("cuts a command above 40 000 characters and keeps the body within 60 000 characters", () => {
    const body = withInput({ testCommand: ["bun", "x".repeat(60_000)] });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("arguments in total");
    expect(body).not.toContain("x".repeat(5_000));
    expect(body).toContain("Closes #7");
  });

  test("accepts a command that fits and keeps the whole body within 60 000 characters", () => {
    const body = withInput({ testCommand: ["bun", "test", "y".repeat(3_900)], testOutput: "z".repeat(200_000) });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("Closes #7");
  });
});

describe("test command validation", () => {
  test("a command part with Markdown delimiters or line breaks is rejected, so it cannot inject text", () => {
    for (const part of ["a`b", "a\nb", "x```", "a b", "<!--", "*bold*", "[x](y)", ""]) {
      expect(() => withInput({ testCommand: ["bun", "test", part] })).toThrow(/Invalid pull request text input/);
    }
  });

  test("a 60 000-character command is shown shortened rather than returning an over-limit body or failing", () => {
    const body = withInput({ testCommand: ["bun", "test", "a".repeat(60_000)] });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("<!-- host-published work=w0123456 -->");
  });

  test("a command of 20 long but ordinary test paths (as deriveTestCommand can produce) is accepted and the body stays within the limit", () => {
    const parts = Array.from({ length: 30 }, (_, index) => `./__tests__/work/${"x".repeat(80)}${index}.test.ts`);
    const body = withInput({ testCommand: ["bun", "test", ...parts], testOutput: "line\n".repeat(50_000) });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("Closes #7");
  });
});

describe("compatibility with deriveTestCommand", () => {
  const argvOf = (pathLength: number) =>
    ["bun", "test", ...Array.from({ length: 20 }, (_, index) => `./__tests__/work/${"p".repeat(pathLength)}${index}.test.ts`)];

  test("20 test paths of about 200 characters each (an argv above 4 000 characters) are shown in full", () => {
    const argv = argvOf(180);
    expect(argv.join(" ").length).toBeGreaterThan(4_000);
    const body = withInput({ testCommand: argv });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain(argv.join(" "));
    expect(body).not.toContain("arguments in total");
  });

  test("20 test paths of about 1 000 characters each (an argv above 20 000 characters) are shown in full", () => {
    const argv = argvOf(980);
    expect(argv.join(" ").length).toBeGreaterThan(20_000);
    const body = withInput({ testCommand: argv, testOutput: "line\n".repeat(100) });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain(argv.join(" "));
    expect(body).toContain("Closes #7");
  });

  test("only a command above 40 000 characters is cut, with its argument count", () => {
    const argv = argvOf(2_100);
    expect(argv.join(" ").length).toBeGreaterThan(40_000);
    const body = withInput({ testCommand: argv });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("(22 arguments in total)");
    expect(body).toContain("Closes #7");
  });

  test("a command that fits is shown exactly as run", () => {
    const body = withInput({});
    expect(body).toContain("`bun test ./__tests__/work/x.test.ts`");
    expect(body).not.toContain("arguments in total");
  });
});
