export interface MapSprite {
  id: string;
  label: string;
  desc: string;
  icon: string;
  color: string;
  rect: { left: number; top: number; width: number; height: number };
}

// Positions AND sizes are read directly off castle_common.png (1920x1080,
// the actual background asset — see CastleBackground.tsx), not a generic
// grid of uniform squares. The artwork places buildings around a courtyard
// at different footprints, so each rect is sized to that building's real
// silhouette and centered on it. Requirement: the marker
// matches the architecture — a fixed 180x180 square either spilled past a
// smaller building or clipped a wider one. Re-measure by re-cropping
// castle_common.png with a pixel grid overlay if the asset is ever replaced.
function centered(cx: number, cy: number, width: number, height: number): { left: number; top: number; width: number; height: number } {
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}

export const COMMON_ROOM_SPRITES: MapSprite[] = [
  { id: "hall", label: "Town Hall", desc: "Meeting · Colony", icon: "🏛️", color: "#ffd700", rect: centered(490, 210, 300, 230) },
  { id: "library", label: "Library", desc: "Knowledge · Code", icon: "📚", color: "#00d2ff", rect: centered(1435, 195, 290, 230) },
  { id: "observatory", label: "Observatory", desc: "Philosophy · Analysis", icon: "🔭", color: "#bb86fc", rect: centered(860, 545, 280, 300) },
  { id: "forge", label: "Forge", desc: "Build · Craft", icon: "⚒️", color: "#f0883e", rect: centered(1135, 545, 230, 240) },
  { id: "bodega", label: "Bodega", desc: "Hangout · Rest", icon: "🍹", color: "#3fb950", rect: centered(410, 740, 300, 290) },
  { id: "bridge", label: "Bridge", desc: "External · Connect", icon: "🌉", color: "#8b949e", rect: centered(1650, 790, 260, 260) },
];

// One marker per wing, sized to the gate door itself (not the label text
// above it — labels are the art's, cards no longer render their own since
// showLabel={false} in RegionLabels.tsx).
export const WING_SPRITES: MapSprite[] = [
  { id: "west-wing", label: "West Wing", desc: "8 Chambers", icon: "🚪", color: "#9c7a4a", rect: centered(150, 530, 200, 260) },
  { id: "east-wing", label: "East Wing", desc: "8 Chambers", icon: "🚪", color: "#9c7a4a", rect: centered(1790, 530, 200, 260) },
];
