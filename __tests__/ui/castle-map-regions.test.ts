import { test, expect } from "bun:test";
import { MAP_REGIONS } from "../../src/ui/features/castle/lib/map-regions";

test("MAP_REGIONS has exactly 3 regions: common, west, east", () => {
  expect(MAP_REGIONS.map((r) => r.id).sort()).toEqual(["common", "east", "west"]);
});

test("each region has a label and a rect on the 1920x1080 map", () => {
  for (const r of MAP_REGIONS) {
    expect(r.label.length).toBeGreaterThan(0);
    expect(r.rect.left).toBeGreaterThanOrEqual(0);
    expect(r.rect.top).toBeGreaterThanOrEqual(0);
    expect(r.rect.width).toBeGreaterThan(0);
    expect(r.rect.height).toBeGreaterThan(0);
  }
});

test("regions do not overlap", () => {
  const overlaps = (a: (typeof MAP_REGIONS)[number], b: (typeof MAP_REGIONS)[number]) =>
    a.rect.left < b.rect.left + b.rect.width &&
    a.rect.left + a.rect.width > b.rect.left &&
    a.rect.top < b.rect.top + b.rect.height &&
    a.rect.top + a.rect.height > b.rect.top;

  for (let i = 0; i < MAP_REGIONS.length; i++) {
    for (let j = i + 1; j < MAP_REGIONS.length; j++) {
      expect(overlaps(MAP_REGIONS[i], MAP_REGIONS[j])).toBe(false);
    }
  }
});
