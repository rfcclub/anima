/** Where the room stage puts portraits, in canvas units. One source for the Pixi stage
 *  (engine/room-stage.ts) and for the chat bubbles that must stay clear of the faces. */
export const CANVAS_W = 1920;
export const CANVAS_H = 1080;

/** Owner portrait's centre x as a fraction of the canvas width: with a height factor of 0.62 the
 *  sprite is ~502 px wide, so 0.13 keeps its left edge on screen. */
export const OWNER_PORTRAIT_XALIGN = 0.13;
/** Portraits stand on the bottom edge of the canvas. */
export const OWNER_PORTRAIT_YFACTOR = 1.0;
/** Portrait height as a fraction of the canvas height. */
export const OWNER_PORTRAIT_HEIGHT_FACTOR = 0.62;
/** Each next portrait's centre sits this fraction of the previous width to the right. */
export const PORTRAIT_CHAIN = 0.82;
/** Width over height of a portrait texture (768 x 1024). The real width follows the texture. */
export const PORTRAIT_ASPECT = 0.75;

export interface PortraitRect {
  /** Centre x. */
  cx: number;
  width: number;
  /** y of the top of the portrait. */
  headTop: number;
}

/** Portrait positions for `count` agents in stage order, assuming the standard aspect ratio. */
export function portraitRects(count: number, firstXAlign: number = OWNER_PORTRAIT_XALIGN): PortraitRect[] {
  const height = CANVAS_H * OWNER_PORTRAIT_HEIGHT_FACTOR;
  const width = height * PORTRAIT_ASPECT;
  const headTop = CANVAS_H * OWNER_PORTRAIT_YFACTOR - height;
  const rects: PortraitRect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({ cx: i === 0 ? CANVAS_W * firstXAlign : rects[i - 1]!.cx + PORTRAIT_CHAIN * width, width, headTop });
  }
  return rects;
}
