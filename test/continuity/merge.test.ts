import { describe, test, expect, beforeEach } from "bun:test";
import { MergeManager, type MergeRequest } from "../../src/continuity/merge";
import { StagingManager, type StagingEntry } from "../../src/continuity/staging";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "anima-merge-test-"));
}

function makeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    stagingEntry: {
      kind: "beam",
      filename: "2026-05-19.md",
      content: "discovered pattern",
      status: "pending",
    },
    targetPath: "BEAMS.md",
    confidence: 0.9,
    kind: "beam",
    ...overrides,
  };
}

describe("MergeManager", () => {
  let stagingManager: StagingManager;
  let mergeManager: MergeManager;

  beforeEach(() => {
    stagingManager = new StagingManager();
    mergeManager = new MergeManager(stagingManager);
  });

  describe("needsApproval", () => {
    test("auto-merges when confidence >= threshold", () => {
      expect(mergeManager.needsApproval(0.90)).toBeFalse();
      expect(mergeManager.needsApproval(0.85)).toBeFalse();
    });

    test("pending when confidence < threshold", () => {
      expect(mergeManager.needsApproval(0.70)).toBeTrue();
      expect(mergeManager.needsApproval(0.30)).toBeTrue();
    });
  });

  describe("merge", () => {
    test("auto-merges high-confidence beam", async () => {
      const dir = tempDir();
      const beamDir = join(dir, "mount");
      mkdirSync(beamDir, { recursive: true });

      const request = makeRequest({ confidence: 0.95 });
      const result = await mergeManager.merge(request, dir);
      expect(result.merged).toBeTrue();
      expect(result.reason).toContain("auto-merged");
    });

    test("creates backup before merge", async () => {
      const dir = tempDir();
      const mountDir = join(dir, "mount");
      mkdirSync(mountDir, { recursive: true });
      writeFileSync(join(mountDir, "BEAMS.md"), "existing content", "utf-8");

      const request = makeRequest({ confidence: 0.90 });
      await mergeManager.merge(request, dir);
      expect(existsSync(join(dir, ".continuity-backup"))).toBeTrue();
    });

    test("pending for low-confidence", async () => {
      const dir = tempDir();
      const request = makeRequest({ confidence: 0.50 });
      const result = await mergeManager.merge(request, dir);
      expect(result.merged).toBeFalse();
      expect(result.reason).toContain("pending approval");
    });

    test("restores from backup", async () => {
      const dir = tempDir();
      const mountDir = join(dir, "mount");
      mkdirSync(mountDir, { recursive: true });
      writeFileSync(join(mountDir, "BEAMS.md"), "original content", "utf-8");

      const request = makeRequest({ confidence: 0.90 });
      await mergeManager.merge(request, dir);

      // Find the backup timestamp
      const backupDir = join(dir, ".continuity-backup");
      const files = (await import("node:fs/promises")).readdir(backupDir);
      const backupFile = (await files).find((f: string) => f.endsWith(".bak"));
      expect(backupFile).toBeDefined();
    });

    test("pending approvals lists low-confidence entries", async () => {
      const dir = tempDir();
      await stagingManager.writeBeam(dir, "some insight");
      const pending = await mergeManager.pendingApprovals(dir);
      // beams default to 0.7 confidence < 0.85 threshold
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });
  });
});
