import { test, expect } from "bun:test";
import { WEST_WING_CHAMBERS } from "../../src/ui/features/castle/lib/west-wing-chambers";
import { MAP_WIDTH, MAP_HEIGHT } from "../../src/ui/features/castle/engine/pixi-stage";

function overlaps(a: { left: number; top: number; width: number; height: number }, b: typeof a): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

test("WEST_WING_CHAMBERS has exactly the 8 west wing agents", () => {
  expect(WEST_WING_CHAMBERS.map((c) => c.id).sort()).toEqual(
    ["abel", "bruno", "cleo", "eli", "finn", "lena", "milo", "sam"].sort(),
  );
});

test("each chamber sits fully inside the 1920x1080 canvas", () => {
  for (const c of WEST_WING_CHAMBERS) {
    expect(c.rect.left).toBeGreaterThanOrEqual(0);
    expect(c.rect.top).toBeGreaterThanOrEqual(0);
    expect(c.rect.left + c.rect.width).toBeLessThanOrEqual(MAP_WIDTH);
    expect(c.rect.top + c.rect.height).toBeLessThanOrEqual(MAP_HEIGHT);
  }
});

test("chambers do not overlap each other", () => {
  for (let i = 0; i < WEST_WING_CHAMBERS.length; i++) {
    for (let j = i + 1; j < WEST_WING_CHAMBERS.length; j++) {
      expect(overlaps(WEST_WING_CHAMBERS[i].rect, WEST_WING_CHAMBERS[j].rect)).toBe(false);
    }
  }
});
