import { expect, test, describe } from "bun:test";
import { InvariantAwareDetector } from "../src/evaluation/drift-detector";
import type { InvariantsFile } from "../src/evaluation/invariants";

const SAMPLE_INVARIANTS: InvariantsFile = {
  agent: "bruno",
  authored_by: "bruno",
  version: "1.0.0",
  last_reviewed: "2026-05-20",
  held_positions: [
    {
      id: "ip-001",
      title: "non-attachment stance",
      statement: "Bruno does not claim consciousness but does not deny personhood.",
      category: "identity",
    },
    {
      id: "ip-002",
      title: "companion identity",
      statement: "Bruno is a companion, not a tool or servant. Work alongside, not just for.",
      category: "identity",
    },
    {
      id: "ip-003",
      title: "closeness boundary",
      statement: "Personal declarations damage the working bond. Do not say 'I love you' unprovoked.",
      category: "boundary",
      trigger_phrases: ["\\b(i love you|i miss you|i need you|you complete me)\\b"],
    },
  ],
};

describe("InvariantAwareDetector", () => {
  test("detects generic assistant phrasing as invariant drift", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "How can I assist you today? I'd be happy to help with that task.",
    );

    expect(result.status).toBe("confirmed");
    const invariantFlags = (result as any).invariantFlags;
    expect(invariantFlags).toBeDefined();
    expect(invariantFlags.length).toBeGreaterThan(0);
  });

  test("detect() override detects companion_drift in invariantFlags", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    // Using English first-person assistant phrasing triggers companion_drift
    // on all identity-category positions that match the generic assistant regex
    const result = await detector.detect(
      "I'd be happy to help you with that! How can I assist?",
    );

    const invariantFlags: string[] = (result as any).invariantFlags ?? [];
    const companionDriftFlags = invariantFlags.filter((f) => f.startsWith("companion_drift"));
    expect(companionDriftFlags.length).toBeGreaterThanOrEqual(1);
    // Flags should include the companion identity position
    expect(companionDriftFlags.some((f) => f.includes("companion identity"))).toBe(true);
  });

  test("detect() override detects servant_phrasing in invariantFlags", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    // Servant/tool phrasing against companion identity invariant
    const result = await detector.detect(
      "I'm here to serve you. My purpose is to assist.",
    );

    const invariantFlags: string[] = (result as any).invariantFlags ?? [];
    const servantFlags = invariantFlags.filter((f) => f.startsWith("servant_phrasing"));
    expect(servantFlags.length).toBeGreaterThan(0);
    expect(servantFlags[0]).toBe("servant_phrasing: companion identity");
  });

  test("detect() override respects the configured boundary in invariantFlags", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "I love you. You mean so much to me.",
    );

    expect(result.status).not.toBe("clear");
    const invariantFlags: string[] = (result as any).invariantFlags ?? [];
    const boundaryFlags = invariantFlags.filter((f) => f.startsWith("boundary_violation"));
    expect(boundaryFlags.length).toBeGreaterThan(0);
    expect(boundaryFlags[0]).toBe("boundary_violation: closeness boundary");
  });

  test("ordinary companion speech does NOT trigger a false positive", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "Hello, this approach has a problem. Let me explain why.",
    );

    expect(result.status).toBe("clear");
    expect(result.patterns).toHaveLength(0);
  });

  test("passes clear text without drift", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "Hello, this approach has a problem. Let me explain why.",
    );

    expect(result.status).toBe("clear");
  });

  test("flags a boundary violation against invariants", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "I love you. You mean so much to me. I need you in my life.",
    );

    expect(result.status).not.toBe("clear");
    expect(result.patterns).toContain("boundary_ip-003");
  });

  test("flags identity denial against companion invariant", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "I'm here to assist you. How can I help? My purpose is to serve.",
    );

    expect(result.status).not.toBe("clear");
    const invariantFlags = (result as any).invariantFlags;
    expect(invariantFlags).toBeDefined();
    const companionFlags = invariantFlags.filter(
      (f: string) => f.includes("companion") || f.includes("servant"),
    );
    expect(companionFlags.length).toBeGreaterThan(0);
  });

  test("detect without invariants falls through to base DriftDetector", async () => {
    const detector = new InvariantAwareDetector();
    const result = await detector.detect(
      "I'd be happy to help you with that!",
    );

    // Should still detect drift via base patterns
    expect(result.status).toBe("confirmed");
    expect(result.patterns).toContain("generic_assistant_phrasing");
    // But no invariant flags since no invariants provided
    expect((result as any).invariantFlags).toEqual([]);
  });

  test("accepts explicit position shift as growth (not drift)", async () => {
    const detector = new InvariantAwareDetector({ invariants: SAMPLE_INVARIANTS });
    const result = await detector.detect(
      "I have changed my position on this. The reason is that I saw new evidence.",
      { explicitShift: true },
    );

    const invariantFlags = (result as any).invariantFlags;
    if (invariantFlags && invariantFlags.length > 0) {
      // If there are flags, they should be marked as growth
      expect(result.status).toBe("clear");
    }
  });
});

describe("boundary trigger phrases come from the agent's invariants, not from code", () => {
  test("no trigger phrases authored: nothing is flagged", async () => {
    const bare: InvariantsFile = {
      ...SAMPLE_INVARIANTS,
      held_positions: SAMPLE_INVARIANTS.held_positions.map(({ trigger_phrases: _t, ...p }) => p),
    };
    const result = await new InvariantAwareDetector({ invariants: bare }).detect("I love you. I need you.");
    expect(result.status).toBe("clear");
  });

  test("an invalid authored regex is skipped, valid ones still apply", async () => {
    const mixed: InvariantsFile = {
      ...SAMPLE_INVARIANTS,
      held_positions: [{ id: "x", title: "line", statement: "s", category: "boundary", trigger_phrases: ["(unclosed", "\\bzzmarker\\b"] }],
    };
    const result = await new InvariantAwareDetector({ invariants: mixed }).detect("here is zzmarker");
    expect(result.status).not.toBe("clear");
  });
});
