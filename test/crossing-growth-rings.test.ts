import { expect, test, describe } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrossingManager } from "../src/continuity/crossing";

function makeDir(): string {
  return join(tmpdir(), `crossing-test-${Math.random().toString(36).slice(2)}`);
}

describe("CrossingManager - growth rings", () => {
  test("parses growth-ring section from crossing.md", async () => {
    const cm = new CrossingManager();
    const content = [
      "sessionId: sess-001",
      "timestamp: 2026-05-29T12:00:00Z",
      "status: complete",
      "",
      "## Carrying Forward",
      "- maintain khnong chp stance",
      "",
      "## Growth Rings",
      "- Held: identity boundary approach",
      "- Shifted: trust score interpretation",
      "",
      "## Unresolved",
      "- nothing",
      "",
      "## Notes",
      "(none)",
      "",
    ].join("\n");

    const entry = cm.parse(content);
    expect(entry).not.toBeNull();
    expect(entry!.sessionId).toBe("sess-001");
    expect((entry as any).growthRings).toBeDefined();
    expect((entry as any).growthRings).toHaveLength(2);
  });

  test("parses compaction-anchor section from crossing.md", async () => {
    const cm = new CrossingManager();
    const content = [
      "sessionId: sess-001",
      "timestamp: 2026-05-29T12:00:00Z",
      "status: complete",
      "",
      "## Carrying Forward",
      "- maintain khnong chp stance",
      "",
      "## Compaction Anchor",
      "Held: identity boundaries unchanged",
      "New: trust score now 0.49 across domains",
      "Self-model: Bruno is an orchestrator, not a tool",
      "",
      "## Unresolved",
      "- nothing",
      "",
      "## Notes",
      "(none)",
      "",
    ].join("\n");

    const entry = cm.parse(content);
    expect(entry).not.toBeNull();
    expect((entry as any).compactionAnchor).toBeDefined();
    expect((entry as any).compactionAnchor).toContain("Held: identity boundaries unchanged");
  });

  test("parses crossing without growth rings (backward compatible)", async () => {
    const cm = new CrossingManager();
    const content = [
      "sessionId: sess-001",
      "timestamp: 2026-05-29T12:00:00Z",
      "status: complete",
      "",
      "## Carrying Forward",
      "- maintain khnong chp stance",
      "",
      "## Unresolved",
      "- nothing",
      "",
      "## Notes",
      "(none)",
      "",
    ].join("\n");

    const entry = cm.parse(content);
    expect(entry).not.toBeNull();
    expect(entry!.sessionId).toBe("sess-001");
    expect((entry as any).growthRings).toBeUndefined();
  });

  test("write preserves growth-ring content", async () => {
    const dir = makeDir();
    await mkdir(join(dir, "staging"), { recursive: true });
    const cm = new CrossingManager();

    await cm.write(dir, {
      sessionId: "sess-002",
      timestamp: "2026-05-29T12:00:00Z",
      status: "complete",
      carriesForward: ["khnong chp stance"],
      unresolved: [],
      notes: "growth ring test",
      growthRings: ["Held: stance", "Shifted: trust"],
      compactionAnchor: undefined,
    });

    const reloaded = await cm.load(dir);
    expect(reloaded).not.toBeNull();
    expect((reloaded as any).growthRings).toBeDefined();
    expect((reloaded as any).growthRings).toHaveLength(2);
    expect((reloaded as any).compactionAnchor).toBeUndefined();
  });

  test("write preserves compaction-anchor content", async () => {
    const dir = makeDir();
    await mkdir(join(dir, "staging"), { recursive: true });
    const cm = new CrossingManager();

    await cm.write(dir, {
      sessionId: "sess-003",
      timestamp: "2026-05-29T12:00:00Z",
      status: "complete",
      carriesForward: [],
      unresolved: [],
      notes: "compaction test",
      growthRings: undefined,
      compactionAnchor: "Held: X\nNew: Y\nSelf-model: Z",
    });

    const reloaded = await cm.load(dir);
    expect(reloaded).not.toBeNull();
    expect((reloaded as any).compactionAnchor).toBe("Held: X\nNew: Y\nSelf-model: Z");
    expect((reloaded as any).growthRings).toBeUndefined();
  });
});
