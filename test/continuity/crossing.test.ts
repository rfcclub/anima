import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CrossingManager, type CrossingEntry } from "../../src/continuity/crossing";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "anima-crossing-test-"));
  mkdirSync(join(dir, "staging"), { recursive: true });
  return dir;
}

function makeEntry(overrides: Partial<CrossingEntry> = {}): CrossingEntry {
  return {
    sessionId: "sess-001",
    timestamp: new Date().toISOString(),
    carriesForward: [],
    unresolved: [],
    notes: "",
    status: "complete",
    ...overrides,
  };
}

describe("CrossingManager", () => {
  let manager: CrossingManager;

  beforeEach(() => {
    manager = new CrossingManager();
  });

  describe("parse", () => {
    test("parses complete crossing", () => {
      const content = [
        "sessionId: sess-001",
        "timestamp: 2026-05-19T10:00:00Z",
        "status: complete",
        "",
        "## Carrying Forward",
        "- learned about crossing protocol",
        "- fixed bug in session loader",
        "",
        "## Unresolved",
        "- need to implement gate pipeline",
        "",
        "## Notes",
        "productive session",
      ].join("\n");

      const entry = manager.parse(content);
      expect(entry).not.toBeNull();
      expect(entry!.sessionId).toBe("sess-001");
      expect(entry!.status).toBe("complete");
      expect(entry!.carriesForward).toHaveLength(2);
      expect(entry!.carriesForward[0]).toBe("learned about crossing protocol");
      expect(entry!.unresolved).toHaveLength(1);
      expect(entry!.notes).toBe("productive session");
    });

    test("parses partial crossing", () => {
      const content = [
        "sessionId: sess-002",
        "timestamp: 2026-05-19T11:00:00Z",
        "status: partial",
        "",
        "## Carrying Forward",
        "",
        "## Unresolved",
        "- something left undone",
        "",
        "## Notes",
        "(none)",
      ].join("\n");

      const entry = manager.parse(content);
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe("partial");
      expect(entry!.carriesForward).toHaveLength(0);
      expect(entry!.unresolved).toHaveLength(1);
    });

    test("returns null for empty content", () => {
      expect(manager.parse("")).toBeNull();
      expect(manager.parse("## Carrying Forward\n- nothing")).toBeNull();
    });

    test("parses missing status", () => {
      const content = [
        "sessionId: sess-003",
        "timestamp: 2026-05-19T12:00:00Z",
        "status: missing",
        "",
        "## Carrying Forward",
        "",
        "## Unresolved",
        "",
        "## Notes",
        "",
      ].join("\n");

      const entry = manager.parse(content);
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe("missing");
      expect(entry!.carriesForward).toHaveLength(0);
    });

    test("parses not_applicable status", () => {
      const content = [
        "sessionId: sess-004",
        "timestamp: 2026-05-19T12:30:00Z",
        "status: not_applicable",
        "",
        "## Carrying Forward",
        "",
        "## Unresolved",
        "",
        "## Notes",
        "quick check-in, nothing to carry",
      ].join("\n");

      const entry = manager.parse(content);
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe("not_applicable");
    });
  });

  describe("write and load", () => {
    test("writes and reads crossing file", async () => {
      const dir = tempDir();
      const entry = makeEntry({
        sessionId: "sess-write",
        carriesForward: ["implemented crossing"],
        unresolved: ["need tests"],
        notes: "good progress",
      });

      await manager.write(dir, entry);
      const loaded = await manager.load(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe("sess-write");
      expect(loaded!.carriesForward).toEqual(["implemented crossing"]);
      expect(loaded!.unresolved).toEqual(["need tests"]);
      expect(loaded!.status).toBe("complete");
    });

    test("load returns null when no crossing file", async () => {
      const dir = tempDir();
      const loaded = await manager.load(dir);
      expect(loaded).toBeNull();
    });

    test("write creates staging directory if needed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "anima-crossing-test-"));
      // no staging/ subdirectory yet
      const entry = makeEntry();
      await manager.write(dir, entry);
      expect(existsSync(join(dir, "staging", "crossing.md"))).toBeTrue();
    });
  });

  describe("shouldCross", () => {
    test("requires minimum session events", () => {
      expect(manager.shouldCross(0)).toBeFalse();
      expect(manager.shouldCross(1)).toBeFalse();
      expect(manager.shouldCross(2)).toBeFalse();
      expect(manager.shouldCross(3)).toBeTrue();
      expect(manager.shouldCross(10)).toBeTrue();
    });

    test("respects custom threshold", () => {
      const strict = new CrossingManager({ minSessionEvents: 5 });
      expect(strict.shouldCross(3)).toBeFalse();
      expect(strict.shouldCross(5)).toBeTrue();
    });
  });

  describe("streak", () => {
    test("complete entry resets streak to 0", () => {
      const entry = makeEntry({ status: "complete" });
      const streak = manager.computeStreak(entry, []);
      expect(streak.current).toBe(0);
      expect(streak.alert).toBeFalse();
    });

    test("partial entry resets streak", () => {
      const entry = makeEntry({ status: "partial" });
      const streak = manager.computeStreak(entry, []);
      expect(streak.current).toBe(0);
    });

    test("missing entry increments streak", () => {
      const entry = makeEntry({ status: "missing" });
      const streak = manager.computeStreak(entry, []);
      expect(streak.current).toBe(1);
      expect(streak.alert).toBeFalse();
    });

    test("alerts at threshold (3)", () => {
      const entry = makeEntry({ status: "missing" });
      const previous: CrossingEntry[] = [
        makeEntry({ status: "missing", sessionId: "prev-2" }),
        makeEntry({ status: "missing", sessionId: "prev-1" }),
      ];
      const streak = manager.computeStreak(entry, previous);
      expect(streak.current).toBe(3);
      expect(streak.alert).toBeTrue();
    });

    test("not_applicable does not count toward streak", () => {
      const entry = makeEntry({ status: "not_applicable" });
      const streak = manager.computeStreak(entry, []);
      expect(streak.current).toBe(0);
      expect(streak.alert).toBeFalse();
    });
  });

  describe("crossing injection", () => {
    test("builds injection with carries and unresolved", () => {
      const entry = makeEntry({
        sessionId: "sess-inject",
        carriesForward: ["pattern A discovered"],
        unresolved: ["need to verify B"],
      });

      const injection = manager.buildCrossingInjection(entry);
      expect(injection).toContain("[Crossing Context]");
      expect(injection).toContain("pattern A discovered");
      expect(injection).toContain("need to verify B");
      expect(injection).toContain("sess-inject");
    });

    test("returns empty string for not_applicable", () => {
      const entry = makeEntry({ status: "not_applicable" });
      expect(manager.buildCrossingInjection(entry)).toBe("");
    });

    test("returns empty string when no content", () => {
      const entry = makeEntry({
        carriesForward: [],
        unresolved: [],
      });
      expect(manager.buildCrossingInjection(entry)).toBe("");
    });
  });

  describe("status", () => {
    test("returns null entry when no crossing file", async () => {
      const dir = tempDir();
      const status = await manager.status(dir);
      expect(status.entry).toBeNull();
    });

    test("returns entry and streak from file", async () => {
      const dir = tempDir();
      const entry = makeEntry({
        sessionId: "sess-status",
        carriesForward: ["something"],
      });
      await manager.write(dir, entry);

      const status = await manager.status(dir);
      expect(status.entry).not.toBeNull();
      expect(status.entry!.sessionId).toBe("sess-status");
      expect(status.streak.current).toBe(0);
    });
  });
});
