import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrajectoryManager } from "../src/continuity/trajectory";

let dir: string;
let manager: TrajectoryManager;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "traj-life-"));
  mkdirSync(join(dir, "staging"), { recursive: true });
  manager = new TrajectoryManager(dir);
});

describe("Trajectory lifecycle integration", () => {
  test("onOpen snapshot written", () => {
    const id = manager.appendSnapshot("sess-open-001", "bruno", "Session opened for Telegram channel");
    expect(id).toBeDefined();
    expect(id.startsWith("snapshot-")).toBe(true);
  });

  test("onClose snapshot written", () => {
    const id = manager.appendSnapshot("sess-open-001", "bruno", "Session closed with 12 events");
    expect(id).toBeDefined();
  });

  test("shift recorded after drift detection", () => {
    const id = manager.appendShift("sess-open-001", "bruno", {
      what: "companion_identity_shift",
      from: "implicit_assistant",
      to: "explicit_companion",
      trigger: "drift_detection",
    });
    expect(id).toBeDefined();
  });

  test("milestone recorded for notable events", () => {
    const id = manager.appendMilestone("sess-open-001", "bruno", "Crossing protocol v2 adopted", {
      phase: "0",
    });
    expect(id).toBeDefined();
  });

  test("getRecent returns lifecycle records", () => {
    const records = manager.getRecent(10);
    const snapshotRecords = records.filter((r) => r.type === "snapshot");
    expect(snapshotRecords.length).toBeGreaterThanOrEqual(2);

    const openRecord = records.find((r) => r.content.includes("Session opened"));
    expect(openRecord).toBeDefined();
    expect(openRecord!.agent).toBe("bruno");

    const closeRecord = records.find((r) => r.content.includes("Session closed"));
    expect(closeRecord).toBeDefined();
  });

  test("format includes all record types", () => {
    const context = manager.formatTrajectoryContext(10);
    expect(context).toContain("[snapshot]");
    expect(context).toContain("[shift]");
    expect(context).toContain("[milestone]");
    expect(context).toContain("companion_identity_shift");
  });

  test("trajectory file exists after lifecycle records", () => {
    expect(existsSync(join(dir, "trajectory.jsonl"))).toBe(true);
  });
});
