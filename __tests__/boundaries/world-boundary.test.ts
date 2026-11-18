import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findForbiddenImports,
  findForbiddenImportsInSource,
  listSourceFiles,
} from "./scan-imports";

const ROOT = join(import.meta.dir, "..", "..");

// The one path forbidden here is the memory-adapter factory + concrete adapters —
// `src/memory/contract.ts` (types only) and `src/memory/jsonl-store.ts` (an
// already-existing, harmless type-only import, confirmed by a fresh grep at
// RED time) are deliberately NOT in this list.
const FORBIDDEN_MEMORY_IMPORTS = [
  "memory/store-registry",
  "memory/anima-entity-store",
  "memory/bodega-adapter",
  "memory/bruno-entity-adapter",
  "memory/abel-mem-adapter",
  "memory/abel-mem-bun-adapter",
  "memory/continuity-adapter",
];

describe("SC-30/SC-31 src/continuity and src/narrative cannot reach store-registry or adapters", () => {
  test("src/continuity/** has no forbidden memory imports", () => {
    const violations = findForbiddenImports(join(ROOT, "src", "continuity"), FORBIDDEN_MEMORY_IMPORTS);
    expect(violations).toEqual([]);
  });

  test("src/narrative/** has no forbidden memory imports", () => {
    const violations = findForbiddenImports(join(ROOT, "src", "narrative"), FORBIDDEN_MEMORY_IMPORTS);
    expect(violations).toEqual([]);
  });

  test("the allowlisted type-only imports (contract.ts, jsonl-store.ts) are untouched by this check", () => {
    const allSourceFiles = listSourceFiles(join(ROOT, "src", "continuity"));
    expect(allSourceFiles.length).toBeGreaterThan(0);
    // Confirms the scanner actually inspected real files rather than vacuously passing.
  });
});

describe("SC-32 packages/continuity-core has zero import edges into src/agora, src/continuity, src/narrative", () => {
  test("no continuity-core source file imports agora, continuity, or narrative", () => {
    const violations = findForbiddenImports(join(ROOT, "packages", "continuity-core", "src"), [
      "src/agora",
      "src/continuity",
      "src/narrative",
      "/agora/",
      "/continuity/index",
      "/narrative/",
    ]);
    expect(violations).toEqual([]);
  });
});

describe("SC-33 src/agora contains no continuity symbols", () => {
  const BANNED_SYMBOLS = [
    "ProjectionManifest",
    "IncarnationLease",
    "IncarnationPort",
    "ContinuityPort",
    "ProposalPromoter",
    "domain_revisions",
  ];

  test("src/agora does not import continuity-core", () => {
    const violations = findForbiddenImports(join(ROOT, "src", "agora"), ["continuity-core"]);
    expect(violations).toEqual([]);
  });

  test("src/agora source text does not declare/reference continuity-plane symbols", () => {
    const files = listSourceFiles(join(ROOT, "src", "agora"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      for (const symbol of BANNED_SYMBOLS) {
        if (source.includes(symbol)) offenders.push(`${file}: ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("SC-34 scanner catches injected violations (negative fixture)", () => {
  test("a fixture import of the forbidden factory is flagged", () => {
    const fixtureSource = `
import { createAgentMemoryStore } from "../memory/store-registry";
export function bad() { return createAgentMemoryStore; }
`;
    const violations = findForbiddenImportsInSource(fixtureSource, "fixture.ts", FORBIDDEN_MEMORY_IMPORTS);
    expect(violations.length).toBe(1);
    expect(violations[0].matched).toBe("memory/store-registry");
  });

  test("a fixture importing an allowlisted type-only module is not flagged", () => {
    const fixtureSource = `
import type { AgentMemoryStore } from "../memory/contract";
`;
    const violations = findForbiddenImportsInSource(fixtureSource, "fixture.ts", FORBIDDEN_MEMORY_IMPORTS);
    expect(violations).toEqual([]);
  });

  test("a fixture continuity-core file importing src/continuity is flagged", () => {
    const fixtureSource = `import { something } from "../../../src/continuity/gate";`;
    const violations = findForbiddenImportsInSource(fixtureSource, "fixture.ts", ["src/continuity"]);
    expect(violations.length).toBe(1);
  });
});
