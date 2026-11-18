import { test, expect } from "bun:test";
import { resolveMove, type WorldWeights, type ResolveMoveInput } from "./movement-resolver";

const world: WorldWeights = {
  homePlaceId: "chamber_bruno",
  allPlaces: ["chamber_bruno", "chamber_lena", "hall_main", "garden", "workshop", "gate_machine", "gate_world"],
};

function baseInput(overrides: Partial<ResolveMoveInput> = {}): ResolveMoveInput {
  return {
    agentId: "bruno",
    from: "chamber_bruno",
    disposition: "wander",
    seed: 42,
    world,
    ...overrides,
  };
}

test("SC-020: same seed + same inputs → same destination", () => {
  const a = resolveMove(baseInput({ seed: 42 }));
  const b = resolveMove(baseInput({ seed: 42 }));
  expect(a.to).toBe(b.to);
  expect(a.seed).toBe(42);
});

test("SC-022: different seeds may differ (at least one differs across many)", () => {
  const dests = new Set<string>();
  for (let s = 0; s < 50; s++) {
    dests.add(resolveMove(baseInput({ seed: s })).to);
  }
  // With 7 places and weights, 50 seeds should hit at least 2 distinct places
  expect(dests.size).toBeGreaterThan(1);
});

test("home disposition always returns homePlaceId", () => {
  const r = resolveMove(baseInput({ disposition: "home", from: "garden" }));
  expect(r.to).toBe("chamber_bruno");
});

test("seek disposition with target returns target", () => {
  const r = resolveMove(baseInput({ disposition: "seek", target: "hall_main", from: "chamber_bruno" }));
  expect(r.to).toBe("hall_main");
});

test("seek disposition without target falls back to weighted wander", () => {
  const r = resolveMove(baseInput({ disposition: "seek", from: "chamber_bruno" }));
  expect(world.allPlaces).toContain(r.to);
  expect(r.to).not.toBe("chamber_bruno"); // from is excluded
});

test("baseline gravity returns a known place when no signals exist", () => {
  const r = resolveMove(baseInput({ from: "chamber_bruno" }));
  expect(world.allPlaces).toContain(r.to);
});

test("SC-024: colleague-with-message bias increases weight for colleague's place", () => {
  // With an open meeting at hall_main, hall_main should be heavily favored.
  const worldWithMeeting: WorldWeights = {
    ...world,
    openMeetingPlaceIds: ["hall_main"],
  };
  // Run many seeds; hall_main should win the majority when it has +4 bias
  let hallWins = 0;
  const seeds = 100;
  for (let s = 0; s < seeds; s++) {
    const r = resolveMove(baseInput({ seed: s, world: worldWithMeeting }));
    if (r.to === "hall_main") hallWins++;
  }
  // hall_main baseline weight is 3, +4 for meeting = 7 out of total ~18.
  // Without meeting, hall would win ~3/18 ≈ 17%. With meeting, ~7/18 ≈ 39%.
  // Expect at least 30% (lenient — proves the bias is applied).
  expect(hallWins / seeds).toBeGreaterThan(0.3);
});

test("colleague-with-unread-message bias is applied", () => {
  const worldWithColleague: WorldWeights = {
    ...world,
    colleaguePlaces: [{ agentId: "lena", placeId: "chamber_lena", hasUnreadMessage: true }],
  };
  let lenaWins = 0;
  const seeds = 100;
  for (let s = 0; s < seeds; s++) {
    const r = resolveMove(baseInput({ seed: s, world: worldWithColleague }));
    if (r.to === "chamber_lena") lenaWins++;
  }
  // chamber_lena baseline is 1 (not home, not hall, not garden/workshop) +3 = 4/total.
  // Should be noticeably > 0. Expect at least 15%.
  expect(lenaWins / seeds).toBeGreaterThan(0.15);
});

test("hasActiveWorkItem increases workshop weight", () => {
  const worldWithWork: WorldWeights = {
    ...world,
    hasActiveWorkItem: true,
  };
  let workshopWins = 0;
  const seeds = 100;
  for (let s = 0; s < seeds; s++) {
    const r = resolveMove(baseInput({ seed: s, world: worldWithWork }));
    if (r.to === "workshop") workshopWins++;
  }
  // workshop baseline 2 +3 = 5/total. Expect at least 20%.
  expect(workshopWins / seeds).toBeGreaterThan(0.2);
});

test("from is excluded from candidates", () => {
  for (let s = 0; s < 50; s++) {
    const r = resolveMove(baseInput({ seed: s, from: "garden" }));
    expect(r.to).not.toBe("garden");
  }
});

test("empty candidates returns from", () => {
  const r = resolveMove(baseInput({
    world: { homePlaceId: "chamber_bruno", allPlaces: ["chamber_bruno"] },
  }));
  // Only place is from itself → no candidates → stay
  expect(r.to).toBe("chamber_bruno");
});
