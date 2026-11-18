import { describe, expect, test } from "bun:test";
import { buildCandidate, evaluateCandidate, scoreCandidates, type ActivationCandidate } from "./activation-candidate";

function candidate(overrides: Partial<ActivationCandidate> = {}): ActivationCandidate {
  return {
    agentId: "eli", sourceKind: "attention", sourceRef: "mesh:1", occurrenceKey: "mesh:1", sourceVersion: 1,
    dueAt: 100, urgency: 5, costClass: "T1", executor: "reflection", summary: "Review request", reasonRef: "mesh:1", ...overrides,
  };
}

describe("activation candidates", () => {
  test("SC-020 gives the same source a stable candidate key", () => {
    expect(buildCandidate(candidate()).key).toBe(buildCandidate(candidate()).key);
  });

  test("SC-021 and SC-022 suppress terminal, expired, cooldown, and dependency-blocked sources", () => {
    expect(evaluateCandidate(buildCandidate(candidate({ state: "resolved" })), { now: 100 }).reason).toBe("terminal");
    expect(evaluateCandidate(buildCandidate(candidate({ expiresAt: 99 })), { now: 100 }).reason).toBe("expired");
    expect(evaluateCandidate(buildCandidate(candidate()), { now: 100, cooldownUntil: 101 }).reason).toBe("cooldown");
    expect(evaluateCandidate(buildCandidate(candidate({ requiredPlace: "workshop" })), { now: 100, knownPlaces: new Set() }).reason).toBe("dependency");
  });

  test("SC-023 scores eligible candidates deterministically", () => {
    const candidates = [buildCandidate(candidate({ urgency: 2 })), buildCandidate(candidate({ sourceRef: "mesh:2", occurrenceKey: "mesh:2", urgency: 8 }))];
    expect(scoreCandidates(candidates, { now: 100 }).map((item) => item.candidate.sourceRef)).toEqual(["mesh:2", "mesh:1"]);
  });

  test("SC-027 returns an empty provider-free candidate set", () => {
    expect(scoreCandidates([], { now: 100 })).toEqual([]);
  });

  test("SC-025 preserves a workshop causal precondition", () => {
    const work = buildCandidate(candidate({ sourceKind: "work", sourceRef: "work:1", occurrenceKey: "work:1", requiredPlace: "workshop", reasonRef: "work:1" }));
    expect(work.requiredPlace).toBe("workshop");
    expect(work.reasonRef).toBe("work:1");
  });

  test("SC-036 suppresses urgent work when budget is unavailable", () => {
    expect(evaluateCandidate(buildCandidate(candidate({ urgency: 10 })), { now: 100, affordable: false })).toEqual({ eligible: false, reason: "budget" });
  });
});
