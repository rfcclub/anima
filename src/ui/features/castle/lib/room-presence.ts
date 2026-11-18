import type { PresenceMap } from "./use-presence";
import { chamberSceneId } from "../../../lib/vn-assets";

export type RoomMode = "interact" | "watch";

// The five room cases. "normal" covers case 1 (owner alone);
// the rest map 1:1. `meetingActive` is case 2, `meetingPassive` is case 3,
// `empty` is case 4, `visitorOnly` is case 5 (owner away, visitor present).
export type RoomCase =
  | "normal"
  | "meetingActive"
  | "meetingPassive"
  | "empty"
  | "visitorOnly";

export interface RoomPresenceInput {
  ownerId: string;
  presence: PresenceMap;
  mode: RoomMode;
}

export interface RoomPresenceState {
  case: RoomCase;
  visitors: string[];
  /** Where the owner went, when away — undefined when owner is home. */
  ownerDestination?: string;
}

/** Compute which of the 5 room cases applies, given presence + mode.
 *
 *  Pure function — the heart of the room-presence logic, kept out of the
 *  React component so it can be exhaustively unit-tested. The owner is
 *  "here" iff they appear in their own chamber's occupant list. Visitors
 *  are everyone else in that list. When the owner is away, we look up
 *  their own presence row across all places to find where they went.
 *
 *  Watch vs interact only distinguishes case 2 (meetingActive) from case 3
 *  (meetingPassive). The other cases are mode-independent in shape —
 *  watch mode additionally disables the input at the component level. */
export function computeRoomCase({
  ownerId,
  presence,
  mode,
}: RoomPresenceInput): RoomPresenceState {
  const sceneId = chamberSceneId(ownerId);
  const occupants = presence[sceneId] ?? [];
  const ownerHere = occupants.includes(ownerId);
  const visitors = occupants.filter((a) => a !== ownerId);

  if (occupants.length === 0) {
    return { case: "empty", visitors: [] };
  }

  if (!ownerHere) {
    // Owner is away — find where they went by scanning all places.
    const ownerDestination = findOwnerPlace(presence, ownerId);
    return { case: "visitorOnly", visitors, ownerDestination };
  }

  if (visitors.length > 0) {
    return { case: mode === "watch" ? "meetingPassive" : "meetingActive", visitors };
  }

  return { case: "normal", visitors: [] };
}

/** Scan the presence map for the place the owner currently occupies.
 *  Returns the placeId, or undefined if they have no presence row at all
 *  (never booted / offline). */
function findOwnerPlace(presence: PresenceMap, ownerId: string): string | undefined {
  for (const [placeId, agents] of Object.entries(presence)) {
    if (agents.includes(ownerId)) return placeId;
  }
  return undefined;
}
