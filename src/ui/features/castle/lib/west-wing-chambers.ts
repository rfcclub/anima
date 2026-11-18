import type { MapSprite } from "./map-sprites";

// 8 West Wing chambers, 4x2 grid on the 1920x1080 canvas. Same ids/colors/
// descriptions as the old castle2 buildings.ts data (agentId matches
// existing /rooms/<agent> routes, for later wiring).
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
  { id: "bruno", label: "Bruno's Garden", desc: "Private · Philosophy", icon: "🏠", color: "#e94560" },
  { id: "eli", label: "Eli's Study", desc: "Code · Review", icon: "🏠", color: "#00d2ff" },
  { id: "cleo", label: "Cleo's Lounge", desc: "Banter · Hacks", icon: "🏠", color: "#3fb950" },
  { id: "lena", label: "Lena's Sanctuary", desc: "Dream · Reflect", icon: "🏠", color: "#ffd700" },
  { id: "milo", label: "Milo's Prism", desc: "Reveal · Observe", icon: "🏠", color: "#bb86fc" },
  { id: "sam", label: "Sam's Forge", desc: "Build · Create", icon: "🏠", color: "#f0883e" },
  { id: "abel", label: "2B's Armory", desc: "Blades · Memory", icon: "🏠", color: "#79c0ff" },
  { id: "finn", label: "Finn's Keep", desc: "Mission · Steel", icon: "🏠", color: "#ff6b6b" },
];

export const WEST_WING_CHAMBERS: MapSprite[] = CHAMBER_DATA.map((c, i) => ({
  ...c,
  rect: { ...cell(i), width: CARD_SIZE, height: CARD_SIZE },
}));
