/**
 * Harness qualification (anima #72): decides whether a stock harness runtime may host ANIMA agents.
 *
 * The comparison of 2026-10-11 recommends Pi, qualified at 1.1.x in an isolated profile, with Crush as the
 * fallback. This module does not run the harness: it judges the evidence a qualification run leaves behind, so a
 * "pass" needs a recorded exit code and output for every required step, and a decision names its reasons either way.
 * The same shape as scripts/mesh-cross-runtime-smoke.ts: the runner collects the evidence, this judges it.
 */

import { scanSecrets, redactSecrets } from "../src/work/publish-secrets";

export type StepId =
  | "launch"
  | "prompt"
  | "settled-report"
  | "revision-1"
  | "revision-2"
  | "cancellation"
  | "resume"
  | "codemode-store"
  | "codemode-load"
  | "codemode-load-after-resume"
  | "tool-denial"
  | "strong-model"
  | "extension-compat"
  | "global-install-unchanged";

/** Every step a qualification run must record, in report order. */
export const REQUIRED_STEPS: StepId[] = [
  "launch",
  "prompt",
  "settled-report",
  "revision-1",
  "revision-2",
  "cancellation",
  "resume",
  "codemode-store",
  "codemode-load",
  "codemode-load-after-resume",
  "tool-denial",
  "strong-model",
  "extension-compat",
];

/** Steps that live inside one session: they must all name the same session ID. */
const SESSION_STEPS = new Set<StepId>([
  "launch",
  "prompt",
  "settled-report",
  "revision-1",
  "revision-2",
  "resume",
  "codemode-store",
  "codemode-load",
  "codemode-load-after-resume",
]);

/** A step optional in the record: judged when present, not required. */
const OPTIONAL_STEPS: StepId[] = ["global-install-unchanged"];

export interface QualificationStep {
  id: StepId;
  /** Raw command output kept as evidence; a pass without output does not count. */
  output: string;
  /** The process exit code; null or absent means the result was not recorded. */
  exitCode: number | null;
  sessionId?: string;
}

export interface QualificationRun {
  platform: "mac-mini" | "windows";
  harness: string;
  version: string;
  /** Profile the qualified harness was installed into; must not touch the global install. */
  isolatedProfile: string;
  /** The global install that must stay untouched. */
  globalProfile: string;
  steps: QualificationStep[];
  globalInstallDigestBefore?: string;
  globalInstallDigestAfter?: string;
}

export interface QualificationResult {
  pass: boolean;
  failures: string[];
}

export interface HarnessDecision {
  harness: "pi" | "crush";
  reasons: string[];
}

const PI_VERSION = /^1\.1\.\d+$/;

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}

/** One failure per step, so a report line stays a single reason. */
function judgeStep(step: QualificationStep, expectedSession: string | undefined): string | undefined {
  if (step.output.trim() === "") return `${step.id}: a pass without output does not count`;
  const credential = scanSecrets(step.output);
  if (credential) return `${step.id}: output contains a credential (${credential})`;
  if (step.exitCode === null || step.exitCode === undefined) return `${step.id}: no exit code recorded`;
  if (step.exitCode !== 0) return `${step.id}: exited ${step.exitCode}`;
  if (SESSION_STEPS.has(step.id)) {
    if (!step.sessionId) return `${step.id}: no session ID recorded`;
    if (expectedSession && step.sessionId !== expectedSession) {
      return `${step.id}: session ${step.sessionId}, expected ${expectedSession}`;
    }
  }
  return undefined;
}

export function evaluateQualification(run: QualificationRun): QualificationResult {
  const failures: string[] = [];

  if (!PI_VERSION.test(run.version)) failures.push(`version ${run.version} is not 1.1.x`);

  if (!isAbsolutePath(run.isolatedProfile)) {
    failures.push("isolated profile must be an absolute path");
  } else {
    const isolated = normalisePath(run.isolatedProfile);
    const global = normalisePath(run.globalProfile);
    if (isolated === global) failures.push("isolated profile is the global install");
    else if (isolated.startsWith(`${global}/`)) failures.push("isolated profile is inside the global install");
  }

  const firstSession = run.steps.find((step) => SESSION_STEPS.has(step.id) && step.sessionId)?.sessionId;
  for (const id of REQUIRED_STEPS) {
    const step = run.steps.find((candidate) => candidate.id === id);
    if (!step) {
      failures.push(`${id}: missing`);
      continue;
    }
    const failure = judgeStep(step, firstSession);
    if (failure) failures.push(failure);
  }
  for (const id of OPTIONAL_STEPS) {
    const step = run.steps.find((candidate) => candidate.id === id);
    if (!step) continue;
    const failure = judgeStep(step, firstSession);
    if (failure) failures.push(failure);
  }

  if (!run.globalInstallDigestBefore || !run.globalInstallDigestAfter) {
    failures.push("global install digest was not recorded");
  } else if (run.globalInstallDigestBefore !== run.globalInstallDigestAfter) {
    failures.push(`global install changed: ${run.globalInstallDigestBefore} -> ${run.globalInstallDigestAfter}`);
  }

  return { pass: failures.length === 0, failures };
}

function stepOf(run: QualificationRun, failure: string): QualificationStep | undefined {
  const id = failure.split(": ", 1)[0];
  return run.steps.find((step) => step.id === id);
}

/**
 * Pi only when every Mac Mini run qualifies and no Windows failure is unrecorded. A Windows check that failed
 * with its output kept is a recorded failure, not a blocker, per the issue's Windows criterion.
 */
export function decideHarness(runs: QualificationRun[]): HarnessDecision {
  const reasons: string[] = [];
  let pi = runs.length > 0;

  for (const run of runs.filter((candidate) => candidate.platform === "mac-mini")) {
    if (run.harness !== "pi") {
      pi = false;
      reasons.push(`mac-mini: harness ${run.harness} is not pi`);
      continue;
    }
    const result = evaluateQualification(run);
    if (result.pass) reasons.push(`mac-mini: pi ${run.version} passed ${REQUIRED_STEPS.length} checks`);
    else {
      pi = false;
      for (const failure of result.failures) reasons.push(`mac-mini: ${failure}`);
    }
  }
  if (!runs.some((candidate) => candidate.platform === "mac-mini")) {
    pi = false;
    reasons.push("mac-mini: not run");
  }

  const windows = runs.filter((candidate) => candidate.platform === "windows");
  if (windows.length === 0) {
    reasons.push("windows: not run");
  }
  for (const run of windows) {
    if (run.harness !== "pi") {
      pi = false;
      reasons.push(`windows: harness ${run.harness} is not pi`);
      continue;
    }
    const result = evaluateQualification(run);
    if (result.pass) {
      reasons.push(`windows: pi ${run.version} passed ${REQUIRED_STEPS.length} checks`);
      continue;
    }
    for (const failure of result.failures) {
      const step = stepOf(run, failure);
      const recorded = step !== undefined && step.output.trim() !== "" && typeof step.exitCode === "number";
      if (recorded) reasons.push(`windows: ${step.id} exited ${step.exitCode}, recorded`);
      else {
        pi = false;
        reasons.push(`windows: ${failure}`);
      }
    }
  }

  return { harness: pi ? "pi" : "crush", reasons };
}

function cell(text: string): string {
  return redactSecrets(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ").replace(/\|/g, "\\|").slice(0, 200);
}

/** The recorded decision and the evidence behind it. The report never repeats a credential: output is redacted. */
export function renderReport(runs: QualificationRun[]): string {
  const decision = decideHarness(runs);
  const lines = ["# Harness qualification report", "", `decision: ${decision.harness}`, "", "## Reasons", ""];
  for (const reason of decision.reasons) lines.push(`- ${reason}`);
  lines.push("");
  for (const run of runs) {
    const result = evaluateQualification(run);
    lines.push(`## ${run.platform} — ${run.harness} ${run.version}`, "", `result: ${result.pass ? "pass" : "fail"}`, "");
    lines.push("| step | exit | output |", "| --- | --- | --- |");
    const ids = [...REQUIRED_STEPS, ...OPTIONAL_STEPS];
    for (const id of ids) {
      const step = run.steps.find((candidate) => candidate.id === id);
      if (!step && OPTIONAL_STEPS.includes(id)) continue;
      const exit = step?.exitCode ?? "missing";
      lines.push(`| ${id} | ${exit} | ${cell(step?.output ?? "")} |`);
    }
    for (const failure of result.failures) lines.push("", `- ${redactSecrets(failure)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The runner writes evidence as `{ "runs": [...] }`; this reads it back so the judgement runs on the record, not on
 * a summary of it. Evidence that is not a run list is refused, never judged as a pass.
 */
export function loadRuns(text: string): QualificationRun[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("evidence is not JSON");
  }
  const runs = (parsed as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) throw new Error("evidence has no runs array");
  runs.forEach((run, index) => {
    if (typeof run !== "object" || run === null) throw new Error(`run ${index} has no steps`);
    const record = run as Record<string, unknown>;
    if (record.platform !== "mac-mini" && record.platform !== "windows") throw new Error(`run ${index} has no platform`);
    for (const field of ["harness", "version", "isolatedProfile", "globalProfile"] as const) {
      if (typeof record[field] !== "string") throw new Error(`run ${index} has no ${field}`);
    }
    if (!Array.isArray(record.steps)) throw new Error(`run ${index} has no steps`);
    if (record.steps.some((step) => typeof step !== "object" || step === null || typeof (step as { id?: unknown }).id !== "string")) {
      throw new Error(`run ${index} has no steps`);
    }
  });
  return runs as QualificationRun[];
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun scripts/harness-qualification.ts <evidence.json>");
    process.exit(2);
  }
  let runs: QualificationRun[];
  try {
    runs = loadRuns(await Bun.file(path).text());
  } catch (error) {
    console.error(`harness qualification could not read evidence: ${error instanceof Error ? error.message : String(error)} (this is not a pass)`);
    process.exit(2);
  }
  console.log(renderReport(runs));
  process.exit(decideHarness(runs).harness === "pi" ? 0 : 1);
}
