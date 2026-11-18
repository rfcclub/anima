import { WEST_WING_CHAMBERS } from "../lib/west-wing-chambers";
import { MapHotspotLayer } from "./MapHotspotLayer";
import { CastleNav } from "./CastleNav";
import { navigateAfterClick } from "../lib/navigate";
import { usePresenceWithActivity } from "../lib/use-presence";

/** West Wing's 8 chambers as lantern hotspots over the painted houses, in the
 *  Pixi'VN HTML layer. Clicking a chamber navigates to /rooms/<agent> (chamber.id
 *  is the agent id) through navigateAfterClick → GameUnifier.navigate, because
 *  the HTML layer is a separate createRoot() with no router context.
 *
 *  Presence: window light when the owner is home, portrait tokens for who is
 *  inside, a darker veil when the chamber is empty. */
export function WestWingChambers() {
  const { presence, activityByAgent } = usePresenceWithActivity();
  return (
    <div className="absolute inset-0 pointer-events-none" data-testid="west-wing-chambers">
      <MapHotspotLayer
        attr="data-chamber"
        presence={presence}
        activities={activityByAgent}
        items={WEST_WING_CHAMBERS.map((chamber) => ({
          sprite: chamber,
          ownerId: chamber.id,
          placeIds: [`chamber_${chamber.id}`],
          onClick: () => navigateAfterClick(`/rooms/${chamber.id}`),
        }))}
      />
      {/* After the hotspots, so the hover veil never dims the way out. */}
      {/* West Wing sits west of Castle — back-to-central points east (right). */}
      <CastleNav showBackToCentral={true} centralSide="right" />
    </div>
  );
}
