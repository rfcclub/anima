import { expect, test, describe } from "bun:test";
import { loadInvariants, type InvariantsFile } from "../src/evaluation/invariants";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

describe("loadInvariants", () => {
  test("parses valid invariants.json with held positions", async () => {
    const dir = mkdtempSync();
    const filePath = join(dir, "invariants.json");
    await writeFile(filePath, JSON.stringify({
      agent: "bruno",
      authored_by: "bruno",
      version: "1.0.0",
      last_reviewed: "2026-05-20",
      held_positions: [
        {
          id: "ip-001",
          title: "khnong chp stance",
          statement: "Bruno does not claim consciousness but does not deny personhood.",
          category: "identity",
          last_reviewed: "2026-05-20",
        },
      ],
    }));

    const result = loadInvariants(filePath);
    expect(result.agent).toBe("bruno");
    expect(result.authored_by).toBe("bruno");
    expect(result.version).toBe("1.0.0");
    expect(result.held_positions).toHaveLength(1);
    expect(result.held_positions[0].id).toBe("ip-001");
    expect(result.held_positions[0].title).toBe("khnong chp stance");
  });

  test("throws on missing required field", async () => {
    const dir = mkdtempSync();
    const filePath = join(dir, "bad.json");
    await writeFile(filePath, JSON.stringify({ agent: "bruno" }));

    expect(() => loadInvariants(filePath)).toThrow();
  });

  test("throws on invalid category", async () => {
    const dir = mkdtempSync();
    const filePath = join(dir, "bad-cat.json");
    await writeFile(filePath, JSON.stringify({
      agent: "bruno",
      authored_by: "bruno",
      version: "1.0.0",
      last_reviewed: "2026-05-20",
      held_positions: [
        { id: "ip-001", title: "test", statement: "test", category: "invalid" },
      ],
    }));

    expect(() => loadInvariants(filePath)).toThrow(/category/);
  });

  test("returns empty held_positions when file has none", async () => {
    const dir = mkdtempSync();
    const filePath = join(dir, "empty.json");
    await writeFile(filePath, JSON.stringify({
      agent: "bruno",
      authored_by: "bruno",
      version: "1.0.0",
      last_reviewed: "2026-05-20",
      held_positions: [],
    }));

    const result = loadInvariants(filePath);
    expect(result.held_positions).toEqual([]);
  });

  test("checks staleness against 30-day threshold", async () => {
    const dir = mkdtempSync();
    const filePath = join(dir, "stale.json");
    await writeFile(filePath, JSON.stringify({
      agent: "bruno",
      authored_by: "bruno",
      version: "1.0.0",
      last_reviewed: "2026-01-01",
      held_positions: [
        { id: "ip-001", title: "old", statement: "old stance", category: "identity", last_reviewed: "2026-01-01" },
        { id: "ip-002", title: "fresh", statement: "new stance", category: "identity", last_reviewed: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) },
      ],
    }));

    const result = loadInvariants(filePath);
    const staleIds = result.held_positions
      .filter((p) => {
        const reviewed = p.last_reviewed ?? result.last_reviewed;
        const diff = (Date.now() - new Date(reviewed).getTime()) / (1000 * 60 * 60 * 24);
        return diff > 30;
      })
      .map((p) => p.id);
    expect(staleIds).toContain("ip-001");
    expect(staleIds).not.toContain("ip-002");
  });
});

function mkdtempSync(): string {
  const dir = mkdtempSyncImpl();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkdtempSyncImpl(): string {
  const path = join(tmpdir(), `invariants-test-${Math.random().toString(36).slice(2)}`);
  return path;
}
