import { test, expect } from "bun:test";
import { SharedNarrativeStore } from "../../src/narrative/shared-store";
import { ALL_PUBLIC_PLACE_IDS, PUBLIC_PLACES, occupantsForSprite, placesForSprite } from "../../src/ui/features/castle/lib/public-places";
import { PUBLIC_SPRITE_TO_PLACE } from "../../src/ui/features/castle/lib/place-labels";
import { COMMON_ROOM_SPRITES } from "../../src/ui/features/castle/lib/map-sprites";

// castle-presence-persistence, A: wanders to gate_machine, a non-chamber
// place, must be represented by a map marker, or that movement is invisible.

test("every non-chamber place the store seeds is shown by some public map marker", () => {
  const store = new SharedNarrativeStore(":memory:");
  store.seedPlacesFromRoster(["bruno", "eli"]);
  const covered = new Set(Object.values(PUBLIC_PLACES).flat());
  const missing = store
    .listPlaces()
    .filter((p) => p.kind !== "chamber")
    .map((p) => p.id)
    .filter((id) => !covered.has(id));
  expect(missing).toEqual([]);
});

test("every PUBLIC_PLACES key is a real common-room sprite", () => {
  const spriteIds = new Set(COMMON_ROOM_SPRITES.map((s) => s.id));
  for (const key of Object.keys(PUBLIC_PLACES)) expect(spriteIds.has(key)).toBe(true);
});

test("the Bridge marker shows agents at gate_machine as well as gate_world", () => {
  const presence = { gate_world: ["ivan"], gate_machine: ["rhea", "hana"], hall_main: ["eli"] };
  expect(occupantsForSprite("bridge", presence)).toEqual(["ivan", "rhea", "hana"]);
});

test("a sprite with one place shows only that place's occupants; an empty place gives []", () => {
  const presence = { hall_main: ["eli"], gate_machine: ["rhea"] };
  expect(occupantsForSprite("hall", presence)).toEqual(["eli"]);
  expect(occupantsForSprite("library", presence)).toEqual([]);
});

test("an unknown sprite id has no occupants (never throws)", () => {
  expect(occupantsForSprite("nope", { hall_main: ["eli"] })).toEqual([]);
});

// Guards against this class of bug: a place folded into
// a sprite (gate_machine → Bridge) showed on the map but was invisible to
// every other surface, because each one carried its own single-place map.
// PUBLIC_SPRITE_TO_PLACE must be DERIVED from PUBLIC_PLACES so the primary
// place and the full set can never disagree again.

test("PUBLIC_SPRITE_TO_PLACE is derived from PUBLIC_PLACES, primary place first", () => {
  for (const sprite of COMMON_ROOM_SPRITES) {
    const places = PUBLIC_PLACES[sprite.id];
    expect(places).toBeDefined();
    expect(PUBLIC_SPRITE_TO_PLACE[sprite.id]).toBe(places[0]);
  }
});

test("every place a sprite stands for is in the shared place list (and vice versa)", () => {
  expect([...ALL_PUBLIC_PLACE_IDS].sort()).toEqual([...new Set(Object.values(PUBLIC_PLACES).flat())].sort());
  expect(ALL_PUBLIC_PLACE_IDS).toContain("gate_machine");
});

test("placesForSprite returns the whole set — the Bridge includes the Machine Gate", () => {
  expect(placesForSprite("bridge")).toEqual(["gate_world", "gate_machine"]);
  expect(placesForSprite("hall")).toEqual(["hall_main"]);
  expect(placesForSprite("nope")).toEqual([]);
});
