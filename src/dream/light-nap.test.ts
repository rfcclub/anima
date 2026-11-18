import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendBeamEntries, parseBeamEntries, type BeamEntry } from "./light-nap";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "light-nap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeBeam(overrides: Partial<BeamEntry> = {}): BeamEntry {
  return {
    timestamp: "2026-09-13T18:00:00.000Z",
    agent: "hana",
    session: "pulse:integrate",
    keywords: ["integrate"],
    source: "pulse-anima:integrate",
    content: "Before turn 417 the pacing lever and the harness are one instrument.",
    ...overrides,
  };
}

test("appendBeamEntries writes a beam that parseBeamEntries reads back correctly (round-trip)", async () => {
  const beam = makeBeam();
  await appendBeamEntries(dir, [beam]);

  const filePath = join(dir, "staging", "beams", "2026-09-13.md");
  const content = readFileSync(filePath, "utf-8");
  const parsed = parseBeamEntries(content);

  expect(parsed).toHaveLength(1);
  expect(parsed[0].timestamp).toBe(beam.timestamp);
  expect(parsed[0].agent).toBe("hana");
  expect(parsed[0].session).toBe("pulse:integrate");
  expect(parsed[0].keywords).toEqual(["integrate"]);
  expect(parsed[0].source).toBe("pulse-anima:integrate");
  expect(parsed[0].content).toContain("pacing lever and the harness");
});

test("appendBeamEntries appends to an existing same-date file rather than overwriting it", async () => {
  await appendBeamEntries(dir, [makeBeam({ timestamp: "2026-09-13T18:00:00.000Z", agent: "hana" })]);
  await appendBeamEntries(dir, [makeBeam({ timestamp: "2026-09-13T21:00:00.000Z", agent: "lena" })]);

  const filePath = join(dir, "staging", "beams", "2026-09-13.md");
  const parsed = parseBeamEntries(readFileSync(filePath, "utf-8"));

  expect(parsed).toHaveLength(2);
  expect(parsed.map((b) => b.agent)).toEqual(["hana", "lena"]);
});

test("appendBeamEntries groups entries with different dates into separate files", async () => {
  await appendBeamEntries(dir, [
    makeBeam({ timestamp: "2026-09-12T23:00:00.000Z", agent: "hana" }),
    makeBeam({ timestamp: "2026-09-13T01:00:00.000Z", agent: "lena" }),
  ]);

  const day1 = parseBeamEntries(readFileSync(join(dir, "staging", "beams", "2026-09-12.md"), "utf-8"));
  const day2 = parseBeamEntries(readFileSync(join(dir, "staging", "beams", "2026-09-13.md"), "utf-8"));
  expect(day1).toHaveLength(1);
  expect(day2).toHaveLength(1);
  expect(day1[0].agent).toBe("hana");
  expect(day2[0].agent).toBe("lena");
});
