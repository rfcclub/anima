import { MAP_HEIGHT, MAP_WIDTH, type MapRect } from "./map-geometry";
import type { MapSprite } from "./map-sprites";
import { placeLabel } from "./place-labels";
import type { PresenceMap } from "./use-presence";

/** Tokens drawn beside a building before the rest collapse into "+N". */
export const MAX_TOKENS = 3;

export interface HotspotToken {
  agentId: string;
  role: "owner" | "guest";
}

export interface HotspotView {
  tokens: HotspotToken[];
  more: number;
  /** Chamber whose owner is in it: window light. */
  home: boolean;
  /** Chamber with nobody in it: darker veil. */
  away: boolean;
  /** Someone inside is in a meeting, a pulse-anima stage or a session. */
  talking: boolean;
  /** One line for the nameplate. */
  status: string;
  /** Accessible name of the hotspot button. */
  label: string;
}

export interface HotspotInput {
  sprite: MapSprite;
  /** Agents at this place now. */
  occupants: string[];
  /** Chambers only: the agent whose room this is. */
  ownerId?: string;
  /** Chambers only: where the owner is when not here. */
  ownerPlaceId?: string | null;
  activities?: Record<string, string | null>;
}

const TALKING = /^(meeting|pulse|session):/;

const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

function list(ids: string[]): string {
  const names = ids.map(cap);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What the people here are doing, as a sentence ("In a meeting."), from their
 *  presence activities; empty when nobody is in a meeting, pulse or session. */
function activitySentence(occupants: string[], activities: Record<string, string | null>): string {
  const phrases = new Set<string>();
  for (const a of occupants) {
    const activity = activities[a] ?? "";
    const [kind, detail] = activity.split(":");
    if (kind === "meeting") phrases.add("in a meeting");
    else if (kind === "pulse") phrases.add(detail ? `running pulse-anima (${detail})` : "running pulse-anima");
    else if (kind === "session") phrases.add(detail ? `in session ${detail}` : "in a session");
  }
  const text = [...phrases].join(", ");
  return text ? ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.` : "";
}

function statusOf(input: HotspotInput, guests: string[], ownerHome: boolean): string {
  const { ownerId, occupants, ownerPlaceId } = input;
  if (!ownerId) return occupants.length === 0 ? "Nobody here yet." : `${list(occupants)} ${occupants.length === 1 ? "is" : "are"} here.`;
  if (ownerHome) return guests.length === 0 ? `${cap(ownerId)} is home.` : `${cap(ownerId)} and ${list(guests)} are in the room.`;
  const owner = ownerPlaceId ? `${cap(ownerId)} is at ${placeLabel(ownerPlaceId)}` : `${cap(ownerId)} is away`;
  return guests.length > 0 ? `${owner} · ${list(guests)} ${guests.length === 1 ? "is" : "are"} visiting.` : `${owner}.`;
}

/** Everything a map hotspot shows, derived from presence. */
export function hotspotView(input: HotspotInput): HotspotView {
  const { sprite, occupants, ownerId, activities = {} } = input;
  const ownerHome = ownerId !== undefined && occupants.includes(ownerId);
  const guests = ownerId ? occupants.filter((a) => a !== ownerId) : occupants;
  const all: HotspotToken[] = [
    ...(ownerHome ? [{ agentId: ownerId!, role: "owner" as const }] : []),
    ...guests.map((agentId) => ({ agentId, role: "guest" as const })),
  ];
  const status = statusOf(input, guests, ownerHome) + activitySentence(occupants, activities);
  return {
    tokens: all.slice(0, MAX_TOKENS),
    more: Math.max(0, all.length - MAX_TOKENS),
    home: ownerHome,
    away: ownerId !== undefined && occupants.length === 0,
    talking: occupants.some((a) => TALKING.test(activities[a] ?? "")),
    status,
    label: `${sprite.label}, ${sprite.desc}. ${status}`,
  };
}

const EDGE = 16;
const GAP = 24;

/** Top-left of a nameplate of `size` beside `rect`: to the right when it fits,
 *  else to the left, kept inside the map vertically. Canvas units. */
export function nameplatePosition(rect: MapRect, size: { width: number; height: number }): { left: number; top: number } {
  const right = rect.left + rect.width + GAP;
  const left = right + size.width <= MAP_WIDTH - EDGE ? right : rect.left - GAP - size.width;
  const top = Math.min(Math.max(rect.top, EDGE), MAP_HEIGHT - size.height - EDGE);
  return { left, top };
}

/** The place an agent is in, or null when presence does not list them. */
export function placeOfAgent(presence: PresenceMap, agentId: string): string | null {
  for (const [placeId, agents] of Object.entries(presence)) {
    if (agents.includes(agentId)) return placeId;
  }
  return null;
}

/** Which building the pointer is over and which one has keyboard focus. They
 *  are kept apart so leaving a hovered building returns the light to the
 *  focused one instead of turning it off. */
export interface HotspotFocus {
  hover: string | null;
  focus: string | null;
}

export type HotspotFocusEvent =
  | { type: "enter" | "leave" | "focus" | "blur"; id: string };

export function nextHotspotFocus(state: HotspotFocus, event: HotspotFocusEvent): HotspotFocus {
  switch (event.type) {
    case "enter": return { ...state, hover: event.id };
    case "leave": return state.hover === event.id ? { ...state, hover: null } : state;
    case "focus": return { ...state, focus: event.id };
    case "blur": return state.focus === event.id ? { ...state, focus: null } : state;
  }
}

/** The building to light: the hovered one, else the focused one. */
export function activeHotspotId(state: HotspotFocus): string | null {
  return state.hover ?? state.focus;
}
