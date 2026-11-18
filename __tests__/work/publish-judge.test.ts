import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../../src/work/publish-snapshot";
import type { TestOutcome } from "../../src/work/publish-tests";
import { judgeWorkTree, type JudgeDeps } from "../../src/work/publish-judge";

// Fake credential, assembled from parts so no credential-shaped literal sits in this file.
const fakeToken = "ghp_" + "a".repeat(36);

const FIRST_HASH = "1".repeat(40);
const SECOND_HASH = "2".repeat(40);

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, added: 1, deleted: 0, binary: false, ...overrides };
}

function reader(contents: Record<string, string> = {}) {
  return (path: string): string | undefined => contents[path] ?? "export const clean = 1;\n";
}

const derived = ["bun", "test", "./__tests__/work/x.test.ts"];
const passing: TestOutcome = { ok: true, output: " 3 pass\n 0 fail\n" };

interface Fakes {
  deps: JudgeDeps;
  snapshotCalls: () => number;
  runTestsCalls: () => number;
  testCommandArgs: () => ChangedFile[][];
  runTestsArgs: () => string[][];
}

function fakes(options: {
  files: ChangedFile[];
  secondHash?: string;
  contents?: Record<string, string>;
  testCommand?: string[] | null;
  runTests?: (argv: string[]) => Promise<TestOutcome>;
}): Fakes {
  const snapshots = [FIRST_HASH, options.secondHash ?? FIRST_HASH];
  let snapshotCalls = 0;
  let runTestsCalls = 0;
  const testCommandArgs: ChangedFile[][] = [];
  const runTestsArgs: string[][] = [];
  const deps: JudgeDeps = {
    snapshot: () => {
      const treeHash = snapshots[Math.min(snapshotCalls, snapshots.length - 1)]!;
      snapshotCalls++;
      return { treeHash, files: options.files };
    },
    readText: reader(options.contents),
    testCommand: (kept) => {
      testCommandArgs.push(kept);
      return "testCommand" in options ? options.testCommand! : derived;
    },
    runTests: async (argv) => {
      runTestsCalls++;
      runTestsArgs.push(argv);
      return (options.runTests ?? (async () => passing))(argv);
    },
  };
  return {
    deps,
    snapshotCalls: () => snapshotCalls,
    runTestsCalls: () => runTestsCalls,
    testCommandArgs: () => testCommandArgs,
    runTestsArgs: () => runTestsArgs,
  };
}

describe("judgeWorkTree", () => {
  test("SC-006 publishes a nine-file shape: 9 files, 517 lines, tests pass, none committed", async () => {
    const files = [
      file("src/work/a.ts", { added: 100, deleted: 0 }),
      file("src/work/b.ts", { added: 100, deleted: 0 }),
      file("src/work/c.ts", { added: 100, deleted: 0 }),
      file("src/work/d.ts", { added: 50, deleted: 10 }),
      file("src/work/e.ts", { added: 50, deleted: 7 }),
      file("src/work/f.ts", { added: 50, deleted: 0 }),
      file("__tests__/work/a.test.ts", { added: 25, deleted: 0 }),
      file("__tests__/work/b.test.ts", { added: 25, deleted: 0 }),
      file("openspec/changes/x/tasks.md", { added: 0, deleted: 0 }),
    ];
    const f = fakes({ files });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({
      ok: true,
      treeHash: FIRST_HASH,
      files,
      generated: [],
      testOutput: " 3 pass\n 0 fail\n",
    });
  });

  test("SC-007 fails an empty change as no-change without running tests", async () => {
    const f = fakes({ files: [] });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({ ok: false, check: "no-change", detail: expect.any(String) });
    expect(f.runTestsCalls()).toBe(0);
  });

  test("SC-009 fails a workflow file as denied-path without running tests", async () => {
    const f = fakes({ files: [file(".github/workflows/ci.yml")] });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({ ok: false, check: "denied-path", detail: expect.stringContaining(".github/workflows/ci.yml") });
    expect(f.runTestsCalls()).toBe(0);
    expect(f.snapshotCalls()).toBe(1);
  });

  test("SC-011 fails a token in a file as secret-found without running tests, and leaks neither the token nor output", async () => {
    const f = fakes({
      files: [file("src/config.ts")],
      contents: { "src/config.ts": `export const token = "${fakeToken}";\n` },
      runTests: async () => ({ ok: true, output: `stderr: ${fakeToken}\n` }),
    });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.check).toBe("secret-found");
    expect(outcome.detail).not.toContain(fakeToken);
    expect(f.runTestsCalls()).toBe(0);
    expect(f.snapshotCalls()).toBe(1);
  });

  test("SC-012 fails a non-zero test run as tests-failed, never copying the output", async () => {
    const f = fakes({
      files: [file("src/work/x.ts")],
      runTests: async () => ({ ok: false, check: "tests-failed", output: "1 pass\n2 fail\nsecret-free noise\n" }),
    });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({ ok: false, check: "tests-failed", detail: "the derived tests did not pass" });
  });

  test("SC-013 fails a still-running test command as tests-timeout", async () => {
    const f = fakes({
      files: [file("src/work/x.ts")],
      runTests: async () => ({ ok: false, check: "tests-timeout", output: "waiting\n" }),
    });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({ ok: false, check: "tests-timeout", detail: "the derived tests did not pass" });
  });

  test("SC-014 fails as no-tests when no test command can be derived", async () => {
    const f = fakes({ files: [file("src/work/x.ts")], testCommand: null });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({ ok: false, check: "no-tests", detail: "no test command could be derived" });
    expect(f.runTestsCalls()).toBe(0);
  });

  test("SC-014 fails as no-tests when the run reports zero tests", async () => {
    const f = fakes({
      files: [file("src/work/x.ts")],
      runTests: async () => ({ ok: false, check: "no-tests", output: "0 pass\n0 fail\n" }),
    });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({ ok: false, check: "no-tests", detail: "the derived tests did not pass" });
  });

  test("SC-031 fails as tree-changed when the second snapshot hash differs", async () => {
    const f = fakes({ files: [file("__tests__/work/x.test.ts")], secondHash: SECOND_HASH });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome).toEqual({
      ok: false,
      check: "tree-changed",
      detail: "the work tree changed while the tests ran",
    });
    expect(f.snapshotCalls()).toBe(2);
    expect(f.runTestsCalls()).toBe(1);
  });

  test("G-1 judges 2 real files beside 183 generated .orca-verify.json files as ok", async () => {
    const generatedPaths = Array.from({ length: 183 }, (_, index) => `openspec/changes/c${index}/.orca-verify.json`);
    const kept = [file("scripts/dr/live-probes.ts"), file("__tests__/dr/live-probes.test.ts")];
    const generated = generatedPaths.map((path) => file(path));
    const f = fakes({ files: [...kept, ...generated] });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.files.map((item) => item.path)).toEqual(kept.map((item) => item.path));
    expect(outcome.generated.map((item) => item.path)).toEqual(generatedPaths);
  });

  test("calls snapshot exactly twice on success", async () => {
    const f = fakes({ files: [file("src/work/x.ts")] });

    await judgeWorkTree(f.deps);

    expect(f.snapshotCalls()).toBe(2);
  });

  test("gives testCommand the kept files, never the generated ones", async () => {
    const kept = [file("src/work/x.ts"), file("__tests__/work/x.test.ts")];
    const f = fakes({ files: [file("a/.orca-verify.json"), ...kept, file("b/.orca-verify.json")] });

    await judgeWorkTree(f.deps);

    expect(f.testCommandArgs()).toHaveLength(1);
    expect(f.testCommandArgs()[0]!.map((item) => item.path)).toEqual(kept.map((item) => item.path));
  });

  test("runs exactly the argv testCommand returned", async () => {
    const argv = ["bun", "test", "./__tests__/work/a.test.ts", "./__tests__/work/b.test.ts"];
    const f = fakes({ files: [file("src/work/x.ts")], testCommand: argv });

    await judgeWorkTree(f.deps);

    expect(f.runTestsArgs()).toEqual([argv]);
  });

  test("redacts the test output of a success", async () => {
    const f = fakes({
      files: [file("src/work/x.ts")],
      runTests: async () => ({ ok: true, output: `3 pass\nleaked ${fakeToken}\n` }),
    });

    const outcome = await judgeWorkTree(f.deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.testOutput).not.toContain(fakeToken);
    expect(outcome.testOutput).toContain("[redacted]");
  });

  test("no failure detail contains the test output", async () => {
    const output = `some failing output ${fakeToken} and a stack trace\n`;
    for (const [files, command, run] of [
      [[], derived, passing],
      [[file(".github/workflows/ci.yml")], derived, passing],
      [[file("src/config.ts")], derived, passing],
      [[file("src/work/x.ts")], null, passing],
      [
        [file("src/work/x.ts")],
        derived,
        async () => ({ ok: false as const, check: "tests-failed" as const, output }),
      ],
    ] as const) {
      const f = fakes({
        files: files as ChangedFile[],
        contents: { "src/config.ts": `export const token = "${fakeToken}";\n` },
        testCommand: command as string[] | null,
        runTests: run as (argv: string[]) => Promise<TestOutcome>,
      });
      const outcome = await judgeWorkTree(f.deps);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a failure");
      expect(outcome.detail).not.toContain(fakeToken);
      expect(outcome.detail).not.toContain("stack trace");
    }
  });
});

describe("generated files and the snapshot hash", () => {
  test("an equal hash with different generated files in the second listing is still ok", async () => {
    const real = file("src/work/x.ts");
    const lists = [
      [real, file("openspec/changes/a/.orca-verify.json")],
      [real, file("openspec/changes/b/.orca-verify.json")],
    ];
    let call = 0;
    const base = fakes({ files: [real] });
    const outcome = await judgeWorkTree({
      ...base.deps,
      snapshot: () => ({ treeHash: FIRST_HASH, files: lists[Math.min(call++, 1)]! }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.files.map((item) => item.path)).toEqual(["src/work/x.ts"]);
    expect(outcome.generated.map((item) => item.path)).toEqual(["openspec/changes/a/.orca-verify.json"]);
  });

  test("a different hash still fails as tree-changed even when only the file lists look alike", async () => {
    const real = file("src/work/x.ts");
    let call = 0;
    const base = fakes({ files: [real] });
    const outcome = await judgeWorkTree({
      ...base.deps,
      snapshot: () => ({ treeHash: call++ === 0 ? FIRST_HASH : SECOND_HASH, files: [real] }),
    });
    expect(outcome).toMatchObject({ ok: false, check: "tree-changed" });
  });
});
