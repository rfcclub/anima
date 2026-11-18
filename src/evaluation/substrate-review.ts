/**
 * SubstrateReview — Checks substrate file staleness and writes review logs.
 *
 * Substrate files (self.md, axioms.md, MEMORY.md, etc.) have a 60-day review
 * lifecycle to prevent substrate drift — stale descriptions that no longer
 * match the agent's current state.
 *
 * Phase 1 of bruno-identity-infrastructure: substrate self-review.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SubstrateReviewEntry {
  date: string;
  file: string;
  sectionsReviewed: string[];
  sectionsUpdated: string[];
  sectionsConfirmed: string[];
  reasoning: string;
}

export interface SubstrateStalenessReport {
  staleFiles: Array<{
    file: string;
    lastReviewed: string;
    daysSinceReview: number;
  }>;
  needsReview: boolean;
  axiomTensions?: Array<{
    invariantId: string;
    invariantTitle: string;
    reason: string;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Staleness Checker                                                  */
/* ------------------------------------------------------------------ */

const DEFAULT_STALENESS_DAYS = 60;

/**
 * Check which substrate files are overdue for review.
 *
 * @param filesWithDates - Map of filename → last-reviewed ISO date string
 * @param referenceDate - Optional reference date (defaults to today)
 * @param thresholdDays - Days after which a file is considered stale (default 60)
 * @param invariantTensions - Optional array of invariants to check for axiom tension
 */
export function checkSubstrateStaleness(
  filesWithDates: Record<string, string>,
  referenceDate?: string,
  thresholdDays: number = DEFAULT_STALENESS_DAYS,
  invariantTensions?: Array<{ id: string; title: string; axiomTension: boolean }>,
): SubstrateStalenessReport {
  const now = referenceDate ? new Date(`${referenceDate}T00:00:00Z`) : new Date();
  const threshold = thresholdDays * 24 * 60 * 60 * 1000;

  const staleFiles = Object.entries(filesWithDates)
    .map(([file, dateStr]) => {
      const reviewed = new Date(`${dateStr}T00:00:00Z`);
      if (isNaN(reviewed.getTime())) return null;
      const diff = now.getTime() - reviewed.getTime();
      if (diff <= threshold) return null;
      return {
        file,
        lastReviewed: dateStr,
        daysSinceReview: Math.floor(diff / (1000 * 60 * 60 * 24)),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const axiomTensions = (invariantTensions ?? [])
    .filter((inv) => inv.axiomTension)
    .map((inv) => ({
      invariantId: inv.id,
      invariantTitle: inv.title,
      reason: `Invariant "${inv.title}" may conflict with existing axioms`,
    }));

  return {
    staleFiles,
    needsReview: staleFiles.length > 0,
    ...(axiomTensions.length > 0 ? { axiomTensions } : {}),
  };
}

/**
 * Write a review log entry to the substrate-review-log.md file.
 * Creates the file if it doesn't exist; appends to it otherwise.
 */
export function writeReviewLogEntry(baseDir: string, entry: SubstrateReviewEntry): void {
  const filePath = join(baseDir, "substrate-review-log.md");

  // Ensure parent directory exists
  mkdirSync(dirname(filePath), { recursive: true });

  const block = [
    `## Review — ${entry.date}`,
    "",
    `**File:** ${entry.file}`,
    `**Date:** ${entry.date}`,
    `**Sections reviewed:** ${entry.sectionsReviewed.join(", ")}`,
    `**Sections updated:** ${entry.sectionsUpdated.join(", ") || "(none)"}`,
    `**Sections confirmed:** ${entry.sectionsConfirmed.join(", ") || "(none)"}`,
    `**Reasoning:** ${entry.reasoning}`,
    "",
    "---",
    "",
  ].join("\n");

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  writeFileSync(filePath, existing + block, "utf-8");
}
