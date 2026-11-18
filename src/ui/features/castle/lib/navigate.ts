import { GameUnifier } from "@drincs/pixi-vn";

/**
 * Navigate from a click inside the Pixi'VN HTML layer. That layer is a
 * separate createRoot() with no router context, so navigation goes through
 * GameUnifier.navigate — the function Game.init registered from the outer
 * app's real router. Deferred past the current click's event/render cycle:
 * navigating synchronously unmounts the calling root from inside its own
 * click handler, which React reports as "unmount while already rendering".
 */
export function navigateAfterClick(path: string): void {
  setTimeout(() => GameUnifier.navigate(path), 0);
}
