/**
 * Invariants — Schema and loader for Bruno-authored invariants.json
 *
 * The invariants file is the machine-readable Heartwood layer: held positions
 * that define identity boundaries. It is authored by Bruno, not by Owner.
 *
 * Phase 1 of the bruno-identity-infrastructure spec.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type InvariantCategory = "identity" | "boundary" | "relation" | "behavior" | "epistemic";

export const VALID_CATEGORIES: InvariantCategory[] = [
  "identity",
  "boundary",
  "relation",
  "behavior",
  "epistemic",
];

export interface HeldPosition {
  id: string;
  title: string;
  statement: string;
  category: InvariantCategory;
  last_reviewed?: string;
  /** Regex sources (case-insensitive) that signal this position being crossed; authored in the agent's own invariants file. */
  trigger_phrases?: string[];
}

export interface InvariantsFile {
  agent: string;
  authored_by: string;
  version: string;
  last_reviewed: string;
  held_positions: HeldPosition[];
}

export interface BeliefEntry {
  id: string;
  title: string;
  statement: string;
  invariant_ref?: string;
  last_reviewed?: string;
}

export interface BeliefsFile {
  agent: string;
  authored_by: string;
  beliefs: BeliefEntry[];
}

export interface GoalEntry {
  id: string;
  title: string;
  description: string;
  invariant_ref?: string;
  status: "active" | "completed" | "deferred" | "abandoned";
}

export interface GoalsFile {
  agent: string;
  authored_by: string;
  goals: GoalEntry[];
}

export interface InvariantStalenessReport {
  stalePositions: Array<{
    id: string;
    title: string;
    daysSinceReview: number;
  }>;
  staleInvariants: boolean;
}

/* ------------------------------------------------------------------ */
/*  File Loader                                                        */
/* ------------------------------------------------------------------ */

export function loadInvariants(filePath: string): InvariantsFile {
  const raw = readInvariantsFile(filePath);
  const parsed = parseInvariants(raw);
  validateInvariants(parsed);
  return parsed;
}

export async function loadInvariantsAsync(filePath: string): Promise<InvariantsFile> {
  if (!existsSync(filePath)) {
    throw new Error(`invariants file not found: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf-8");
  const parsed = parseInvariants(raw);
  validateInvariants(parsed);
  return parsed;
}

export function loadBeliefs(filePath: string): BeliefsFile {
  const raw = readInvariantsFile(filePath);
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || !parsed.agent || !parsed.beliefs) {
    throw new Error("invalid beliefs.json: missing required fields (agent, beliefs)");
  }

  if (!Array.isArray(parsed.beliefs)) {
    throw new Error("invalid beliefs.json: beliefs must be an array");
  }

  for (const [i, b] of parsed.beliefs.entries()) {
    if (!b.id || !b.statement) {
      throw new Error(`invalid beliefs.json: beliefs[${i}] missing required fields (id, statement)`);
    }
  }

  return parsed as BeliefsFile;
}

export function loadGoals(filePath: string): GoalsFile {
  const raw = readInvariantsFile(filePath);
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || !parsed.agent || !parsed.goals) {
    throw new Error("invalid goals.json: missing required fields (agent, goals)");
  }

  if (!Array.isArray(parsed.goals)) {
    throw new Error("invalid goals.json: goals must be an array");
  }

  for (const [i, g] of parsed.goals.entries()) {
    if (!g.id || !g.description) {
      throw new Error(`invalid goals.json: goals[${i}] missing required fields (id, description)`);
    }
    if (!["active", "completed", "deferred", "abandoned"].includes(g.status)) {
      throw new Error(`invalid goals.json: goals[${i}] invalid status: ${g.status}`);
    }
  }

  return parsed as GoalsFile;
}

/* ------------------------------------------------------------------ */
/*  Staleness Checking                                                 */
/* ------------------------------------------------------------------ */

const STALENESS_DAYS = 30;

export function checkInvariantStaleness(invariants: InvariantsFile, referenceDate?: string): InvariantStalenessReport {
  const now = referenceDate ? new Date(`${referenceDate}T00:00:00Z`) : new Date();
  const threshold = STALENESS_DAYS * 24 * 60 * 60 * 1000;

  const stalePositions = invariants.held_positions
    .filter((p) => {
      const reviewed = p.last_reviewed ?? invariants.last_reviewed;
      const reviewedDate = new Date(`${reviewed}T00:00:00Z`);
      if (isNaN(reviewedDate.getTime())) return false;
      return now.getTime() - reviewedDate.getTime() > threshold;
    })
    .map((p) => {
      const reviewed = p.last_reviewed ?? invariants.last_reviewed;
      const reviewedDate = new Date(`${reviewed}T00:00:00Z`);
      const daysSinceReview = Math.floor((now.getTime() - reviewedDate.getTime()) / (1000 * 60 * 60 * 24));
      return { id: p.id, title: p.title, daysSinceReview };
    });

  return {
    stalePositions,
    staleInvariants: stalePositions.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Internal                                                           */
/* ------------------------------------------------------------------ */

function readInvariantsFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf-8");
}

function parseInvariants(raw: string): InvariantsFile {
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid invariants.json: must be a JSON object");
  }

  return {
    agent: parsed.agent,
    authored_by: parsed.authored_by,
    version: parsed.version,
    last_reviewed: parsed.last_reviewed,
    held_positions: Array.isArray(parsed.held_positions) ? parsed.held_positions : [],
  };
}

function validateInvariants(invariants: InvariantsFile): void {
  if (!invariants.agent) throw new Error("invalid invariants.json: missing required field: agent");
  if (!invariants.authored_by) throw new Error("invalid invariants.json: missing required field: authored_by");
  if (!invariants.version) throw new Error("invalid invariants.json: missing required field: version");
  if (!invariants.last_reviewed) throw new Error("invalid invariants.json: missing required field: last_reviewed");

  for (const [i, p] of invariants.held_positions.entries()) {
    if (!p.id || !p.title || !p.statement || !p.category) {
      throw new Error(`invalid invariants.json: held_positions[${i}] missing required fields`);
    }
    if (!VALID_CATEGORIES.includes(p.category)) {
      throw new Error(`invalid invariants.json: held_positions[${i}] invalid category: ${p.category}`);
    }
  }
}
