import { test, expect } from "bun:test";
import { placeLabel } from "../../src/ui/features/castle/lib/place-labels";
import { computeRoomCase } from "../../src/ui/features/castle/lib/room-presence";
import type { PresenceMap } from "../../src/ui/features/castle/lib/use-presence";

// ── placeLabel ──────────────────────────────────────────────────────────

test("placeLabel: chamber placeIds resolve to chamber sprite labels", () => {
  expect(placeLabel("chamber_bruno")).toBe("Bruno's Garden");
  expect(placeLabel("chamber_eli")).toBe("Eli's Study");
  expect(placeLabel("chamber_lena")).toBe("Lena's Sanctuary");
  expect(placeLabel("chamber_abel")).toBe("2B's Armory");
  expect(placeLabel("chamber_gus")).toBe("Gus's Chamber");
  expect(placeLabel("chamber_kai")).toBe("Kai's Dawn");
});

test("placeLabel: public placeIds resolve to common-room labels", () => {
  expect(placeLabel("hall_main")).toBe("Town Hall");
  expect(placeLabel("workshop")).toBe("Forge");
  expect(placeLabel("garden")).toBe("Bodega");
  expect(placeLabel("gate_world")).toBe("Bridge");
});

test("placeLabel: unknown placeId returns the raw id (never throws)", () => {
  expect(placeLabel("chamber_unknown_agent")).toBe("chamber_unknown_agent");
  expect(placeLabel("somewhere_new")).toBe("somewhere_new");
  expect(placeLabel("")).toBe("");
});

// ── computeRoomCase ─────────────────────────────────────────────────────

function presence(entries: Record<string, string[]>): PresenceMap {
  return entries;
}

test("computeRoomCase 1: owner alone → normal", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_bruno: ["bruno"] }),
    mode: "interact",
  });
  expect(state.case).toBe("normal");
  expect(state.visitors).toEqual([]);
  expect(state.ownerDestination).toBeUndefined();
});

test("computeRoomCase 1 (watch): owner alone watch → still normal (watch only splits meeting)", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_bruno: ["bruno"] }),
    mode: "watch",
  });
  expect(state.case).toBe("normal");
});

test("computeRoomCase 2: owner + visitor interact → meetingActive", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_bruno: ["bruno", "lena"] }),
    mode: "interact",
  });
  expect(state.case).toBe("meetingActive");
  expect(state.visitors).toEqual(["lena"]);
});

test("computeRoomCase 3: owner + visitor watch → meetingPassive", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_bruno: ["bruno", "lena"] }),
    mode: "watch",
  });
  expect(state.case).toBe("meetingPassive");
  expect(state.visitors).toEqual(["lena"]);
});

test("computeRoomCase 4: empty room → empty", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({}),
    mode: "interact",
  });
  expect(state.case).toBe("empty");
  expect(state.visitors).toEqual([]);
});

test("computeRoomCase 4 (watch): empty room watch → empty (mode-independent)", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_lena: ["lena"] }), // someone elsewhere, bruno's room empty
    mode: "watch",
  });
  expect(state.case).toBe("empty");
});

test("computeRoomCase 5: owner away + visitor → visitorOnly with destination", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_eli: ["bruno"], chamber_bruno: ["lena"] }),
    mode: "interact",
  });
  expect(state.case).toBe("visitorOnly");
  expect(state.visitors).toEqual(["lena"]);
  expect(state.ownerDestination).toBe("chamber_eli");
});

test("computeRoomCase 5 (watch): owner away + visitor watch → visitorOnly (input disabled at component)", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ hall_main: ["bruno"], chamber_bruno: ["eli"] }),
    mode: "watch",
  });
  expect(state.case).toBe("visitorOnly");
  expect(state.visitors).toEqual(["eli"]);
  expect(state.ownerDestination).toBe("hall_main");
});

test("computeRoomCase 5: owner with no presence row → visitorOnly, destination undefined", () => {
  // Owner absent from their room AND absent everywhere — "absent" fallback.
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_bruno: ["lena"] }),
    mode: "interact",
  });
  expect(state.case).toBe("visitorOnly");
  expect(state.visitors).toEqual(["lena"]);
  expect(state.ownerDestination).toBeUndefined();
});

test("computeRoomCase: multiple visitors all captured", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ chamber_bruno: ["bruno", "lena", "eli", "sam"] }),
    mode: "interact",
  });
  expect(state.case).toBe("meetingActive");
  expect(state.visitors).toEqual(["lena", "eli", "sam"]);
});

test("computeRoomCase: owner at a public place still counts as 'away' from their chamber", () => {
  const state = computeRoomCase({
    ownerId: "bruno",
    presence: presence({ garden: ["bruno"], chamber_bruno: ["lena"] }),
    mode: "interact",
  });
  expect(state.case).toBe("visitorOnly");
  expect(state.ownerDestination).toBe("garden");
});
