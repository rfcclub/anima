/**
 * Measurement harness for a model-written program tool (anima #427, codemode guest trust).
 *
 * The program tool is measured against direct tool calls on one fixed task set. The set, the arms and the
 * metrics are fixed here, before any product code for the program tool exists, so a later slice cannot
 * choose a task set that favours its own arm.
 *
 * Three arms:
 * - `direct-tools`: the model calls the work tools one at a time (this slice's baseline).
 * - `program-tool`: one model-written program that calls the same tools. No product code yet; the arm
 *   reports `skipped` with a reason rather than a fake number.
 * - `assistant-code-mode`: the owner's own assistant code mode, where applicable. Also not wired here.
 *
 * Everything about the run is injected (`planner`, `tools`, `now`) so the harness can be exercised offline
 * against a scripted planner: no remote service is needed to run it, and no test of it reaches a model.
 * The tokens a scripted planner reports are `undefined`, never invented.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute, sep } from "node:path";

export type Arm = "direct-tools" | "program-tool" | "assistant-code-mode";

export const ARMS: readonly Arm[] = ["direct-tools", "program-tool", "assistant-code-mode"];

/** A tool call the planner asks the host to run. Same names as the work tools. */
export interface BenchCall {
  name: "read" | "write" | "edit" | "bash";
  args: Record<string, unknown>;
}

/** What a planner (a model, or a scripted stand-in) produced for one round. */
export interface PlannerRound {
  calls: BenchCall[];
  /** The planner is finished with the task. */
  done?: boolean;
  /** Provider-reported tokens, when there is a provider. Never estimated here. */
  tokens?: { input: number; output: number };
  /** The planner's final message, for the transcript of a failing task. */
  text?: string;
}

export interface Planner {
  /** Identifier recorded with the result: a model name, or `scripted` for the offline stand-in. */
  readonly name: string;
  /** One round: what to do next, given the task and what the tools returned. */
  next(input: { task: BenchTask; round: number; observations: string[] }): Promise<PlannerRound>;
}

/** A tool-carrying task with a hidden check. The check text is never part of the prompt. */
export interface BenchTask {
  id: string;
  /** What the model is asked, verbatim. */
  prompt: string;
  /** Hidden check over the finished tree: true when the task was done correctly. */
  check(tree: string): boolean;
}

const read = (tree: string, path: string) => readFileSync(join(tree, path), "utf-8");

/**
 * The fixed set. Deliberately mixed: small edits, a search, a created file and a counted aggregate, so an
 * arm cannot win by being better at one shape of task.
 */
export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: "rename-symbol",
    prompt: "In util.ts, rename the exported function oldName to newName and keep every caller working.",
    check: (tree) => read(tree, "util.ts").includes("export function newName") && !read(tree, "util.ts").includes("oldName"),
  },
  {
    id: "fix-off-by-one",
    prompt: "sum.ts sums an array but skips the last element. Fix it.",
    check: (tree) => read(tree, "sum.ts").includes("i < values.length") || read(tree, "sum.ts").includes("reduce("),
  },
  {
    id: "extract-constant",
    prompt: "Replace the repeated retry delay 250 in worker.ts with a single named constant.",
    check: (tree) => {
      const text = read(tree, "worker.ts");
      return /const\s+(RETRY_DELAY|RETRY_MS|DELAY_MS)/.test(text) && (text.match(/\b250\b/g) ?? []).length <= 1;
    },
  },
  {
    id: "find-callers",
    prompt: "List every file that imports parseConfig, and write the list, one path per line, to callers.txt.",
    check: (tree) => existsSync(join(tree, "callers.txt")) && read(tree, "callers.txt").split("\n").map((l) => l.trim()).filter(Boolean).sort().join(",") === "a.ts,b.ts",
  },
  {
    id: "count-todos",
    prompt: "Count the TODO comments under notes/ and write just the number to todo-count.txt.",
    check: (tree) => existsSync(join(tree, "todo-count.txt")) && read(tree, "todo-count.txt").trim() === "3",
  },
  {
    id: "add-test-case",
    prompt: "Add a test to calc.test.ts that covers dividing by zero.",
    check: (tree) => /zero|0\)/.test(read(tree, "calc.test.ts").slice(read(tree, "calc.test.ts").indexOf("test("))) && read(tree, "calc.test.ts").includes("toThrow"),
  },
];

/** The fixture tree each run starts from. Small, deterministic, and free of any real path or secret. */
export const FIXTURE: Record<string, string> = {
  "util.ts": "export function oldName(value: number): number {\n  return value * 2;\n}\n",
  "sum.ts": "export function sum(values: number[]): number {\n  let total = 0;\n  for (let i = 0; i < values.length - 1; i += 1) total += values[i]!;\n  return total;\n}\n",
  "worker.ts": "export async function work(): Promise<void> {\n  await wait(250);\n  await wait(250);\n  await wait(250);\n}\n",
  "a.ts": "import { parseConfig } from './config';\nexport const a = parseConfig;\n",
  "b.ts": "import { parseConfig } from './config';\nexport const b = parseConfig;\n",
  "c.ts": "export const c = 3;\n",
  "config.ts": "export function parseConfig(): Record<string, string> {\n  return {};\n}\n",
  "calc.test.ts": "import { test, expect } from 'bun:test';\nimport { divide } from './calc';\n\ntest('divides', () => {\n  expect(divide(6, 2)).toBe(3);\n});\n",
  "calc.ts": "export function divide(a: number, b: number): number {\n  return a / b;\n}\n",
  "notes/one.md": "TODO one\nTODO two\n",
  "notes/two.md": "TODO three\n",
};

/** One task's result in one run. */
export interface TaskRun {
  task: string;
  passed: boolean;
  rounds: number;
  wallMs: number;
  tokens?: { input: number; output: number };
}

export interface ArmReport {
  arm: Arm;
  /** One entry per run; each run covers every task. */
  runs: { run: number; tasks: TaskRun[]; rounds: number; wallMs: number; tokens?: { input: number; output: number }; passRate: number }[];
  rounds: number;
  wallMs: number;
  tokens?: { input: number; output: number };
  passRate: number;
  /** Set when the arm could not be run honestly. Never a stand-in number. */
  skipped?: string;
}

export interface BenchReport {
  /** The planner (model) recorded with every number, so a later run can be compared. */
  model: string;
  runs: number;
  arms: ArmReport[];
  /** ISO date of the run. */
  at: string;
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export interface BenchOptions {
  runs?: number;
  /** Rounds after which a task is treated as unfinished (rounds are the metric the program tool targets). */
  maxRounds?: number;
  /** Per-task wall limit. */
  taskDeadlineMs?: number;
  planner: Planner;
  tasks?: readonly BenchTask[];
  /** Injected clock, so a test can measure without waiting. */
  now?: () => number;
  /** Arms to run; the two later arms are skipped by default because this slice ships no product code. */
  arms?: Partial<Record<Arm, Planner>>;
}

const ROUND_CAP = 20;

/** A filesystem tool runner confined to one scratch tree. It is not a boundary: the escape suite proves that. */
export function localTools(tree: string): (call: BenchCall) => ToolOutcome {
  const inside = (path: string): string => {
    const full = resolve(tree, path);
    const rel = relative(tree, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new RangeError(`path escapes the scratch tree: ${path}`);
    return full;
  };
  return (call) => {
    try {
      switch (call.name) {
        case "read": {
          const text = readFileSync(inside(String(call.args.path ?? "")), "utf-8");
          return { ok: true, text: text.slice(0, 20_000) };
        }
        case "write": {
          const full = inside(String(call.args.path ?? ""));
          mkdirSync(join(full, ".."), { recursive: true });
          writeFileSync(full, String(call.args.content ?? ""));
          return { ok: true, text: `wrote ${full.slice(tree.length + 1).split(sep).join("/")}` };
        }
        case "edit": {
          const full = inside(String(call.args.path ?? ""));
          const before = readFileSync(full, "utf-8");
          const old = String(call.args.old_string ?? "");
          if (!before.includes(old)) return { ok: false, text: "old_string not found" };
          writeFileSync(full, before.replace(old, String(call.args.new_string ?? "")));
          return { ok: true, text: "edited" };
        }
        case "bash":
          // Shell commands are not run offline: the harness measures model rounds, not a shell.
          return { ok: false, text: "bash is not available in the offline harness" };
        default:
          return { ok: false, text: `unknown tool ${String(call.name)}` };
      }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  };
}

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "codemode-bench-")));
  return base;
}

function writeFixture(tree: string): void {
  for (const [path, text] of Object.entries(FIXTURE)) {
    const full = join(tree, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
}

/** One task in one run: the planner's rounds against fresh tools, then the hidden check. */
async function runTask(
  planner: Planner,
  task: BenchTask,
  options: { maxRounds: number; deadlineMs: number; now: () => number },
): Promise<TaskRun & { transcript: string }> {
  const base = scratch();
  const tree = join(base, "tree");
  mkdirSync(tree, { recursive: true });
  writeFixture(tree);
  const tools = localTools(tree);
  const started = options.now();
  const observations: string[] = [];
  const transcript: string[] = [];
  let rounds = 0;
  let tokens: { input: number; output: number } | undefined;
  try {
    while (rounds < options.maxRounds && options.now() - started < options.deadlineMs) {
      rounds += 1;
      const round = await planner.next({ task, round: rounds, observations: [...observations] });
      if (round.tokens) {
        tokens = { input: (tokens?.input ?? 0) + round.tokens.input, output: (tokens?.output ?? 0) + round.tokens.output };
      }
      for (const call of round.calls) {
        const outcome = tools(call);
        observations.push(`${call.name} ${outcome.ok ? "ok" : "error"}: ${outcome.text}`);
        transcript.push(`round ${rounds} ${call.name} ${JSON.stringify(call.args)} -> ${outcome.text}`);
      }
      if (round.text) transcript.push(`round ${rounds} text: ${round.text}`);
      if (round.done) break;
      if (round.calls.length === 0) break; // a planner that asks for nothing is finished, not looped forever
    }
    let passed = false;
    try {
      passed = task.check(tree);
    } catch {
      passed = false; // a check that cannot run counts as a failure
    }
    return { task: task.id, passed, rounds, wallMs: options.now() - started, ...(tokens ? { tokens } : {}), transcript: transcript.join("\n") };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function sumTokens(tasks: TaskRun[]): { input: number; output: number } | undefined {
  const withTokens = tasks.filter((t) => t.tokens);
  if (withTokens.length !== tasks.length) return undefined;
  return withTokens.reduce((acc, t) => ({ input: acc.input + t.tokens!.input, output: acc.output + t.tokens!.output }), { input: 0, output: 0 });
}

/** Run the fixed set against one arm, `runs` times. */
export async function runArm(arm: Arm, planner: Planner | undefined, options: BenchOptions): Promise<ArmReport> {
  if (!planner) {
    return {
      arm,
      runs: [],
      rounds: 0,
      wallMs: 0,
      passRate: 0,
      skipped: arm === "direct-tools" ? "no planner given" : "no product code for this arm in this slice (#427 ships the decision, not the tool)",
    };
  }
  const now = options.now ?? (() => Date.now());
  const runs = options.runs ?? 3;
  const tasks = options.tasks ?? BENCH_TASKS;
  const maxRounds = options.maxRounds ?? ROUND_CAP;
  const deadlineMs = options.taskDeadlineMs ?? 60_000;
  const results: ArmReport["runs"] = [];
  for (let run = 1; run <= runs; run += 1) {
    const taskRuns: TaskRun[] = [];
    for (const task of tasks) {
      const { transcript: _transcript, ...result } = await runTask(planner, task, { maxRounds, deadlineMs, now });
      taskRuns.push(result);
    }
    const tokens = sumTokens(taskRuns);
    results.push({
      run,
      tasks: taskRuns,
      rounds: taskRuns.reduce((n, t) => n + t.rounds, 0),
      wallMs: taskRuns.reduce((n, t) => n + t.wallMs, 0),
      ...(tokens ? { tokens } : {}),
      passRate: taskRuns.filter((t) => t.passed).length / taskRuns.length,
    });
  }
  const everyTask = results.flatMap((r) => r.tasks);
  const tokens = sumTokens(everyTask);
  return {
    arm,
    runs: results,
    rounds: results.reduce((n, r) => n + r.rounds, 0),
    wallMs: results.reduce((n, r) => n + r.wallMs, 0),
    ...(tokens ? { tokens } : {}),
    passRate: everyTask.filter((t) => t.passed).length / everyTask.length,
  };
}

/** Run every arm on the fixed set. */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const runs = options.runs ?? 3;
  const arms: ArmReport[] = [];
  for (const arm of ARMS) {
    const planner = arm === "direct-tools" ? options.planner : options.arms?.[arm];
    arms.push(await runArm(arm, planner, options));
  }
  return { model: options.planner.name, runs, arms, at: new Date(options.now ? options.now() : Date.now()).toISOString() };
}

const tokensText = (tokens?: { input: number; output: number }) =>
  tokens ? `${tokens.input} in / ${tokens.output} out` : "not reported";

/** The printed report: per run and per arm, then the arm total. */
export function formatReport(report: BenchReport): string {
  const lines = [`codemode bench: model ${report.model}, ${report.runs} run(s) of ${BENCH_TASKS.length} fixed tasks, ${report.at}`];
  for (const arm of report.arms) {
    if (arm.skipped) {
      lines.push(`arm ${arm.arm}: skipped (${arm.skipped})`);
      continue;
    }
    lines.push(`arm ${arm.arm}`);
    for (const run of arm.runs) {
      lines.push(
        `  run ${run.run}: rounds ${run.rounds}, wall ${run.wallMs} ms, tokens ${tokensText(run.tokens)}, pass rate ${(run.passRate * 100).toFixed(0)}%`,
      );
    }
    lines.push(
      `  total: rounds ${arm.rounds}, wall ${arm.wallMs} ms, tokens ${tokensText(arm.tokens)}, pass rate ${(arm.passRate * 100).toFixed(0)}%`,
    );
  }
  return lines.join("\n");
}

/**
 * The offline planner: a fixed sequence of tool calls per task, and nothing else.
 *
 * It exists so the harness can be run and tested with no model and no network. It reports no tokens, because
 * it has no provider; `scripted` is recorded as the model name so a real baseline can never be mistaken for it.
 */
const SCRIPTS: Record<string, BenchCall[][]> = {
  "rename-symbol": [
    [{ name: "read", args: { path: "util.ts" } }],
    [{ name: "edit", args: { path: "util.ts", old_string: "oldName", new_string: "newName" } }],
  ],
  "fix-off-by-one": [
    [{ name: "read", args: { path: "sum.ts" } }],
    [{ name: "edit", args: { path: "sum.ts", old_string: "i < values.length - 1", new_string: "i < values.length" } }],
  ],
  "extract-constant": [
    [{ name: "read", args: { path: "worker.ts" } }],
    [{
      name: "write",
      args: {
        path: "worker.ts",
        content:
          "const RETRY_DELAY = 250;\n\nexport async function work(): Promise<void> {\n  await wait(RETRY_DELAY);\n  await wait(RETRY_DELAY);\n  await wait(RETRY_DELAY);\n}\n",
      },
    }],
  ],
  "find-callers": [
    [{ name: "read", args: { path: "a.ts" } }, { name: "read", args: { path: "b.ts" } }, { name: "read", args: { path: "c.ts" } }],
    [{ name: "write", args: { path: "callers.txt", content: "a.ts\nb.ts\n" } }],
  ],
  "count-todos": [
    [{ name: "read", args: { path: "notes/one.md" } }, { name: "read", args: { path: "notes/two.md" } }],
    [{ name: "write", args: { path: "todo-count.txt", content: "3\n" } }],
  ],
  "add-test-case": [
    [{ name: "read", args: { path: "calc.test.ts" } }],
    [{
      name: "write",
      args: {
        path: "calc.test.ts",
        content:
          "import { test, expect } from 'bun:test';\nimport { divide } from './calc';\n\ntest('divides', () => {\n  expect(divide(6, 2)).toBe(3);\n});\n\ntest('dividing by zero does not throw a plain error', () => {\n  expect(() => divide(1, 0)).not.toThrow();\n});\n",
      },
    }],
  ],
};

/** A planner that replays the fixed script for a task, then says it is done. */
export function scriptedPlanner(): Planner {
  return {
    name: "scripted",
    async next({ task, round }) {
      const script = SCRIPTS[task.id] ?? [];
      const calls = script[round - 1];
      if (!calls) return { calls: [], done: true };
      return { calls, done: round >= script.length };
    },
  };
}

if (import.meta.main) {
  const arg = (name: string, fallback: number): number => {
    const at = process.argv.indexOf(`--${name}`);
    const raw = at === -1 ? undefined : process.argv[at + 1];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`--${name} must be a positive integer`);
    return value;
  };
  const report = await runBench({ planner: scriptedPlanner(), runs: arg("runs", 3) });
  console.log(formatReport(report));
}
