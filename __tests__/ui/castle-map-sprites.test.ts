import { test, expect } from "bun:test";
import { COMMON_ROOM_SPRITES, WING_SPRITES } from "../../src/ui/features/castle/lib/map-sprites";
import { MAP_WIDTH, MAP_HEIGHT } from "../../src/ui/features/castle/engine/pixi-stage";

function within(inner: { left: number; top: number; width: number; height: number }, outer: typeof inner): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

function overlaps(a: { left: number; top: number; width: number; height: number }, b: typeof a): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

test("COMMON_ROOM_SPRITES has exactly the 6 public rooms", () => {
  expect(COMMON_ROOM_SPRITES.map((s) => s.id).sort()).toEqual(
    ["bodega", "bridge", "forge", "hall", "library", "observatory"].sort(),
  );
});

// Sprites are positioned on castle_common.png's actual courtyard layout
// (buildings ringing the edges), not a west/common/east 3-strip abstraction
// — see map-sprites.ts. Containment is against the full map canvas instead.
test("every common room and wing sprite sits fully inside the map canvas", () => {
  const canvas = { left: 0, top: 0, width: MAP_WIDTH, height: MAP_HEIGHT };
  for (const s of [...COMMON_ROOM_SPRITES, ...WING_SPRITES]) {
    expect(within(s.rect, canvas)).toBe(true);
  }
});

test("common room sprites do not overlap each other", () => {
  for (let i = 0; i < COMMON_ROOM_SPRITES.length; i++) {
    for (let j = i + 1; j < COMMON_ROOM_SPRITES.length; j++) {
      expect(overlaps(COMMON_ROOM_SPRITES[i].rect, COMMON_ROOM_SPRITES[j].rect)).toBe(false);
    }
  }
});

test("WING_SPRITES has exactly one sprite for west and one for east", () => {
  expect(WING_SPRITES.map((s) => s.id).sort()).toEqual(["east-wing", "west-wing"]);
});

test("wing sprites do not overlap each other or any common room sprite", () => {
  const [west, east] = WING_SPRITES;
  expect(overlaps(west.rect, east.rect)).toBe(false);
  for (const s of COMMON_ROOM_SPRITES) {
    expect(overlaps(west.rect, s.rect)).toBe(false);
    expect(overlaps(east.rect, s.rect)).toBe(false);
  }
});
