import { useNavigate } from "react-router-dom";
import { usePixiStage } from "../engine/use-pixi-stage";
import { WestWingChambers } from "../components/WestWingChambers";
import { CastleBackground } from "../components/CastleBackground";

/**
 * WestWingScreen — same Pixi'VN hosting pattern as MainScreen (canvas
 * renders background only, React renders the 8 chamber cards via the
 * HTML layer).
 */
export function WestWingScreen() {
  const navigate = useNavigate();
  const { canvasHostRef, uiHostRef } = usePixiStage(<WestWingChambers />, navigate);

  return (
    <div className="relative w-full h-screen bg-castle-bg" data-testid="west-wing-screen">
      <CastleBackground sceneId="castle_west" />
      <div ref={canvasHostRef} className="absolute inset-0" />
      <div ref={uiHostRef} className="absolute inset-0" />
    </div>
  );
}
