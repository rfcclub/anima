export interface MapRegion {
  id: "common" | "west" | "east";
  label: string;
  rect: { left: number; top: number; width: number; height: number };
}

// Layout on the 1920x1080 map canvas: common rooms centered, west/east wings
// flanking it. Non-overlapping by construction — verified in tests.
export const MAP_REGIONS: MapRegion[] = [
  { id: "west", label: "West Wing", rect: { left: 0, top: 0, width: 620, height: 1080 } },
  { id: "common", label: "Common Rooms", rect: { left: 620, top: 0, width: 680, height: 1080 } },
  { id: "east", label: "East Wing", rect: { left: 1300, top: 0, width: 620, height: 1080 } },
];
