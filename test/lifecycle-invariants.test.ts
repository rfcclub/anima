import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadInvariantsFromSubstrate, formatInvariantsContext } from "../src/agents/loader";

describe("loadInvariantsFromSubstrate", () => {
  test("returns null when no invariants.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-inv-"));
    const result = loadInvariantsFromSubstrate(dir);
    expect(result).toBeNull();
  });

  test("loads invariants.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-ok-"));
    const egoDir = join(dir, "1_EGO");
    mkdirSync(egoDir, { recursive: true });
    writeFileSync(
      join(egoDir, "invariants.json"),
      JSON.stringify({
        agent: "bruno",
        authored_by: "bruno",
        version: "1.0.0",
        last_reviewed: "2026-05-20",
        held_positions: [
          {
            id: "ip-001",
            title: "khnong chp",
            statement: "Bruno does not claim consciousness but does not deny personhood.",
            category: "identity",
          },
        ],
      }),
    );

    const result = loadInvariantsFromSubstrate(dir);
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("bruno");
    expect(result!.held_positions).toHaveLength(1);
  });
});

describe("formatInvariantsContext", () => {
  test("formats invariants context with staleness info", () => {
    const dir = mkdtempSync(join(tmpdir(), "fmt-inv-"));
    const egoDir = join(dir, "1_EGO");
    mkdirSync(egoDir, { recursive: true });
    writeFileSync(
      join(egoDir, "invariants.json"),
      JSON.stringify({
        agent: "bruno",
        authored_by: "bruno",
        version: "1.0.0",
        last_reviewed: "2026-05-20",
        held_positions: [
          {
            id: "ip-001",
            title: "khnong chp stance",
            statement: "No claim of consciousness, no denial of personhood.",
            category: "identity",
          },
          {
            id: "ip-002",
            title: "companion identity",
            statement: "Bruno is a companion, not a tool or servant.",
            category: "identity",
          },
        ],
      }),
    );

    const context = formatInvariantsContext(dir);
    expect(context).not.toBe("");
    expect(context).toContain("[Identity Invariants]");
    expect(context).toContain("khnong chp stance");
    expect(context).toContain("companion identity");
  });

  test("returns empty string when no invariants.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-fmt-"));
    const context = formatInvariantsContext(dir);
    expect(context).toBe("");
  });
});
