/**
 * Shared Pixi'VN boot/clear helpers for the castle feature's pages
 * (MainScreen, WestWingScreen, ...). The canvas owns visuals-only
 * background; every UI element is a React component rendered into the
 * HTML layer, not a Pixi sprite (Pixi'VN
 * has no UI widgets, so UI must be React, not canvas primitives).
 * Each page boots exactly once per mount; the caller must call
 * clearStage() on unmount so Pixi'VN's module-level state never leaks
 * across React mount/unmount cycles.
 */
import { canvas, Game } from "@drincs/pixi-vn";

import { MAP_HEIGHT, MAP_WIDTH } from "../lib/map-geometry";

export { MAP_WIDTH, MAP_HEIGHT };
export const UI_LAYER_ID = "castle-page-ui";

/**
 * Boot Pixi'VN into `canvasHost` and add `uiHost` as the HTML overlay layer.
 * `navigate` is registered with Game.init's own navigate slot (GameUnifier.navigate)
 * so UI rendered inside the detached HTML-layer React root — which has no
 * access to the outer app's router context — can still trigger real SPA
 * navigation, the Pixi'VN way (GameUnifier.navigate(path)) instead of a
 * plain window.location hack.
 */
export async function bootStage(
  canvasHost: HTMLElement,
  uiHost: HTMLElement,
  navigate: (path: string) => void,
): Promise<HTMLDivElement> {
  await Game.init(canvasHost, {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    backgroundColor: "#1a1410",
    // Transparent clear: on the grounds screens, CastleBackground's <img>
    // sits behind this canvas (z-index 0) — an opaque canvas paints over it
    // everywhere the canvas doesn't draw a sprite, hiding a custom uploaded
    // background entirely. Room screens are unaffected: renderRoomBackground()
    // draws its own full-canvas sprite as the first thing on the canvas, so
    // it covers 100% of the transparent area regardless.
    backgroundAlpha: 0,
    resizeMode: "contain",
    navigate,
  });

  return canvas.addHtmlLayer(UI_LAYER_ID, uiHost);
}

export function clearStage(): void {
  Game.clear();
}
