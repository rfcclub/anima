// Project status scanner — read-only walker over an OpenSpec/LoomKit tree.
// Produces a normalized snapshot consumed by the status API + dashboard UI.
// Parser failures become per-change warnings, never fatal (design D5).

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LifecycleState =
  | "draft"
  | "planned"
  | "in_progress"
  | "review"
  | "verified"
  | "archived"
  | "blocked";

export interface ArtifactPresence {
  proposal: boolean;
  design: boolean;
  tasks: boolean;
  specs: boolean;
}

export interface TaskProgress {
  total: number;
  completed: number;
  remaining: number;
  percent: number; // 0..100, 0 when unknown
  unknown: boolean; // true when tasks.md absent
}

export interface SpecCoverage {
  requirements: number;
  scenarios: number;
  missing: boolean; // true when no spec files
}

export interface Verification {
  verifyJsonPresent: boolean;
  traceabilityPresent: boolean;
  verified: boolean; // true only when verify gate == pass
  gate?: "pass" | "fail";
  specScenarios?: number;
  failedScenarios?: number;
}

export interface ChangeRecord {
  name: string;
  title: string;
  archived: boolean;
  lifecycle: LifecycleState;
  artifacts: ArtifactPresence;
  missingArtifacts: string[];
  taskProgress: TaskProgress;
  specCoverage: SpecCoverage;
  verification: Verification;
  warnings: string[];
  nextAction: string | null;
  path: string;
}

export interface Summary {
  active: number;
  archived: number;
  verified: number;
  draft: number;
  inProgress: number;
  planned: number;
  review: number;
  blocked: number;
}

export interface ProjectSnapshot {
  generatedAt: string;
  root: string;
  summary: Summary;
  activeChanges: ChangeRecord[];
  archivedChanges: ChangeRecord[];
}

const ARTIFACT_FILES = {
  proposal: "proposal.md",
  design: "design.md",
  tasks: "tasks.md",
} as const;

export function scanProjectStatus(root: string): ProjectSnapshot {
  const changesDir = join(root, "changes");
  const archiveDir = join(root, "archive");

  const activeChanges = existsSync(changesDir)
    ? listChangeDirs(changesDir).map((d) => scanChange(join(changesDir, d), d, false))
    : [];
  const archivedChanges = existsSync(archiveDir)
    ? listChangeDirs(archiveDir).map((d) => scanChange(join(archiveDir, d), d, true))
    : [];

  return {
    generatedAt: new Date().toISOString(),
    root,
    summary: summarize(activeChanges, archivedChanges),
    activeChanges,
    archivedChanges,
  };
}

function listChangeDirs(parent: string): string[] {
  return readdirSync(parent)
    .filter((entry) => {
      const p = join(parent, entry);
      return statSync(p).isDirectory() && !entry.startsWith(".");
    })
    .sort();
}

function scanChange(dir: string, name: string, archived: boolean): ChangeRecord {
  const warnings: string[] = [];

  const artifacts: ArtifactPresence = {
    proposal: existsSync(join(dir, ARTIFACT_FILES.proposal)),
    design: existsSync(join(dir, ARTIFACT_FILES.design)),
    tasks: existsSync(join(dir, ARTIFACT_FILES.tasks)),
    specs: hasSpecs(dir),
  };

  const missingArtifacts: string[] = [];
  if (!artifacts.proposal) missingArtifacts.push("proposal");
  if (!artifacts.design) missingArtifacts.push("design");
  if (!artifacts.tasks) missingArtifacts.push("tasks");
  if (!artifacts.specs) missingArtifacts.push("specs");

  const title = deriveTitle(dir, name);
  const taskProgress = parseTaskProgress(dir, warnings);
  const specCoverage = countSpecCoverage(dir);
  const verification = parseVerification(dir, warnings);

  if (verification.gate === "fail") warnings.push("verification gate failed");

  const lifecycle = deriveLifecycle({
    archived,
    artifacts,
    taskProgress,
    verification,
  });

  return {
    name,
    title,
    archived,
    lifecycle,
    artifacts,
    missingArtifacts,
    taskProgress,
    specCoverage,
    verification,
    warnings,
    nextAction: extractNextAction(dir, taskProgress),
    path: dir,
  };
}

function hasSpecs(dir: string): boolean {
  return findSpecFiles(dir).length > 0;
}

function findSpecFiles(dir: string): string[] {
  const specsDir = join(dir, "specs");
  if (!existsSync(specsDir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry === "spec.md") out.push(p);
    }
  };
  walk(specsDir);
  return out;
}

function deriveTitle(dir: string, name: string): string {
  // Prefer the H1 from intent.md, fall back to the name slug.
  const intentPath = join(dir, "intent.md");
  if (existsSync(intentPath)) {
    const h1 = readFileSync(intentPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("# "));
    if (h1) return h1.replace(/^#\s+/, "");
  }
  return name.replace(/-/g, " ");
}

function parseTaskProgress(dir: string, warnings: string[]): TaskProgress {
  const tasksPath = join(dir, ARTIFACT_FILES.tasks);
  if (!existsSync(tasksPath)) {
    return { total: 0, completed: 0, remaining: 0, percent: 0, unknown: true };
  }
  const raw = readFileSync(tasksPath, "utf8");
  const lines = raw.split("\n");
  // Standard OpenSpec checkbox: "- [ ]" or "- [x]"
  const checkboxRe = /^- \[([ xX])\]\s+(.+)$/;
  let total = 0;
  let completed = 0;
  for (const line of lines) {
    const m = line.match(checkboxRe);
    if (m) {
      total++;
      if (m[1].toLowerCase() === "x") completed++;
    }
  }
  if (total === 0) {
    warnings.push("tasks.md has no recognizable checkboxes");
  }
  const remaining = total - completed;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, remaining, percent, unknown: false };
}

function extractNextAction(dir: string, progress: TaskProgress): string | null {
  if (progress.unknown) return null;
  const tasksPath = join(dir, ARTIFACT_FILES.tasks);
  if (!existsSync(tasksPath)) return null;
  const raw = readFileSync(tasksPath, "utf8");
  const checkboxRe = /^- \[ \]\s+(.+)$/;
  for (const line of raw.split("\n")) {
    const m = line.match(checkboxRe);
    if (m) return m[1].trim();
  }
  return null;
}

function countSpecCoverage(dir: string): SpecCoverage {
  const specFiles = findSpecFiles(dir);
  if (specFiles.length === 0) {
    return { requirements: 0, scenarios: 0, missing: true };
  }
  let requirements = 0;
  let scenarios = 0;
  for (const file of specFiles) {
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("### Requirement:")) requirements++;
      else if (trimmed.startsWith("#### Scenario:")) scenarios++;
    }
  }
  return { requirements, scenarios, missing: false };
}

function parseVerification(dir: string, warnings: string[]): Verification {
  const verifyPath = join(dir, ".loomkit-verify.json");
  const tracePath = join(dir, ".traceability.yaml");
  const verifyJsonPresent = existsSync(verifyPath);
  const traceabilityPresent = existsSync(tracePath);

  let gate: "pass" | "fail" | undefined;
  let specScenarios: number | undefined;
  let failedScenarios: number | undefined;

  if (verifyJsonPresent) {
    try {
      const data = JSON.parse(readFileSync(verifyPath, "utf8"));
      // loomkit's verify command writes `passed` (boolean) + `total_scenarios`
      // (number) + `coverage` (0..1) + `uncovered` (string[]). Older/internal
      // formats used a `gate` string + `specScenarios` array + `testResults`;
      // accept both so the dashboard reflects real gate state.
      const passed = data.passed === true || data.gate === "pass";
      gate = passed ? "pass" : (data.gate === "fail" || data.passed === false ? "fail" : undefined);
      specScenarios = typeof data.total_scenarios === "number"
        ? data.total_scenarios
        : (Array.isArray(data.specScenarios) ? data.specScenarios.length : undefined);
      failedScenarios = Array.isArray(data.uncovered)
        ? data.uncovered.length
        : sumFailed(data.testResults);
    } catch {
      warnings.push("failed to parse .loomkit-verify.json");
    }
  }

  return {
    verifyJsonPresent,
    traceabilityPresent,
    verified: gate === "pass",
    gate,
    specScenarios,
    failedScenarios,
  };
}

function sumFailed(testResults: unknown): number | undefined {
  if (!testResults || typeof testResults !== "object") return undefined;
  let total = 0;
  let seen = false;
  for (const v of Object.values(testResults as Record<string, unknown>)) {
    if (v && typeof v === "object" && "failed" in v) {
      const f = (v as { failed: unknown }).failed;
      if (typeof f === "number") {
        total += f;
        seen = true;
      }
    }
  }
  return seen ? total : undefined;
}

function deriveLifecycle(args: {
  archived: boolean;
  artifacts: ArtifactPresence;
  taskProgress: TaskProgress;
  verification: Verification;
}): LifecycleState {
  const { archived, artifacts, taskProgress, verification } = args;
  if (archived) return "archived";
  if (verification.gate === "pass") return "verified";

  const hasPlan = artifacts.specs && artifacts.tasks;
  if (!hasPlan) return "draft";

  if (taskProgress.unknown || taskProgress.total === 0) return "draft";
  if (taskProgress.remaining === 0) {
    // all tasks done but not verified → review
    return "review";
  }
  if (taskProgress.completed > 0) return "in_progress";
  return "planned";
}

function summarize(active: ChangeRecord[], archived: ChangeRecord[]): Summary {
  const count = (pred: (c: ChangeRecord) => boolean, list: ChangeRecord[]) =>
    list.filter(pred).length;

  return {
    active: active.length,
    archived: archived.length,
    verified: count((c) => c.lifecycle === "verified", [...active, ...archived]),
    draft: count((c) => c.lifecycle === "draft", active),
    inProgress: count((c) => c.lifecycle === "in_progress", active),
    planned: count((c) => c.lifecycle === "planned", active),
    review: count((c) => c.lifecycle === "review", active),
    blocked: count((c) => c.lifecycle === "blocked", active),
  };
}
