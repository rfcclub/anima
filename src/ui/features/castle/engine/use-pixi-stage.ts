import { useEffect, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootStage, clearStage } from "./pixi-stage";

/**
 * Boots the shared Pixi'VN stage into a ref'd canvas host, mounts `ui`
 * into the HTML overlay layer, and tears both down on unmount. Shared by
 * every castle page (MainScreen, WestWingScreen, RoomScreen, ...) so
 * boot/cleanup discipline (Game.clear() on unmount) isn't duplicated per
 * page.
 *
 * Boot (Game.init/addHtmlLayer) runs once, on mount. Re-rendering `ui` is a
 * separate effect keyed on `ui` itself: pages with static content
 * (MainScreen's region cards) only ever pass one `ui` value, so that effect
 * fires once too — but pages with content that changes over time (RoomScreen's
 * chat log/bubble) need the nested root's render() called again each time
 * `ui` changes, or the HTML layer would freeze at whatever it looked like
 * on first mount.
 *
 * `onBooted`, if given, fires once real Pixi'VN boot (Game.init) has
 * resolved — pages with their own separate canvas-drawing effect (e.g.
 * RoomScreen's initial renderRoomBackground/renderRoomCharacters, which
 * fires on `[agentId]` independently of this hook) need this to gate that
 * effect: calling `canvas.add(...)` before Game.init resolves throws, since
 * `canvas` isn't initialized yet — the same race is guarded
 * for the portrait-breathing ticker (room-stage.ts).
 */
export function usePixiStage(
  ui: ReactElement,
  navigate: (path: string) => void,
  onBooted?: () => void,
) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const uiHostRef = useRef<HTMLDivElement>(null);
  const uiRootRef = useRef<Root | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    const canvasHost = canvasHostRef.current;
    const uiHost = uiHostRef.current;
    if (!canvasHost || !uiHost) return;

    let cancelled = false;

    (async () => {
      const htmlLayer = await bootStage(canvasHost, uiHost, navigate);
      if (cancelled) {
        clearStage();
        return;
      }
      uiRootRef.current = createRoot(htmlLayer);
      setBooted(true);
      onBooted?.();
    })();

    return () => {
      cancelled = true;
      // Deferred: unmounting this nested root synchronously, inside React's
      // own commit phase for the outer tree (which is what triggers this
      // cleanup), makes React warn "unmount a root while already rendering".
      // Escaping to a macrotask lets the outer unmount commit finish first.
      const rootToUnmount = uiRootRef.current;
      setTimeout(() => rootToUnmount?.unmount(), 0);
      clearStage();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (booted) uiRootRef.current?.render(ui);
  }, [ui, booted]);

  return { canvasHostRef, uiHostRef };
}
