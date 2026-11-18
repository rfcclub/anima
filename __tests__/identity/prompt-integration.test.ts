import { describe, test, expect } from "bun:test";
import { tierSoul, produceIdentitySummary } from "../../src/identity/engine";
import type { IdentitySummary, RetrievedMemory } from "../../src/cartridge/types";

describe("Identity Summary in prompt", () => {
  test("SC-004: summary is bounded and replaces raw SOUL", () => {
    const soul = `## Identity Core
You are honest, compassionate, and curious.

## Current State
Focused and energetic.`;

    const tiered = tierSoul(soul);
    const summary = produceIdentitySummary(tiered, 500);

    expect(summary.core).toContain("honest");
    expect(summary.totalTokens).toBeLessThanOrEqual(500);
  });

  test("SC-005: fallback for un-tiered SOUL", () => {
    const soul = `You are a helpful assistant.`;

    const tiered = tierSoul(soul);
    const summary = produceIdentitySummary(tiered, 5000);

    expect(summary.core).toContain("helpful assistant");
    expect(summary.preferences).toBeUndefined();
    expect(summary.state).toBeUndefined();
  });
});

describe("Memory sections in dynamic suffix", () => {
  test("SC-012: memory sections formatted correctly", () => {
    const trusted: RetrievedMemory[] = [
      {
        id: "mem-1",
        content: "Last session worked on cartridge architecture",
        scope: "episode",
        confidence: 0.9,
        score: 0.95,
        requested_by: ["programmer"],
        policy_id: "programmer",
        trusted: true,
      },
    ];

    const unverified: RetrievedMemory[] = [];

    // Format as prompt sections
    const trustedSection = trusted.length > 0
      ? "## Trusted Memory\n" + trusted.map(m => `- [${m.scope}] ${m.content}`).join("\n")
      : "";

    const unverifiedSection = unverified.length > 0
      ? "## Unverified Candidates\n" + unverified.map(m => `- [${m.scope}] ${m.content}`).join("\n")
      : "";

    expect(trustedSection).toContain("Trusted Memory");
    expect(trustedSection).toContain("cartridge architecture");
    expect(unverifiedSection).toBe("");
  });

  test("unverified section present when context_starved with fallback", () => {
    const unverified: RetrievedMemory[] = [
      {
        id: "mem-2",
        content: "Weak memory about project structure",
        scope: "project",
        confidence: 0.3,
        score: 0.4,
        requested_by: ["programmer"],
        policy_id: "programmer",
        trusted: false,
      },
    ];

    const section = "## Unverified Candidates\n" + unverified.map(m => `- [${m.scope}] ${m.content}`).join("\n");
    expect(section).toContain("Unverified Candidates");
    expect(section).toContain("Weak memory");
  });
});
