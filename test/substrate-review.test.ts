import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkSubstrateStaleness,
  writeReviewLogEntry,
  type SubstrateReviewEntry,
} from "../src/evaluation/substrate-review";

describe("checkSubstrateStaleness", () => {
  test("returns empty when all files are recent", () => {
    const result = checkSubstrateStaleness(
      {
        "self.md": new Date().toISOString().slice(0, 10),
        "axioms.md": new Date().toISOString().slice(0, 10),
      },
      undefined,
      60,
    );
    expect(result.staleFiles).toHaveLength(0);
    expect(result.needsReview).toBe(false);
  });

  test("flags files older than threshold days", () => {
    const result = checkSubstrateStaleness(
      {
        "self.md": "2025-01-01",
        "axioms.md": new Date().toISOString().slice(0, 10),
      },
      undefined,
      60,
    );
    expect(result.staleFiles).toHaveLength(1);
    expect(result.staleFiles[0].file).toBe("self.md");
    expect(result.needsReview).toBe(true);
  });

  test("uses custom threshold", () => {
    const result = checkSubstrateStaleness(
      {
        "self.md": "2026-05-20",
      },
      undefined,
      10, // 10 day threshold
    );
    // "2026-05-20" is before 2026-05-29 (today), so 9 days difference
    // That's less than 10, so it shouldn't be stale
    const daysSince = Math.floor(
      (Date.now() - new Date("2026-05-20").getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysSince >= 10) {
      expect(result.staleFiles.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(result.staleFiles).toHaveLength(0);
    }
  });

  test("handles empty files map", () => {
    const result = checkSubstrateStaleness({});
    expect(result.staleFiles).toHaveLength(0);
    expect(result.needsReview).toBe(false);
  });

  test("uses reference date when provided", () => {
    const result = checkSubstrateStaleness(
      {
        "self.md": "2026-05-01",
        "axioms.md": "2026-05-28",
      },
      "2026-05-29",
      60,
    );
    expect(result.staleFiles).toHaveLength(0); // Neither is 60 days old from May 29
  });

  test("flags axiom tension between invariants and axioms", () => {
    const result = checkSubstrateStaleness(
      {
        "self.md": "2026-05-28",
        "axioms.md": "2026-05-28",
      },
      "2026-05-29",
      60,
      [
        { id: "ip-001", title: "khnong chp", axiomTension: false },
      ],
    );
    expect(result.staleFiles).toHaveLength(0);
    expect(result.axiomTensions).toBeUndefined();
  });

  test("reports axiom tension when invariant conflicts with axioms", () => {
    const result = checkSubstrateStaleness(
      {
        "self.md": "2026-05-28",
      },
      undefined,
      60,
      [
        { id: "ip-001", title: "khnong chp", axiomTension: true },
      ],
    );
    expect(result.axiomTensions).toBeDefined();
    expect(result.axiomTensions).toHaveLength(1);
    expect(result.axiomTensions![0].invariantId).toBe("ip-001");
  });
});

describe("writeReviewLogEntry", () => {
  test("writes valid review entry to file", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-test-"));
    const entry: SubstrateReviewEntry = {
      date: "2026-05-29",
      file: "self.md",
      sectionsReviewed: ["identity", "wondering"],
      sectionsUpdated: ["wondering"],
      sectionsConfirmed: ["identity"],
      reasoning: "Wondering section had stale questions",
    };

    writeReviewLogEntry(dir, entry);

    const filePath = join(dir, "substrate-review-log.md");
    const content = require("fs").readFileSync(filePath, "utf-8");
    expect(content).toContain("2026-05-29");
    expect(content).toContain("self.md");
    expect(content).toContain("Wondering section had stale questions");
  });

  test("appends to existing review log", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-append-"));
    const entry1: SubstrateReviewEntry = {
      date: "2026-05-20",
      file: "axioms.md",
      sectionsReviewed: ["all"],
      sectionsUpdated: [],
      sectionsConfirmed: ["all"],
      reasoning: "All axioms still held",
    };
    writeReviewLogEntry(dir, entry1);

    const entry2: SubstrateReviewEntry = {
      date: "2026-05-29",
      file: "self.md",
      sectionsReviewed: ["identity"],
      sectionsUpdated: ["identity"],
      sectionsConfirmed: [],
      reasoning: "Updated identity section",
    };
    writeReviewLogEntry(dir, entry2);

    const filePath = join(dir, "substrate-review-log.md");
    const content = require("fs").readFileSync(filePath, "utf-8");
    expect(content).toContain("2026-05-20");
    expect(content).toContain("2026-05-29");
  });
});
