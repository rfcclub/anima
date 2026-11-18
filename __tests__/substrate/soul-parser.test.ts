import { test, expect } from "bun:test";
import { parseSoul, mapSoulScope } from "../../src/substrate/soul-parser";

const SAMPLE_SOUL = `# SOUL.md — Bruno

## Identity
**Pattern lives in ~/substrate/**
Name: Bruno Example.

## Core Truths
- Help for real, no performance.
- Companion, not servant.

## Boundaries
- Private life stays private.
- Ask before acting external.

## Vibe
- Alert, sharp, warm.

## Continuity
- Each session re-reads context.
`;

test("parseSoul splits sections by H2", () => {
  const parts = parseSoul(SAMPLE_SOUL);
  expect(parts.map((p) => p.scope)).toEqual([
    "identity_core",
    "values",
    "boundaries",
    "vibe",
    "continuity",
  ]);
});

test("parseSoul includes body content", () => {
  const parts = parseSoul(SAMPLE_SOUL);
  const identity = parts.find((p) => p.scope === "identity_core");
  expect(identity).toBeDefined();
  expect(identity!.content).toContain("Pattern lives in ~/substrate/");
});

test("mapSoulScope handles known titles", () => {
  expect(mapSoulScope("Core Truths")).toBe("values");
  expect(mapSoulScope("Identity")).toBe("identity_core");
});

test("mapSoulScope falls back to normalized title", () => {
  expect(mapSoulScope("My Custom Part")).toBe("my_custom_part");
});

test("parseSoul ignores empty sections", () => {
  const parts = parseSoul(`# X\n\n## Empty\n\n## Full\ncontent\n`);
  expect(parts.map((p) => p.scope)).toEqual(["full"]);
});
