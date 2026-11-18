/** Logical size of every castle map and room stage, in canvas units. Map
 *  rects (map-sprites.ts, *-wing-chambers.ts) are measured in these units. */
export const MAP_WIDTH = 1920;
export const MAP_HEIGHT = 1080;

export interface MapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A canvas-unit rect as CSS percentages of the map. */
export function pct(rect: MapRect) {
  return {
    left: `${(rect.left / MAP_WIDTH) * 100}%`,
    top: `${(rect.top / MAP_HEIGHT) * 100}%`,
    width: `${(rect.width / MAP_WIDTH) * 100}%`,
    height: `${(rect.height / MAP_HEIGHT) * 100}%`,
  };
}
