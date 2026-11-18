import { useEffect, useState } from "react";
import { backgroundUrl } from "../../../lib/vn-assets";

/** Full-screen background image for a castle screen, rendered as a plain
 *  HTML <img> (not a Pixi sprite — porting assets through Pixi is not
 *  needed for a static backdrop). Sits behind the canvas host + UI overlay layers. If no asset
 *  exists for `sceneId`, the API 404s and we render nothing — the page's
 *  base `bg-castle-bg` shows through. Upload `castle_common.png`,
 *  `castle_west.png`, `castle_east.png` via /vn-assets to fill them. */
export function CastleBackground({ sceneId }: { sceneId: string }) {
  const [exists, setExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(backgroundUrl(sceneId), { method: "HEAD" })
      .then((r) => !cancelled && setExists(r.ok))
      .catch(() => !cancelled && setExists(false));
    return () => {
      cancelled = true;
    };
  }, [sceneId]);

  if (!exists) return null;
  return (
    <img
      src={backgroundUrl(sceneId)}
      alt=""
      className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      style={{ zIndex: 0 }}
      data-testid={`castle-bg-${sceneId}`}
    />
  );
}
