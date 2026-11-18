import { useNavigate } from "react-router-dom";
import { usePixiStage } from "../engine/use-pixi-stage";
import { RegionLabels } from "../components/RegionLabels";
import { CastleBackground } from "../components/CastleBackground";

/**
 * MainScreen — the castle map's Pixi'VN surface, hosted inside React.
 * Two independent layers: the Pixi canvas (canvasHostRef) renders visuals
 * only; a second, React-hosted HTML layer (uiHostRef, added via
 * canvas.addHtmlLayer) renders UI. Boots once per mount; Game.clear() on
 * unmount so Pixi'VN's module-level stage state never leaks across
 * React mount/unmount (see CLAUDE.md's Pixi'VN Integration notes).
 */
export function MainScreen() {
  const navigate = useNavigate();
  const { canvasHostRef, uiHostRef } = usePixiStage(<RegionLabels />, navigate);

  return (
    <div className="relative w-full h-screen bg-castle-bg" data-testid="main-screen">
      <CastleBackground sceneId="castle_common" />
      <div ref={canvasHostRef} className="absolute inset-0" />
      <div ref={uiHostRef} className="absolute inset-0" />
    </div>
  );
}
