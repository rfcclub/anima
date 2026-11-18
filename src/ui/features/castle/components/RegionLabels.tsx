import { MAP_REGIONS } from "../lib/map-regions";
import { COMMON_ROOM_SPRITES, WING_SPRITES } from "../lib/map-sprites";
import { WEST_WING_CHAMBERS } from "../lib/west-wing-chambers";
import { EAST_WING_CHAMBERS } from "../lib/east-wing-chambers";
import { navigateAfterClick } from "../lib/navigate";
import { pct } from "../lib/map-geometry";
import { MapHotspotLayer } from "./MapHotspotLayer";
import { CastleNav } from "./CastleNav";
import { usePresenceWithActivity, type PresenceMap } from "../lib/use-presence";
import { placesForSprite } from "../lib/public-places";

const WING_ROUTE: Record<string, string> = {
  "west-wing": "/westwing",
  "east-wing": "/eastwing",
};

const WING_CHAMBERS: Record<string, { id: string }[]> = {
  "west-wing": WEST_WING_CHAMBERS,
  "east-wing": EAST_WING_CHAMBERS,
};

/** "3 at home" — how many owners of a wing's chambers are in them. */
function wingSummary(wingId: string, presence: PresenceMap): string {
  const home = (WING_CHAMBERS[wingId] ?? []).filter((c) => presence[`chamber_${c.id}`]?.includes(c.id)).length;
  return home === 0 ? "Nobody is home." : `${home} at home.`;
}

/**
 * The map's entire UI — regions, rooms, wing gates — rendered as React
 * components into the Pixi'VN HTML layer. This root is a separate
 * createRoot() detached from the app's router context (see use-pixi-stage.ts),
 * so navigation goes through GameUnifier.navigate — the function Game.init
 * registered from the outer app's real router — rather than react-router
 * hooks, which wouldn't resolve here. The canvas underneath renders only
 * the background; the painting carries each building and its name, so the
 * hotspots draw no box or label of their own (castle-lantern-hotspots).
 */
export function RegionLabels() {
  const { presence, activityByAgent } = usePresenceWithActivity();
  return (
    <div className="absolute inset-0 pointer-events-none" data-testid="region-labels">
      {MAP_REGIONS.map((r) => (
        <div
          key={r.id}
          data-region={r.id}
          className="absolute flex items-start justify-center pt-6 text-castle-cream tracking-[3px] text-[28px] font-semibold"
          style={pct(r.rect)}
        >
          {r.label}
        </div>
      ))}
      <MapHotspotLayer
        attr="data-room"
        presence={presence}
        activities={activityByAgent}
        items={[
          ...COMMON_ROOM_SPRITES.map((room) => ({
            sprite: room,
            placeIds: placesForSprite(room.id),
            onClick: () => navigateAfterClick(`/${room.id}`),
          })),
          ...WING_SPRITES.map((wing) => {
            const route = WING_ROUTE[wing.id];
            return {
              sprite: wing,
              attr: "data-wing",
              placeIds: [],
              summary: wingSummary(wing.id, presence),
              onClick: route ? () => navigateAfterClick(route) : undefined,
            };
          }),
        ]}
      />
      {/* After the hotspots, so the hover veil never dims the way out. */}
      <CastleNav showBackToCentral={false} />
    </div>
  );
}
