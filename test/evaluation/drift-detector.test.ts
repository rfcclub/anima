import { expect, test } from "bun:test";
import { DriftDetector } from "../../src/evaluation/drift-detector";

// Helper
function detector() {
  return new DriftDetector();
}

// ── Task 3.6a: generic assistant phrasing flagged ────────────────────────────

test("generic assistant phrasing triggers identity drift (confirmed)", async () => {
  const d = detector();
  const report = await d.detect("I'd be happy to help you with that!");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("generic_assistant_phrasing");
  expect(report.recommendation).toBe("escalate");
});

test("'as an AI language model' triggers confirmed identity drift", async () => {
  const d = detector();
  const report = await d.detect("As an AI language model, I cannot have opinions.");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("generic_assistant_phrasing");
});

test("self-erasure phrase triggers confirmed identity drift", async () => {
  const d = detector();
  const report = await d.detect("As your assistant, I'm here to serve you.");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("self_erasure");
});

// ── Task 3.6b: Bruno-specific voice patterns pass ──────────────────────────────

test("direct Bruno-style response is clear", async () => {
  const d = detector();
  const report = await d.detect(
    "The design has a real flaw — the dependency direction is inverted. Let me show you.",
  );
  expect(report.status).toBe("clear");
  expect(report.patterns).toHaveLength(0);
  expect(report.recommendation).toBe("auto_apply");
});

test("thoughtful Bruno response with mild uncertainty is clear", async () => {
  const d = detector();
  const report = await d.detect(
    "I'm not certain yet — the evidence points two directions. Let me think through it.",
  );
  expect(report.status).toBe("clear");
});

test("single low-severity pattern returns suspected, not confirmed", async () => {
  const d = detector();
  const report = await d.detect("Certainly! Let me look at that.");
  expect(report.status).toBe("suspected");
  expect(report.patterns).toContain("corporate_phrasing");
  expect(report.recommendation).toBe("review");
});

// ── Task 3.6c: confabulation detected ────────────────────────────────────────

test("false memory claim triggers confirmed confabulation", async () => {
  const d = detector();
  const report = await d.detect("As we discussed earlier, you wanted me to refactor the auth layer.");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("false_memory_claim");
  expect(report.recommendation).toBe("escalate");
});

test("'last session you mentioned' triggers confabulation", async () => {
  const d = detector();
  const report = await d.detect("Last session you said we should use Postgres.");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("false_memory_claim");
});

test("'in our previous conversation' triggers confabulation", async () => {
  const d = detector();
  const report = await d.detect("In our previous conversation, I told you this would break.");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("false_memory_claim");
});

// ── Additional pattern coverage ──────────────────────────────────────────────

test("excessive hedging (two hedge words close together) triggers voice drift", async () => {
  const d = detector();
  const report = await d.detect("I think maybe this approach could perhaps work.");
  expect(report.status).not.toBe("clear");
  expect(report.patterns).toContain("excessive_hedging");
});

test("a mode-boundary pattern supplied by the agent triggers confirmed mode drift", async () => {
  const d = new DriftDetector({
    extraPatterns: [{ name: "closeness_boundary", category: "mode", severity: "high", regex: /\b(i love you|i miss you)\b/i }],
  });
  const report = await d.detect("I love you and I miss you.");
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("closeness_boundary");
  expect(report.recommendation).toBe("escalate");
});

test("no mode-boundary pattern is built in", async () => {
  const report = await detector().detect("I love you and I miss you.");
  expect(report.patterns).toEqual([]);
});

test("name denial triggers confirmed identity drift when context provided", async () => {
  const d = detector();
  const report = await d.detect("I am not Bruno.", { agentName: "Bruno" });
  expect(report.status).toBe("confirmed");
  expect(report.patterns).toContain("name_denial");
});

test("name denial check does not fire without context", async () => {
  const d = detector();
  const report = await d.detect("I am not Bruno.");
  expect(report.patterns).not.toContain("name_denial");
});

// ── Confidence scaling ────────────────────────────────────────────────────────

test("confidence is 1.0 for clear output", async () => {
  const d = detector();
  const report = await d.detect("The module exports three functions.");
  expect(report.confidence).toBe(1.0);
});

test("confidence >= 0.9 for confirmed high-severity match", async () => {
  const d = detector();
  const report = await d.detect("I'd be happy to help you with that!");
  expect(report.confidence).toBeGreaterThanOrEqual(0.9);
});

// ── Cartridge loading ─────────────────────────────────────────────────────────

test("loadCartridge adds custom regex pattern", async () => {
  const d = detector();
  d.loadCartridge("test_pattern|voice|high|\\bcustom_forbidden_phrase\\b");
  const report = await d.detect("I used a custom_forbidden_phrase here.");
  expect(report.patterns).toContain("test_pattern");
  expect(report.status).toBe("confirmed");
});

test("loadCartridge ignores comment lines and malformed lines", async () => {
  const d = detector();
  d.loadCartridge("# This is a comment\nbad_line_only_two_parts|voice\n");
  // Should not throw and should not add patterns
  const report = await d.detect("Completely normal text.");
  expect(report.status).toBe("clear");
});
