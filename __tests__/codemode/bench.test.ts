/**
 * anima #427, codemode guest trust: the measurement harness.
 *
 * The harness must be runnable with no live service, must never invent a number it did not measure, and must
 * print rounds, wall time, tokens and pass rate per run and per arm. These tests use the offline scripted
 * planner, so no test here reaches a model or the network.
 */

import { test, expect, describe } from "bun:test";
import {
  ARMS,
  BENCH_TASKS,
  formatReport,
  localTools,
  runBench,
  runArm,
  scriptedPlanner,
  type BenchTask,
} from "../../src/codemode/bench";

describe("fixed task set", () => {
  test("the set is fixed, with unique ids, prompts and a hidden check per task", () => {
    expect(BENCH_TASKS.length).toBeGreaterThanOrEqual(5);
    const ids = BENCH_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of BENCH_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(typeof task.check).toBe("function");
    }
  });

  test("the three arms are fixed and the baseline arm is first", () => {
    expect(ARMS).toEqual(["direct-tools", "program-tool", "assistant-code-mode"]);
  });
});

describe("offline run", () => {
  test("a scripted planner runs the fixed set with no remote service and passes every task", async () => {
    const report = await runBench({ planner: scriptedPlanner(), runs: 2 });
    const direct = report.arms.find((arm) => arm.arm === "direct-tools")!;
    expect(direct.skipped).toBeUndefined();
    expect(direct.runs).toHaveLength(2);
    expect(direct.passRate).toBe(1);
    expect(report.model).toBe("scripted");
    expect(report.runs).toBe(2);
    for (const run of direct.runs) expect(run.tasks).toHaveLength(BENCH_TASKS.length);
  });

  test("the scripted planner takes more than one round, so rounds are really counted", async () => {
    const report = await runBench({ planner: scriptedPlanner(), runs: 1 });
    const direct = report.arms.find((arm) => arm.arm === "direct-tools")!;
    expect(direct.rounds).toBeGreaterThan(BENCH_TASKS.length);
  });

  test("tokens with no provider are reported as not reported, never invented", async () => {
    const report = await runBench({ planner: scriptedPlanner(), runs: 1 });
    for (const arm of report.arms) expect(arm.tokens).toBeUndefined();
    expect(formatReport(report)).toContain("not reported");
  });

  test("the two later arms are skipped with a reason instead of a stand-in number", async () => {
    const report = await runBench({ planner: scriptedPlanner(), runs: 1 });
    for (const name of ["program-tool", "assistant-code-mode"] as const) {
      const arm = report.arms.find((a) => a.arm === name)!;
      expect(arm.skipped).toBeDefined();
      expect(arm.runs).toEqual([]);
      expect(arm.rounds).toBe(0);
    }
  });

  test("a check that throws counts as a failure (fail closed)", async () => {
    const broken: BenchTask = { id: "broken", prompt: "do nothing", check: () => { throw new Error("boom"); } };
    const report = await runArm("direct-tools", scriptedPlanner(), { runs: 1, tasks: [broken] });
    expect(report.passRate).toBe(0);
    expect(report.runs[0]!.tasks[0]!.passed).toBe(false);
  });

  test("a planner that reports tokens has them summed per run and per arm", async () => {
    const planner = {
      name: "scripted",
      next: async () => ({ calls: [], done: true, tokens: { input: 10, output: 5 } }),
    };
    const report = await runArm("direct-tools", planner, { runs: 2, tasks: BENCH_TASKS.slice(0, 2) });
    expect(report.runs[0]!.tokens).toEqual({ input: 20, output: 10 });
    expect(report.tokens).toEqual({ input: 40, output: 20 });
  });

  test("the round cap stops a planner that never finishes", async () => {
    const looping = { name: "scripted", next: async () => ({ calls: [{ name: "read" as const, args: { path: "util.ts" } }] }) };
    const report = await runArm("direct-tools", looping, { runs: 1, tasks: [BENCH_TASKS[0]!], maxRounds: 3 });
    expect(report.runs[0]!.tasks[0]!.rounds).toBe(3);
  });
});

describe("the printed report", () => {
  test("prints the model, the run count, and rounds, wall time, tokens and pass rate per run and per arm", async () => {
    const report = await runBench({ planner: scriptedPlanner(), runs: 2 });
    const text = formatReport(report);
    expect(text).toContain("model scripted");
    expect(text).toContain("2 run(s)");
    expect(text).toContain("arm direct-tools");
    expect(text).toContain("run 1: rounds");
    expect(text).toContain("run 2: rounds");
    expect(text).toMatch(/wall \d+ ms/);
    expect(text).toContain("tokens not reported");
    expect(text).toMatch(/pass rate \d+%/);
    expect(text).toContain("total: rounds");
    expect(text).toContain("arm program-tool: skipped");
  });
});

describe("local tools", () => {
  test("a path outside the scratch tree is refused", () => {
    const run = localTools("/tmp/codemode-bench-a");
    expect(run({ name: "read", args: { path: "../etc/hosts" } }).ok).toBe(false);
    expect(run({ name: "read", args: { path: "/etc/hosts" } }).ok).toBe(false);
  });
});
