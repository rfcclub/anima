import { useNavigate } from "react-router-dom";
import { usePixiStage } from "../engine/use-pixi-stage";
import { EastWingChambers } from "../components/EastWingChambers";
import { CastleBackground } from "../components/CastleBackground";

/**
 * EastWingScreen — same Pixi'VN hosting pattern as MainScreen/WestWingScreen
 * (canvas renders background only, React renders the 8 chamber cards via
 * the HTML layer).
 */
export function EastWingScreen() {
  const navigate = useNavigate();
  const { canvasHostRef, uiHostRef } = usePixiStage(<EastWingChambers />, navigate);

  return (
    <div className="relative w-full h-screen bg-castle-bg" data-testid="east-wing-screen">
      <CastleBackground sceneId="castle_east" />
      <div ref={canvasHostRef} className="absolute inset-0" />
      <div ref={uiHostRef} className="absolute inset-0" />
    </div>
  );
}
