import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractProposals,
  loadAxioms,
  readInbox,
  renderInbox,
  writeInbox,
  INBOX_MIN_CONFIDENCE,
  INBOX_MIN_EVIDENCE,
  type MemoryCandidate,
} from "./inbox";

let roomDir: string;

beforeEach(() => {
  roomDir = mkdtempSync(join(tmpdir(), "inbox-"));
});

afterEach(() => {
  rmSync(roomDir, { recursive: true, force: true });
});

function entry(overrides: Partial<MemoryCandidate> & { id: string }): MemoryCandidate {
  return {
    content: "some observation",
    tags: ["craft"],
    confidence: 0.8,
    ...overrides,
  };
}

test("extracts a proposal only when confidence and evidence clear the thresholds", () => {
  const proposals = extractProposals([
    entry({ id: "a", content: "A1", tags: ["craft"], confidence: 0.9 }),
    entry({ id: "b", content: "A2", tags: ["craft"], confidence: 0.85 }),
    entry({ id: "c", content: "A3", tags: ["craft"], confidence: 0.8 }),
    // too little evidence
    entry({ id: "d", content: "B1", tags: ["weather"], confidence: 0.95 }),
    entry({ id: "e", content: "B2", tags: ["weather"], confidence: 0.95 }),
    // enough evidence, confidence below the threshold
    entry({ id: "f", content: "C1", tags: ["noise"], confidence: INBOX_MIN_CONFIDENCE - 0.1 }),
    entry({ id: "g", content: "C2", tags: ["noise"], confidence: INBOX_MIN_CONFIDENCE - 0.1 }),
    entry({ id: "h", content: "C3", tags: ["noise"], confidence: INBOX_MIN_CONFIDENCE - 0.1 }),
  ]);

  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.tags).toEqual(["craft"]);
  expect(proposals[0]!.sources).toEqual(["a", "b", "c"]);
  expect(proposals[0]!.evidenceCount).toBe(INBOX_MIN_EVIDENCE);
  expect(proposals[0]!.confidence).toBeCloseTo(0.85, 5);
  expect(proposals[0]!.claim).toBe("A3");
});

test("a proposal that contradicts the agent's axioms is not extracted", () => {
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(join(roomDir, "AXIOMS.md"), "- share memory freely\n- keep the room warm\n", "utf-8");
  writeFileSync(join(roomDir, "SOUL.md"), "I am an agent.\n", "utf-8");
  const axioms = loadAxioms(roomDir);
  expect(axioms).toEqual(["share memory freely", "keep the room warm"]);

  const proposals = extractProposals(
    [
      entry({ id: "a", content: "never share memory freely", tags: ["craft"], confidence: 0.9 }),
      entry({ id: "b", content: "share memory freely with peers", tags: ["craft"], confidence: 0.9 }),
      entry({ id: "c", content: "keep notes", tags: ["craft"], confidence: 0.9 }),
    ],
    { axioms },
  );

  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.sources).not.toContain("a");
});

test("writes INBOX.md into staging and reads it back", async () => {
  const proposals = extractProposals([
    entry({ id: "a", content: "A1", tags: ["craft"], confidence: 0.9 }),
    entry({ id: "b", content: "A2", tags: ["craft"], confidence: 0.85 }),
    entry({ id: "c", content: "A3", tags: ["craft"], confidence: 0.8 }),
  ]);

  const path = await writeInbox(roomDir, "lena", proposals);
  expect(path).toBe(join(roomDir, "staging", "INBOX.md"));
  expect(existsSync(path)).toBe(true);

  const markdown = renderInbox("lena", proposals);
  expect(markdown).toContain("A3");

  const readBack = await readInbox(roomDir);
  expect(readBack).toHaveLength(1);
  expect(readBack![0]!.sources).toEqual(["a", "b", "c"]);
  expect(readBack![0]!.evidenceCount).toBe(3);
  expect(readBack![0]!.confidence).toBeCloseTo(0.85, 5);
  expect(readBack![0]!.claim).toBe("A3");
});

test("no inbox file means nothing to judge", async () => {
  expect(await readInbox(roomDir)).toBeUndefined();
});
