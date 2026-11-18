import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// SC-501/502: the prompt-construction seam. All room-prompt templates live
// in src/narrative/presence-context.ts; talk.ts must not inline template text.
// A source-guard test keeps the seam single-module over time — prompt-content drift is the failure mode.

const TALK = readFileSync("src/ui/features/town/api/talk.ts", "utf8");
const PC = readFileSync("src/narrative/presence-context.ts", "utf8");

test("SC-502: room-prompt templates exported from presence-context seam", () => {
  expect(PC).toMatch(/export function buildPresenceLine/);
  expect(PC).toMatch(/export function buildOrientationLine/);
  expect(PC).toMatch(/export function buildGuestFollowupMessage/);
  expect(PC).toMatch(/export function buildFollowupMessage/);
});

test("SC-501: talk.ts has no inline room-prompt template text", () => {
  // Patterns that indicate inline template construction (prompt
  // fragments that should live in the seam module). Strip comments first so
  // a doc reference to the template doesn't trip the guard.
  const stripped = TALK.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const inlinePatterns = [
    /In .{0,40}'s room/,
    /The user asks: "/,
    /return "\.\.\."/,
    /if you would rather not/,
  ];
  for (const re of inlinePatterns) {
    const matches = stripped.match(new RegExp(re.source, "g"));
    expect(matches ?? []).toEqual([]);
  }
});
