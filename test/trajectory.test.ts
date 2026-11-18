import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrajectoryManager } from "../src/continuity/trajectory";

let dir: string;
let manager: TrajectoryManager;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "traj-"));
  manager = new TrajectoryManager(dir);
});

describe("TrajectoryManager", () => {
  test("appends snapshot record", () => {
    const id = manager.appendSnapshot("sess-001", "bruno", "Session opened with identity load");
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  test("appends shift record", () => {
    const id = manager.appendShift("sess-001", "bruno", {
      what: "trust_score_shift",
      from: "0.50",
      to: "0.49",
      trigger: "auto-decay",
    });
    expect(id).toBeDefined();
  });

  test("appends milestone record", () => {
    const id = manager.appendMilestone("sess-001", "bruno", "First invariants authored", {
      phase: "1",
    });
    expect(id).toBeDefined();
  });

  test("getRecent returns last N records", () => {
    const records = manager.getRecent(5);
    expect(records.length).toBeGreaterThanOrEqual(3);
    const types = records.map((r) => r.type);
    expect(types).toContain("snapshot");
    expect(types).toContain("shift");
    expect(types).toContain("milestone");
  });

  test("getRecent deduplicates by id", () => {
    // Append same record twice
    const id = manager.appendSnapshot("sess-002", "bruno", "Duplicate test");
    manager.appendSnapshot("sess-003", "bruno", "Another one");

    const records = manager.getRecent(10);
    const ids = records.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size); // No duplicates
  });

  test("getRecent returns records in reverse chronological order", () => {
    const records = manager.getRecent(10);
    for (let i = 1; i < records.length; i++) {
      expect(new Date(records[i - 1].timestamp).getTime())
        .toBeGreaterThanOrEqual(new Date(records[i].timestamp).getTime());
    }
  });

  test("formatTrajectoryContext returns formatted string", () => {
    const context = manager.formatTrajectoryContext(5);
    expect(context).toContain("[Trajectory]");
    expect(context).toContain("Session opened with identity load");
    expect(context).toContain("First invariants authored");
  });

  test("formatTrajectoryContext returns empty string when no records", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "traj-empty-"));
    const emptyManager = new TrajectoryManager(emptyDir);
    const context = emptyManager.formatTrajectoryContext(5);
    expect(context).toBe("");
  });

  test("trajectory.jsonl exists after records written", () => {
    expect(existsSync(join(dir, "trajectory.jsonl"))).toBe(true);
  });

  test("file contains valid JSON lines", () => {
    const content = readFileSync(join(dir, "trajectory.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("timestamp");
      expect(parsed).toHaveProperty("type");
    }
  });
});
