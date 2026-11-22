import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createHostTestRunner } from "../../src/work/publish-test-runner";
import { SANDBOX_BINARY } from "../../src/work/sandbox";

type Run = Parameters<typeof createHostTestRunner>[0]["run"];

function rig(result: { code: number | null; timedOut: boolean; output: string }) {
  const seen: { argv: string[]; cwd: string; ms: number; env: Record<string, string | undefined>; wrapped: string[] }[] = [];
  const run: Run = async (argv, cwd, ms, options) => {
    seen.push({ argv, cwd, ms, env: options?.env ?? {}, wrapped: options?.wrap ? options.wrap(argv) : argv });
    return result;
  };
  const runner = createHostTestRunner({
    run, denyReadRoots: [], parentEnv: { PATH: "/usr/bin:/bin", LANG: "C", GH_TOKEN: "ghp_" + "a".repeat(36), ANIMA_SECRET: "s" },
  });
  return { runner, seen };
}

describe("createHostTestRunner", () => {
  test("runs the derived argv in the tree with a 120 s timeout, under the write sandbox and a sanitized environment", async () => {
    const { runner, seen } = rig({ code: 0, timedOut: false, output: " 3 pass\n 0 fail\n" });
    const outcome = await runner(["bun", "test", "./__tests__/x.test.ts"], "/work/tree");

    expect(outcome).toEqual({ ok: true, output: " 3 pass\n 0 fail" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cwd).toBe("/work/tree");
    expect(seen[0]!.ms).toBe(120_000);
    expect(seen[0]!.argv).toEqual(["bun", "test", "./__tests__/x.test.ts"]);
    expect(seen[0]!.wrapped[0]).toBe(SANDBOX_BINARY);
    expect(seen[0]!.wrapped[1]).toBe("-p");
    expect(seen[0]!.wrapped.slice(-3)).toEqual(["bun", "test", "./__tests__/x.test.ts"]);
    expect(Object.keys(seen[0]!.env).sort()).toEqual(["GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(JSON.stringify(seen[0]!.env)).not.toContain("ghp_");
  });

  test("HOME and TMPDIR are a scratch directory that exists during the run and is removed after it", async () => {
    let during = false;
    const run: Run = async (_argv, _cwd, _ms, options) => {
      during = existsSync(options!.env!.HOME!);
      (globalThis as { scratch?: string }).scratch = options!.env!.HOME!;
      return { code: 0, timedOut: false, output: " 1 pass\n" };
    };
    await createHostTestRunner({ run, denyReadRoots: [], parentEnv: { PATH: "/usr/bin" } })(["bun", "test", "./x.test.ts"], "/work/tree");

    expect(during).toBe(true);
    expect(existsSync((globalThis as { scratch?: string }).scratch!)).toBe(false);
  });

  test("a non-zero exit, a timeout and a run without a passing test are named failures", async () => {
    expect(await rig({ code: 1, timedOut: false, output: "1 fail\n" }).runner(["bun", "test"], "/t")).toMatchObject({ ok: false, check: "tests-failed" });
    expect(await rig({ code: null, timedOut: true, output: "" }).runner(["bun", "test"], "/t")).toMatchObject({ ok: false, check: "tests-timeout" });
    expect(await rig({ code: 0, timedOut: false, output: "0 pass\n" }).runner(["bun", "test"], "/t")).toMatchObject({ ok: false, check: "no-tests" });
  });

  test("the scratch directory is removed even when the run throws", async () => {
    let scratch = "";
    const run: Run = async (_argv, _cwd, _ms, options) => {
      scratch = options!.env!.HOME!;
      throw new Error("spawn failed");
    };
    await expect(createHostTestRunner({ run, denyReadRoots: [], parentEnv: {} })(["bun", "test"], "/t")).rejects.toThrow("spawn failed");
    expect(existsSync(scratch)).toBe(false);
  });
});
