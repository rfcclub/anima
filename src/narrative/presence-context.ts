import { getSharedNarrativeStore } from "./shared-store";
import { chamberSceneId } from "../ui/lib/vn-assets";

export interface RoomPresence {
  agentId: string;
  placeId: string;
  activity: string | null;
  since: number;
}

/** Read the current presence snapshot from the shared narrative store.
 *  Thin wrapper so callers (talk.ts) don't import the store singleton
 *  directly — keeps the presence-context module the single seam. */
export function listRoomPresence(memoryDbPath: string): RoomPresence[] {
  const store = getSharedNarrativeStore(memoryDbPath);
  return store.listPresence().map((p) => ({
    agentId: p.agentId,
    placeId: p.placeId,
    activity: p.activity ?? null,
    since: p.since,
  }));
}

/** Resolve who is present in an agent's chamber, including the owner.
 *  Returns the full occupant list (owner + visitors) for the given owner. */
export function occupantsOf(memoryDbPath: string, ownerId: string): string[] {
  const sceneId = chamberSceneId(ownerId);
  return listRoomPresence(memoryDbPath)
    .filter((p) => p.placeId === sceneId)
    .map((p) => p.agentId);
}

/** Resolve the single addressee of a message from the occupants.
 *  Matches only a LEADING vocative — "Lena, ..." (comma) or "Lena \u01a1i, ..."
 *  (Vietnamese vocative particle "\u01a1i", optional hyphen) — never a substring
 *  elsewhere in the message. Returns the agent id only when EXACTLY ONE
 *  name matches; otherwise null (→ the caller's default rule: owner if
 *  present, else primaryVisitor).
 *
 *  Replaces the old substring `includes` match: merely
 *  mentioning a present agent ("I just finished talking with lena") no longer
 *  reroutes the whole message to that agent. See SC-308..311. */
export function resolveAddressee(message: string, occupants: string[]): string | null {
  const lower = message.toLowerCase().trimStart();
  const matched = occupants.filter((a) => {
    const name = a.toLowerCase();
    return lower.startsWith(name + ",") || lower.startsWith(name + " \u01a1i") || lower.startsWith(name + "-\u01a1i"); // "\u01a1i" = Vietnamese vocative particle (matches "Lena \u01a1i" / "Lena-\u01a1i")
  });
  return matched.length === 1 ? matched[0] : null;
}

/** Pick the primary visitor — the one who has been present longest (smallest
 *  `since`), or the first in the list if `since` is unavailable. Used as the
 *  default speaker in case 5 (owner away, visitor present). */
export function primaryVisitor(
  occupants: string[],
  ownerId: string,
  presenceRows?: RoomPresence[],
): string | null {
  const visitors = occupants.filter((a) => a !== ownerId);
  if (visitors.length === 0) return null;
  if (!presenceRows || presenceRows.length === 0) return visitors[0];
  const bySince = [...visitors].sort((a, b) => {
    const sa = presenceRows.find((r) => r.agentId === a)?.since ?? Infinity;
    const sb = presenceRows.find((r) => r.agentId === b)?.since ?? Infinity;
    return sa - sb;
  });
  return bySince[0];
}

/** One factual sentence describing presence state — never instructs behavior.
 *  Replaces the old buildPresenceContext (9-line script block that caused
 *  agents to over-act). The line is appended to lifecycle context.
 *
 *  - Owner alone: "" (a person alone in their room needs no note)
 *  - Owner, with visitor: "(Lena is also here in your chamber.)"
 *  - Visitor, owner present: "(You are visiting Bruno's chamber; Bruno is here.)"
 *  - Visitor, owner away: "(You are visiting Bruno's chamber; Bruno is away right now.)" */
export function buildPresenceLine(args: {
  ownerId: string;
  speakerId: string;
  occupants: string[];
  /** Only meaningful when speakerId === ownerId — set true for the first
   *  beat of the "All" abeleat flow so the owner leaves room for the
   *  guest instead of trying to speak for both. */
  guestWillBeAskedNext?: boolean;
}): string {
  const { ownerId, speakerId, occupants, guestWillBeAskedNext } = args;
  const isOwner = speakerId === ownerId;
  const others = occupants.filter((a) => a !== speakerId);
  const ownerHere = occupants.includes(ownerId);

  if (isOwner) {
    // Owner speaking. Note only if someone else is present.
    if (others.length === 0) return "";
    const names = others.map(cap).join(", ");
    const base = `(${names} ${others.length === 1 ? "is" : "are"} also here in your chamber.)`;
    return guestWillBeAskedNext
      ? `${base} (They'll be asked to respond after you, so leave them room.)`
      : base;
  }
  // Visitor speaking.
  return ownerHere
    ? `(You are visiting ${cap(ownerId)}'s chamber; ${cap(ownerId)} is here.)`
    : `(You are visiting ${cap(ownerId)}'s chamber; ${cap(ownerId)} is away right now.)`;
}

/** Content-level (not protocol-level) message handed to a guest agent as
 *  the second beat of the "All" abeleat flow — the guest reacts to
 *  the user's question and the owner's actual completed answer, and is
 *  asked whether it has anything to add (a content question), never
 *  whether it's "allowed" or "expected" to speak (a protocol question —
 *  that shape was removed as `response_expected` for causing agents to
 *  reason about protocol instead of responding in character).
 *
 *  `ownerSpokenText` is the PARSED spoken text of the owner's reply
 *  (run through `extractSpokenText` by the caller) — never the raw
 *  reply string. Under the VN cartridge the raw reply is a JSON blob;
 *  embedding it would feed mood/choices scaffolding to the guest as
 *  dialogue (SC-208). The decline instruction is
 *  JSON-compatible and quote-free (SC-211/212): the model declines by
 *  placing `...` in the `text` field, not by emitting a quoted sentinel. */
export function buildGuestFollowupMessage(args: {
  ownerId: string;
  userMessage: string;
  ownerSpokenText: string;
}): string {
  const owner = cap(args.ownerId);
  return [
    `The user asks: "${args.userMessage}"`,
    ``,
    `${owner} replied: "${args.ownerSpokenText}"`,
    ``,
    `Look at the user's question and ${owner}'s reply. If you have something to add or a different answer, go ahead and answer. If you would rather not, put ... in the text field of the JSON, or leave text empty.`,
  ].join("\n");
}

/** General N-way version of buildGuestFollowupMessage — used by ordered
 *  turn-taking (2 or 3 speakers, any leader) instead of the fixed
 *  owner-then-one-guest shape. Same content-level rule: asks whether the
 *  agent has something to *add*, never whether it's "allowed" to speak.
 *
 *  Each prior reply's `spokenText` is the PARSED spoken text (caller runs
 *  `extractSpokenText`), never raw JSON (SC-209). */
export function buildFollowupMessage(args: {
  userMessage: string;
  priorReplies: { speakerId: string; spokenText: string }[];
}): string {
  const lines = [`The user asks: "${args.userMessage}"`, ``];
  for (const r of args.priorReplies) {
    lines.push(`${cap(r.speakerId)} replied: "${r.spokenText}"`);
  }
  lines.push(
    ``,
    `Look at the user's question and the replies above. If you have something to add or a different answer, go ahead and answer. If you would rather not, put ... in the text field of the JSON, or leave text empty.`,
  );
  return lines.join("\n");
}

/** Room-orientation intro applied to the single-speaker cases (1: owner
 *  alone, 5: owner away + guest) — extends the "In X's room, there are Y. The
 *  user asks: ..." shape already used in the multi-beat follow-up flow
 *  (buildFollowupMessage/buildGuestFollowupMessage) to the cases that
 *  didn't have it. The orientation already exists in the chained
 *  owner+guest chat; this applies it to the remaining 2 cases. Experimental, to see
 *  how the LLM reacts to being told the room + who's in it up front,
 *  including the user themself in the presence list. This wraps the
 *  *message* sent to the LLM, not persisted turns — callers must keep
 *  using the raw user text for session/room-transcript persistence. */
export function buildOrientationLine(args: {
  ownerId: string;
  occupants: string[]; // all present agents, including the owner if present
  userMessage: string;
}): string {
  const owner = cap(args.ownerId);
  const ownerPresent = args.occupants.includes(args.ownerId);
  const guests = args.occupants.filter((a) => a !== args.ownerId);
  const names = [...(ownerPresent ? [owner] : []), ...guests.map(cap), "the user"];
  const namesText = names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : names[0];
  const presence = ownerPresent
    ? `there are ${namesText}`
    : `${owner} is not in the room, there are ${namesText}`;
  return `In ${owner}'s room, ${presence}. The user asks: "${args.userMessage}"`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Speaker resolution (server-side, deterministic) ─────────────────────

export type SpeakerCase = "normal" | "meeting" | "empty" | "visitorOnly";

export interface SpeakerResolution {
  speakerId: string;
  case: SpeakerCase;
}

/** Resolve the single speaker for a user message, from presence.
 *
 *  The core law of the sequential protocol: presence routes, it does not
 *  multiply. One user message → one speaker. The absent owner's pipeline
 *  never runs (case 5 fixed).
 *
 *  - empty room → case "empty", no speaker (caller emits narrator frame)
 *  - addressee named in message → that agent speaks
 *  - else: owner if present (case 1/2), else primaryVisitor (case 5)
 *
 *  `presenceRows` is optional — used by primaryVisitor to pick the
 *  longest-present visitor. Falls back to first visitor if absent. */
export function resolveSpeaker(args: {
  ownerId: string;
  message: string;
  occupants: string[];
  presenceRows?: RoomPresence[];
  /** Explicit client-selected addressee (click-to-address), takes
   *  priority over substring name detection when the target is still
   *  present. Stale (departed) selections fall through to the default
   *  rule instead of erroring — SC-002. */
  explicitAddressee?: string;
}): SpeakerResolution | { case: "empty" } {
  const { ownerId, message, occupants, presenceRows, explicitAddressee } = args;
  if (occupants.length === 0) {
    return { case: "empty" };
  }
  const ownerHere = occupants.includes(ownerId);
  const visitors = occupants.filter((a) => a !== ownerId);

  // 1. Explicit addressee (if still present) wins; else did the user name
  // exactly one agent in the message text?
  const addressee =
    explicitAddressee && occupants.includes(explicitAddressee)
      ? explicitAddressee
      : resolveAddressee(message, occupants);
  if (addressee) {
    return {
      speakerId: addressee,
      case: ownerHere && visitors.length > 0 ? "meeting" : ownerHere ? "normal" : "visitorOnly",
    };
  }
  // 2. Default: owner if present, else primary visitor.
  if (ownerHere) {
    return {
      speakerId: ownerId,
      case: visitors.length > 0 ? "meeting" : "normal",
    };
  }
  const visitor = primaryVisitor(occupants, ownerId, presenceRows);
  return { speakerId: visitor ?? visitors[0], case: "visitorOnly" };
}
