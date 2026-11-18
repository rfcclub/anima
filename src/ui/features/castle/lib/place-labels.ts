import { COMMON_ROOM_SPRITES, type MapSprite } from "./map-sprites";
import { WEST_WING_CHAMBERS } from "./west-wing-chambers";
import { EAST_WING_CHAMBERS } from "./east-wing-chambers";
import { PUBLIC_PLACES } from "./public-places";

// Map sprite id → its PRIMARY presence placeId. Derived from PUBLIC_PLACES
// (the full sprite → places map the map badges and the room pages share) so
// the two can never disagree again: thrice now, a place folded into a sprite
// (gate_machine → Bridge) was visible on the map and invisible everywhere
// that kept a second, single-place copy of this map — the room page, its log
// scope, the room-scene dispatcher. First entry is primary by convention:
// scene key, background asset name, and log default.
//
// The places table uses hall_main/workshop/garden/gate_world for four of
// these; library/observatory use their own sprite id directly. Kept here
// (not in RegionLabels) so placeLabel() can resolve both directions without
// importing a component.
export const PUBLIC_SPRITE_TO_PLACE: Record<string, string> = Object.fromEntries(
  Object.entries(PUBLIC_PLACES).map(([spriteId, placeIds]) => [spriteId, placeIds[0]]),
);

const ALL_CHAMBERS: MapSprite[] = [...WEST_WING_CHAMBERS, ...EAST_WING_CHAMBERS];

// placeId → human label, built once from sprite data so the room screen and
// the map can never disagree. chamber_<agent> resolves via the chamber
// sprite whose .id === <agent>; public places resolve via the inverse map
// above. Unknown placeIds return the raw id (never throws) so a missing
// label never breaks the room screen.
const PLACE_LABEL: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const c of ALL_CHAMBERS) {
    map[`chamber_${c.id}`] = c.label;
  }
  for (const [spriteId, placeId] of Object.entries(PUBLIC_SPRITE_TO_PLACE)) {
    const sprite = COMMON_ROOM_SPRITES.find((s) => s.id === spriteId);
    if (sprite) map[placeId] = sprite.label;
  }
  // Fallback for any future common-room sprite not yet in PUBLIC_SPRITE_TO_PLACE.
  for (const s of COMMON_ROOM_SPRITES) {
    if (!(s.id in map) && !Object.values(PUBLIC_SPRITE_TO_PLACE).includes(s.id)) {
      map[s.id] = s.label;
    }
  }
  return map;
})();

/** Resolve a presence placeId to a human-readable label.
 *  Unknown ids return the raw id — this is deliberate so a new placeId the
 *  map doesn't know about still surfaces as *something* rather than
 *  crashing the room banner. */
export function placeLabel(placeId: string): string {
  return PLACE_LABEL[placeId] ?? placeId;
}
