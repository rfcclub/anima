import type { PresenceMap } from "./use-presence";

// Map sprite id → the presence placeIds it stands for. Sprite ids don't all
// match placeIds 1:1: the places table uses hall_main/garden/workshop/gate_*
// for four of them, while library and observatory use their own sprite id.
//
// The Bridge covers BOTH gates. gate_machine has no marker of its own on
// castle_common.png, yet agents wander there — so it folds into Bridge
// ("External · Connect") instead of staying invisible.
export const PUBLIC_PLACES: Record<string, string[]> = {
  hall: ["hall_main"],
  forge: ["workshop"],
  bodega: ["garden"],
  bridge: ["gate_world", "gate_machine"],
  library: ["library"],
  observatory: ["observatory"],
};

/** Everyone currently present at any place the sprite stands for. */
export function occupantsForSprite(spriteId: string, presence: PresenceMap): string[] {
  return (PUBLIC_PLACES[spriteId] ?? []).flatMap((placeId) => presence[placeId] ?? []);
}

/** Every place id a sprite stands for, in mapping order. The first entry is
 *  the sprite's primary place (scene key, background asset, log default) —
 *  see PUBLIC_SPRITE_TO_PLACE in place-labels.ts, which is derived from
 *  PUBLIC_PLACES[0] rather than maintained as a second, driftable map. */
export function placesForSprite(spriteId: string): string[] {
  return PUBLIC_PLACES[spriteId] ?? [];
}

/** Flat list of every place any public map marker stands for — for consumers
 *  that need the full set rather than a per-sprite lookup (the room-scene
 *  dispatcher, which must generate a scene for gate_machine too, not just the
 *  gate_world it used to get from PUBLIC_SPRITE_TO_PLACE's single value). */
export const ALL_PUBLIC_PLACE_IDS: string[] = [...new Set(Object.values(PUBLIC_PLACES).flat())];
