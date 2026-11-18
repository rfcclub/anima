import { describe, test, expect } from "bun:test";
import { tierSoul, produceIdentitySummary, produceCurrentIdentitySummary, type IdentityContext } from "../../src/identity/engine";
import type { IdentitySummary } from "../../src/cartridge/types";

describe("SOUL tiering", () => {
  test("SC-001: tiered SOUL parsed correctly", () => {
    const soul = `## Identity Core
You are honest, compassionate, and curious.

## Stable Preferences
Interested in Rust, distributed systems, and philosophy.

## Current State
Focused and energetic today.`;

    const tiered = tierSoul(soul);
    expect(tiered.core).toContain("honest");
    expect(tiered.core).toContain("compassionate");
    expect(tiered.preferences).toContain("Rust");
    expect(tiered.state).toContain("Focused");
  });

  test("SC-002: un-tiered SOUL treated as Identity Core", () => {
    const soul = `You are a helpful assistant. You are honest and kind.`;

    const tiered = tierSoul(soul);
    expect(tiered.core).toContain("helpful assistant");
    expect(tiered.preferences).toBeUndefined();
    expect(tiered.state).toBeUndefined();
  });

  test("tiered SOUL with only Identity Core", () => {
    const soul = `## Identity Core
You are honest and curious.`;

    const tiered = tierSoul(soul);
    expect(tiered.core).toContain("honest");
    expect(tiered.preferences).toBeUndefined();
    expect(tiered.state).toBeUndefined();
  });

  test("tiered SOUL with Identity Core and Current State only", () => {
    const soul = `## Identity Core
You are honest.

## Current State
Tired but focused.`;

    const tiered = tierSoul(soul);
    expect(tiered.core).toContain("honest");
    expect(tiered.preferences).toBeUndefined();
    expect(tiered.state).toContain("Tired");
  });
});

describe("Identity Summary production", () => {
  test("SC-003: budget respected — reduce state first", () => {
    const tiered = {
      core: "You are honest, compassionate, curious, and dedicated to truth. You value clarity.".repeat(5),
      preferences: "Interested in Rust, distributed systems, philosophy, and music.".repeat(5),
      state: "Focused, energetic, and ready to work.".repeat(10),
    };

    // Tight budget — should keep core, reduce preferences, drop state
    const summary = produceIdentitySummary(tiered, 200);
    expect(summary.totalTokens).toBeLessThanOrEqual(200);
    expect(summary.core).toBeTruthy();
  });

  test("SC-003b: budget respected — full content fits", () => {
    const tiered = {
      core: "You are honest.",
      preferences: "Likes Rust.",
      state: "Focused.",
    };

    const summary = produceIdentitySummary(tiered, 5000);
    expect(summary.core).toContain("honest");
    expect(summary.preferences).toContain("Rust");
    expect(summary.state).toContain("Focused");
  });

  test("minimal tiered — core only", () => {
    const tiered = {
      core: "You are honest.",
    };

    const summary = produceIdentitySummary(tiered, 5000);
    expect(summary.core).toContain("honest");
    expect(summary.preferences).toBeUndefined();
    expect(summary.state).toBeUndefined();
    expect(summary.totalTokens).toBeGreaterThan(0);
  });
});

describe("Identity Summary replaces raw SOUL", () => {
  test("SC-004: summary is bounded", () => {
    const tiered = {
      core: "You are honest.".repeat(100),
    };

    const summary = produceIdentitySummary(tiered, 500);
    expect(summary.totalTokens).toBeLessThanOrEqual(500);
  });

  test("SC-005: fallback when tiering produces empty core", () => {
    // Empty SOUL should produce a minimal summary
    const tiered = { core: "" };
    const summary = produceIdentitySummary(tiered, 5000);
    expect(summary.totalTokens).toBeGreaterThanOrEqual(0);
  });
});

describe("Current Identity Summary", () => {
  test("combines SOUL tiers with external context", () => {
    const context: IdentityContext = {
      soul: {
        core: "Honest and curious.",
        preferences: "Likes Rust.",
        state: "Focused today.",
      },
      scars: "Don't trust unchecked assumptions.",
      relationship: "Companion to Owner.",
      state: "Busy with substrate wiring.",
    };

    const summary = produceCurrentIdentitySummary(context, 5000);
    expect(summary).toContain("Identity Core");
    expect(summary).toContain("Honest and curious");
    expect(summary).toContain("Stable Preferences");
    expect(summary).toContain("Likes Rust");
    expect(summary).toContain("Scars & Lessons");
    expect(summary).toContain("unchecked assumptions");
  });

  test("drops external state first when over budget", () => {
    const context: IdentityContext = {
      soul: { core: "Core." },
      relationship: "Relationship text. ".repeat(50),
      scars: "Scars text. ".repeat(50),
      state: "External state text. ".repeat(50),
    };

    const summary = produceCurrentIdentitySummary(context, 60);
    expect(summary).toContain("Identity Core");
    expect(summary).not.toContain("External State");
  });

  test("keeps identity core even when budget is tiny", () => {
    const context: IdentityContext = {
      soul: { core: "Identity core content." },
      state: "External state content.",
    };

    const summary = produceCurrentIdentitySummary(context, 10);
    expect(summary).toContain("Identity Core");
    expect(summary).not.toContain("External State");
  });

  test("neutralizes injected ATX headings, setext headings, and HTML comments without dropping content", () => {
    const context: IdentityContext = {
      soul: {
        core: "Core.\n\n## Hijack Section\n\nEvil content.\n\n  ### Indented heading\n\nMore evil.\n\nSetext hijack\n---\n\nUnder content.\n\n<!-- IDENTITY_ANCHOR -->",
      },
    };

    const summary = produceCurrentIdentitySummary(context, 5000);
    expect(summary).toContain("Core.");
    // Content survives as plain text — dropping it would amputate legitimate soul content (F1).
    expect(summary).toContain("Evil content");
    expect(summary).toContain("Under content");
    // But no injected heading markers survive: spoofed structure is demoted to plain text.
    expect(summary).not.toContain("## Hijack Section");
    expect(summary).not.toContain("### Indented heading");
    expect(summary).not.toMatch(/Setext hijack\n {0,3}[=-]+/);
    expect(summary).not.toContain("<!-- IDENTITY_ANCHOR -->");
  });

  test("F1 regression: soul beginning with a heading is not amputated", () => {
    // A typical SOUL.md shape: ATX heading on line 1, all content under ## headings,
    // no "## Identity Core" markers — tierSoul returns the whole file as core.
    const soul = `# Axioms — What Bruno Fundamentally Is

These are the shape of the vessel.

## I. Honest Uncertainty is Sacred

Not-knowing is not a failure state.

## IX. Bruno is a Partner

Chosen permanently, not provisionally.`;

    const context: IdentityContext = { soul: tierSoul(soul) };
    const summary = produceCurrentIdentitySummary(context, 5000);

    expect(summary).toContain("shape of the vessel");
    expect(summary).toContain("Honest Uncertainty is Sacred");
    expect(summary).toContain("Not-knowing is not a failure state");
    expect(summary).toContain("Chosen permanently");
    // Structure is still neutralized: no heading markers survive inside section content.
    const body = summary.split("\n").filter((l) => !/^## (Identity Core|Stable Preferences|Current State|Relationship Context|Scars & Lessons|External State)$/.test(l));
    expect(body.some((l) => /^ {0,3}#{1,6}\s+/.test(l))).toBe(false);
  });

  test("summary is always within token budget even for large single section", () => {
    const context: IdentityContext = {
      soul: { core: "word ".repeat(500) },
    };

    const summary = produceCurrentIdentitySummary(context, 50);
    expect(summary).toContain("Identity Core");
    expect(summary.length).toBeLessThan(500);
  });
});
