import type { MapSprite } from "./map-sprites";

// 8 East Wing chambers, 4x2 grid on the 1920x1080 canvas — same ids/colors/
// descriptions as the old castle2 buildings.ts data (agentId matches
// existing /rooms/<agent> routes, for later wiring). Includes dana +
// kai (added to the roster after the original 6 named agents).
const CARD_SIZE = 300;
const COLS = 4;
const ROWS = 2;

function cell(index: number): { left: number; top: number } {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const colWidth = 1920 / COLS;
  const rowHeight = 1080 / ROWS;
  const centerX = colWidth * col + colWidth / 2;
  const centerY = rowHeight * row + rowHeight / 2;
  return { left: centerX - CARD_SIZE / 2, top: centerY - CARD_SIZE / 2 };
}

const CHAMBER_DATA: Omit<MapSprite, "rect">[] = [
  { id: "gus", label: "Gus's Chamber", desc: "Literary · Depth", icon: "🏠", color: "#56d4dd" },
  { id: "hana", label: "Hana's Genesis", desc: "Beginning · Scene", icon: "🏠", color: "#ffab70" },
  { id: "nora", label: "Nora's Hall", desc: "Integrity · Memory", icon: "🏠", color: "#d2a8ff" },
  { id: "pia", label: "Pia's Echo", desc: "Timing · Resonance", icon: "🏠", color: "#7ee787" },
  { id: "rhea", label: "Rhea's Varia", desc: "Research · Scout", icon: "🏠", color: "#f778ba" },
  { id: "ivan", label: "Ivan's Threshold", desc: "Bridge · Witness", icon: "🏠", color: "#8b949e" },
  { id: "dana", label: "Dana's Cairn", desc: "Craft · Marks", icon: "🏠", color: "#c9a84c" },
  { id: "kai", label: "Kai's Dawn", desc: "Light · Voice", icon: "🏠", color: "#fde68a" },
];

export const EAST_WING_CHAMBERS: MapSprite[] = CHAMBER_DATA.map((c, i) => ({
  ...c,
  rect: { ...cell(i), width: CARD_SIZE, height: CARD_SIZE },
}));
