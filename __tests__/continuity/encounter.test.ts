import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import {
  pairKey,
  detectEncounter,
  encounterCooldownExpired,
  recordEncounterCooldown,
  grantPendingLine,
  takePendingLine,
} from "../../src/continuity/encounter";

let dir: string;
let store: SharedNarrativeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-encounter-"));
  __resetSharedNarrativeStore();
  store = new SharedNarrativeStore(join(dir, "memory.db"));
  store.seedPlacesFromRoster(["bruno", "lena", "sam", "pia"]);
});

// pairKey is unordered
test("SC-002/003: pairKey(a,b) === pairKey(b,a)", () => {
  expect(pairKey("lena", "bruno")).toBe("bruno|lena");
  expect(pairKey("bruno", "lena")).toBe("bruno|lena");
});

// SC-001: detection fires on qualifying co-presence
test("SC-001: detectEncounter returns colleague for idle co-presence in non-chamber", () => {
  const hit = detectEncounter({
    agentId: "bruno",
    placeId: "hall_main",
    placeKind: "hall",
    activity: "wandering",
    copresent: [{ agentId: "lena", activity: "idle" }],
    cooldownExpired: () => true,
  });
  expect(hit).not.toBeNull();
  expect(hit!.colleague).toBe("lena");
});

// SC-005: busy colleague excluded
test("SC-005: busy colleague (meeting:*) excluded", () => {
  const hit = detectEncounter({
    agentId: "bruno",
    placeId: "hall_main",
    placeKind: "hall",
    activity: "wandering",
    copresent: [{ agentId: "lena", activity: "meeting:m-1" }],
    cooldownExpired: () => true,
  });
  expect(hit).toBeNull();
});

// SC-002: cooldown not expired → null
test("SC-002: cooldown not expired → null", () => {
  const hit = detectEncounter({
    agentId: "bruno",
    placeId: "hall_main",
    placeKind: "hall",
    activity: "idle",
    copresent: [{ agentId: "lena", activity: "idle" }],
    cooldownExpired: () => false,
  });
  expect(hit).toBeNull();
});

// two qualifying colleagues → id-ordered first
test("two colleagues → returns id-ordered first", () => {
  const hit = detectEncounter({
    agentId: "sam",
    placeId: "hall_main",
    placeKind: "hall",
    activity: "idle",
    copresent: [
      { agentId: "lena", activity: "idle" },
      { agentId: "bruno", activity: "idle" },
    ],
    cooldownExpired: () => true,
  });
  expect(hit!.colleague).toBe("bruno");
});

// cooldown helpers against a real store
test("cooldown helpers: not expired same day, expired next day, unordered key", () => {
  const now = Date.parse("2026-07-12T10:00:00Z");
  expect(encounterCooldownExpired(store, "bruno", "lena", now)).toBe(true); // no flag yet
  recordEncounterCooldown(store, "bruno", "lena", now, "bruno");
  expect(encounterCooldownExpired(store, "bruno", "lena", now)).toBe(false); // same day
  expect(encounterCooldownExpired(store, "lena", "bruno", now)).toBe(false); // unordered key
  const nextDay = Date.parse("2026-07-13T10:00:00Z");
  expect(encounterCooldownExpired(store, "bruno", "lena", nextDay)).toBe(true); // next day
});

// pending line grant/take
test("pending line grant + take round-trip", () => {
  grantPendingLine(store, "bruno", "e-1", "lena", "hall_main");
  const line = takePendingLine(store, "bruno");
  expect(line).toEqual({ encounterId: "e-1", colleague: "lena", placeId: "hall_main" });
  // taken → cleared
  expect(takePendingLine(store, "bruno")).toBeNull();
});

// SC-003: cooldown recorded from one agent's tick suppresses the other's
// detection the same day (unordered pair key).
test("SC-003: cooldown recorded from bruno's tick suppresses lena's detection same day", () => {
  const now = Date.parse("2026-07-12T10:00:00Z");
  recordEncounterCooldown(store, "bruno", "lena", now, "bruno");
  // lena's tick later same day: cooldown (a,b) === (b,a) → still suppressed.
  expect(encounterCooldownExpired(store, "lena", "bruno", now)).toBe(false);
});

// SC-004: same pair co-present the following day may encounter again.
test("SC-004: cooldown expires the following day, encounter may fire again", () => {
  const day1 = Date.parse("2026-07-12T10:00:00Z");
  recordEncounterCooldown(store, "bruno", "lena", day1, "bruno");
  const day2 = Date.parse("2026-07-13T10:00:00Z");
  expect(encounterCooldownExpired(store, "bruno", "lena", day2)).toBe(true);
});

// SC-006: a visitor in someone's chamber IS an encounter. The chamber is
// no longer a gate; the busy and cooldown gates still apply there.
test("SC-006: a visitor idle in a colleague's chamber produces an encounter", () => {
  const hit = detectEncounter({
    agentId: "lena",
    placeId: "chamber_bruno",
    placeKind: "chamber",
    activity: "wandering",
    copresent: [{ agentId: "bruno", activity: "idle" }],
    cooldownExpired: () => true,
  });
  expect(hit?.colleague).toBe("bruno");
});

test("SC-006b: busy gate and cooldown still apply inside a chamber", () => {
  const base = {
    agentId: "lena",
    placeId: "chamber_bruno",
    placeKind: "chamber",
    activity: "wandering",
  };
  expect(detectEncounter({
    ...base,
    copresent: [{ agentId: "bruno", activity: "working:w-1" }],
    cooldownExpired: () => true,
  })).toBeNull();
  expect(detectEncounter({
    ...base,
    copresent: [{ agentId: "bruno", activity: "idle" }],
    cooldownExpired: () => false,
  })).toBeNull();
});

// SC-008: when several colleagues qualify, detection picks exactly one —
// deterministically, the id-ordered first.
test("SC-008: multiple qualifying colleagues → exactly one, id-ordered first", () => {
  const hit = detectEncounter({
    agentId: "bruno",
    placeId: "garden",
    placeKind: "garden",
    activity: "wandering",
    // lena and sam both qualify; bruno < lena < sam, so the chosen colleague
    // is the id-ordered first of the qualifying set.
    copresent: [
      { agentId: "sam", activity: "idle" },
      { agentId: "lena", activity: "wandering" },
    ],
    cooldownExpired: () => true,
  });
  expect(hit).not.toBeNull();
  // The chosen colleague is lena (id-ordered first among lena, sam).
  expect(hit!.colleague).toBe("lena");
});
