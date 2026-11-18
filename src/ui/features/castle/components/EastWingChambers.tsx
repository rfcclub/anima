import { EAST_WING_CHAMBERS } from "../lib/east-wing-chambers";
import { MapHotspotLayer } from "./MapHotspotLayer";
import { CastleNav } from "./CastleNav";
import { navigateAfterClick } from "../lib/navigate";
import { usePresenceWithActivity } from "../lib/use-presence";

/** East Wing's 8 chambers as lantern hotspots, same as WestWingChambers.
 *  Clicking a chamber navigates to /rooms/<agent> via navigateAfterClick (the
 *  HTML layer has no router context, so useNavigate would fail). */
export function EastWingChambers() {
  const { presence, activityByAgent } = usePresenceWithActivity();
  return (
    <div className="absolute inset-0 pointer-events-none" data-testid="east-wing-chambers">
      <MapHotspotLayer
        attr="data-chamber"
        presence={presence}
        activities={activityByAgent}
        items={EAST_WING_CHAMBERS.map((chamber) => ({
          sprite: chamber,
          ownerId: chamber.id,
          placeIds: [`chamber_${chamber.id}`],
          onClick: () => navigateAfterClick(`/rooms/${chamber.id}`),
        }))}
      />
      {/* After the hotspots, so the hover veil never dims the way out. */}
      <CastleNav showBackToCentral={true} />
    </div>
  );
}
