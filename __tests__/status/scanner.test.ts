import { test, expect } from "bun:test";
import { join } from "node:path";
import { scanProjectStatus, type ProjectSnapshot, type ChangeRecord } from "../../src/status/scanner";

const FIXTURE_ROOT = join(import.meta.dir, "__fixtures__", "openspec");

function snapshot(): ProjectSnapshot {
  return scanProjectStatus(FIXTURE_ROOT);
}

function change(name: string): ChangeRecord {
  const snap = snapshot();
  const all = [...snap.activeChanges, ...snap.archivedChanges];
  const found = all.find((c) => c.name === name);
  if (!found) throw new Error(`change ${name} not found in snapshot`);
  return found;
}

// ── 1.2 Artifact discovery ────────────────────────────────────────────────

test("discovers an active change in openspec/changes", () => {
  const snap = snapshot();
  expect(snap.activeChanges.map((c) => c.name)).toContain("active-verified");
  const c = change("active-verified");
  expect(c.archived).toBe(false);
});

test("discovers an archived change in openspec/archive and separates it", () => {
  const snap = snapshot();
  expect(snap.archivedChanges.map((c) => c.name)).toContain("archived-change");
  expect(snap.activeChanges.map((c) => c.name)).not.toContain("archived-change");
  const c = change("archived-change");
  expect(c.archived).toBe(true);
});

test("reports artifact presence for a complete change", () => {
  const c = change("active-verified");
  expect(c.artifacts.proposal).toBe(true);
  expect(c.artifacts.design).toBe(true);
  expect(c.artifacts.tasks).toBe(true);
  expect(c.artifacts.specs).toBe(true);
});

test("reports missing artifacts for a sparse change", () => {
  const c = change("active-missing");
  expect(c.artifacts.proposal).toBe(false);
  expect(c.artifacts.design).toBe(false);
  expect(c.artifacts.tasks).toBe(false);
  expect(c.artifacts.specs).toBe(false);
  expect(c.missingArtifacts).toContain("proposal");
  expect(c.missingArtifacts).toContain("design");
  expect(c.missingArtifacts).toContain("tasks");
  expect(c.missingArtifacts).toContain("specs");
});

test("detects loomkit-verify and traceability evidence", () => {
  const c = change("active-verified");
  expect(c.verification.verifyJsonPresent).toBe(true);
  expect(c.verification.traceabilityPresent).toBe(true);
});

test("marks a change with no evidence as unverified", () => {
  const c = change("active-inprogress");
  expect(c.verification.verifyJsonPresent).toBe(false);
  expect(c.verification.traceabilityPresent).toBe(false);
  expect(c.verification.verified).toBe(false);
});

// ── 1.3 Task checkbox progress + next action ──────────────────────────────

test("derives task progress from tasks.md checkboxes", () => {
  const c = change("active-verified");
  expect(c.taskProgress.total).toBe(3);
  expect(c.taskProgress.completed).toBe(3);
  expect(c.taskProgress.remaining).toBe(0);
  expect(c.taskProgress.percent).toBe(100);
  expect(c.taskProgress.unknown).toBe(false);
});

test("derives partial progress for an in-progress change", () => {
  const c = change("active-inprogress");
  expect(c.taskProgress.total).toBe(3);
  expect(c.taskProgress.completed).toBe(1);
  expect(c.taskProgress.remaining).toBe(2);
  expect(c.taskProgress.percent).toBe(33);
});

test("extracts the first remaining task as nextAction", () => {
  const c = change("active-inprogress");
  expect(c.nextAction).toBe("1.2 Second in-progress task");
});

test("returns null nextAction when no tasks remain", () => {
  const c = change("active-verified");
  expect(c.nextAction).toBeNull();
});

test("marks task progress unknown when tasks.md is absent", () => {
  const c = change("active-missing");
  expect(c.taskProgress.unknown).toBe(true);
  expect(c.taskProgress.total).toBe(0);
  expect(c.taskProgress.percent).toBe(0);
});

// ── 1.4 Requirement/scenario counts from specs ────────────────────────────

test("counts requirements and scenarios from spec.md files", () => {
  const c = change("active-verified");
  expect(c.specCoverage.requirements).toBe(1);
  expect(c.specCoverage.scenarios).toBe(2);
  expect(c.specCoverage.missing).toBe(false);
});

test("marks spec coverage missing when no spec files exist", () => {
  const c = change("active-draft");
  expect(c.specCoverage.missing).toBe(true);
  expect(c.specCoverage.requirements).toBe(0);
  expect(c.specCoverage.scenarios).toBe(0);
});

// ── 1.5 Parse warnings preserve partial snapshots ─────────────────────────

test("does not crash on malformed verify JSON and attaches a warning", () => {
  const c = change("active-malformed");
  expect(c.warnings.length).toBeGreaterThan(0);
  expect(c.warnings.some((w) => w.includes("verify") || w.includes("loomkit"))).toBe(true);
  // partial data still present
  expect(c.artifacts.tasks).toBe(true);
});

test("snapshot as a whole is still returned when one change is malformed", () => {
  const snap = snapshot();
  expect(snap.activeChanges.length).toBeGreaterThan(0);
  expect(snap.warnings).toBeUndefined(); // warnings live per-change, not on snapshot
  const names = snap.activeChanges.map((c) => c.name);
  expect(names).toContain("active-malformed");
  expect(names).toContain("active-verified");
});

// ── lifecycle derivation ───────────────────────────────────────────────────

test("derives verified lifecycle for a verified change", () => {
  expect(change("active-verified").lifecycle).toBe("verified");
});

test("derives in_progress lifecycle for a partially-done change", () => {
  expect(change("active-inprogress").lifecycle).toBe("in_progress");
});

test("derives planned lifecycle when no tasks are complete", () => {
  expect(change("active-planned").lifecycle).toBe("planned");
});

test("derives draft lifecycle when specs/tasks are missing", () => {
  expect(change("active-draft").lifecycle).toBe("draft");
});

test("derives archived lifecycle for archived changes", () => {
  expect(change("archived-change").lifecycle).toBe("archived");
});

// ── summary counts ─────────────────────────────────────────────────────────

test("summary counts active and archived changes", () => {
  const snap = snapshot();
  expect(snap.summary.active).toBe(snap.activeChanges.length);
  expect(snap.summary.archived).toBe(snap.archivedChanges.length);
  expect(snap.summary.verified).toBeGreaterThanOrEqual(1);
  expect(snap.generatedAt).toBeTruthy();
});
