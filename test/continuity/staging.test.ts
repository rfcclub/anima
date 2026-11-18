import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StagingManager } from "../../src/continuity/staging";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "anima-staging-test-"));
}

describe("StagingManager", () => {
  let manager: StagingManager;

  beforeEach(() => {
    manager = new StagingManager();
  });

  test("writes beam to staging/beams/YYYY-MM-DD.md", async () => {
    const dir = tempDir();
    const path = await manager.writeBeam(dir, "discovered pattern in error handling");
    expect(existsSync(path)).toBeTrue();
    expect(path).toContain("staging/beams/");
    expect(path).toEndWith(".md");
  });

  test("writes wound to staging/wounds/YYYY-MM-DD.md", async () => {
    const dir = tempDir();
    const path = await manager.writeWound(dir, "relational", "drift detected in session");
    expect(path).toContain("staging/wounds/");
    expect(existsSync(path)).toBeTrue();
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("relational");
    expect(content).toContain("drift detected in session");
  });

  test("appends multiple entries to same day file", async () => {
    const dir = tempDir();
    await manager.writeBeam(dir, "first insight");
    const path = await manager.writeBeam(dir, "second insight");
    const content = readFileSync(path, "utf-8");
    const separators = (content.match(/^---$/gm) ?? []).length;
    expect(separators).toBe(2);
  });

  test("lists beams sorted by filename desc", async () => {
    const dir = tempDir();
    await manager.writeBeam(dir, "beam A");
    await manager.writeBeam(dir, "beam B");
    const entries = await manager.list(dir, "beam");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    if (entries.length >= 2) {
      expect(entries[0].filename >= entries[1].filename).toBeTrue();
    }
  });

  test("list returns empty for missing directory", async () => {
    const dir = tempDir();
    const entries = await manager.list(dir, "beam");
    expect(entries).toEqual([]);
  });

  test("summary counts beams, wounds, dreams", async () => {
    const dir = tempDir();
    await manager.writeBeam(dir, "beam content");
    await manager.writeWound(dir, "pattern", "wound content");
    const s = await manager.summary(dir);
    expect(s.beams).toBe(1);
    expect(s.wounds).toBe(1);
    expect(s.dreams).toBe(0);
    expect(s.pendingMerges).toBe(2);
  });

  test("hasPending returns true when beams exist", async () => {
    const dir = tempDir();
    expect(await manager.hasPending(dir)).toBeFalse();
    await manager.writeBeam(dir, "beam");
    expect(await manager.hasPending(dir)).toBeTrue();
  });
});
