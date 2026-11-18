/**
 * Room chat log — compiles Garden events into a room-scoped log entry list.
 *
 * Distinct from castle-director.ts's Timeline (agent actions, colony-wide,
 * VNPayload shape for the Pixi'VN stage). This describes one room's own
 * conversation: who entered/left, and what was actually said in meetings
 * held at that room.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { JsonlGardenEventStore } from "../../../garden/event-store";
import type { GardenEvent } from "../../../garden/events";

export interface RoomLogEntry {
  agentName?: string;
  content: string;
}

interface MeetingConvenedPayload {
  meetingId: string;
  placeId: string;
}

interface MeetingIdPayload {
  meetingId: string;
}

interface MeetingTurnPayload extends MeetingIdPayload {
  text?: string;
}

interface MeetingClosedPayload extends MeetingIdPayload {
  topic?: string;
}

interface PulseStagePayload {
  stage: string;
}

interface EncounterPayload {
  encounterId: string;
  agents: string[];
  place: string;
}

interface EncounterLinePayload {
  encounterId: string;
  text?: string;
}

interface SharedConversationTurnPayload {
  placeId: string;
  text?: string;
}

interface PulseStageCompletedPayload extends PulseStagePayload {
  text: string;
}

/** pulse-anima-castle-migration always runs in Library — these events carry
 *  no placeId of their own (unlike MEETING_CONVENED), so the fixed room id
 *  is compared directly against the queried placeId instead of a payload
 *  field. */
const PULSE_ANIMA_ROOM_PLACE_ID = "library";

interface AgentMovedPayload {
  from: string;
  to: string;
}

/**
 * Build the log for `placeId` from a chronological, append-only event list.
 * `MEETING_JOINED`/`MEETING_TURN`/`MEETING_CLOSED` carry no placeId of their
 * own — this tracks meetingId -> placeId from each meeting's own
 * `MEETING_CONVENED` event while scanning, so those events still resolve to
 * the right room.
 */
interface CompiledRoomLogEntry {
  eventId: string;
  entry: RoomLogEntry;
}

/** A room is one place for chambers, but a public marker can stand for more
 *  than one place (Bridge = gate_world + gate_machine) —
 *  so the scope is a set. A single string keeps working: every existing
 *  caller and test passes one. */
function normalizePlaces(placeIds: string | readonly string[]): Set<string> {
  return new Set(typeof placeIds === "string" ? [placeIds] : placeIds);
}

/** Same scan as `buildRoomLogEntries`, keeping each entry's source event id
 *  so a stream can resume from `since` without re-emitting old entries. */
function compileRoomLog(events: readonly GardenEvent[], placeIds: string | readonly string[]): CompiledRoomLogEntry[] {
  const places = normalizePlaces(placeIds);
  const meetingPlace = new Map<string, string>();
  const encounterPlace = new Map<string, string>();
  const compiled: CompiledRoomLogEntry[] = [];
  const push = (eventId: string, entry: RoomLogEntry) => compiled.push({ eventId, entry });

  for (const event of events) {
    switch (event.type) {
      case "AGENT_MOVED": {
        const p = event.payload as AgentMovedPayload;
        if (places.has(p.to)) push(event.id, { content: `${event.agentId} entered the room` });
        if (places.has(p.from)) push(event.id, { content: `${event.agentId} left the room` });
        break;
      }
      case "MEETING_CONVENED": {
        const p = event.payload as MeetingConvenedPayload;
        meetingPlace.set(p.meetingId, p.placeId);
        if (places.has(p.placeId)) push(event.id, { content: `${event.agentId} started a meeting here` });
        break;
      }
      case "MEETING_JOINED": {
        const p = event.payload as MeetingIdPayload;
        if (places.has(meetingPlace.get(p.meetingId) ?? "")) push(event.id, { content: `${event.agentId} joined the meeting` });
        break;
      }
      case "MEETING_TURN": {
        const p = event.payload as MeetingTurnPayload;
        // A reference-only restricted event is intentionally invisible to
        // this unauthorised room feed. Text is available through the ACL-gated
        // conversation endpoint, never reconstructed here.
        if (places.has(meetingPlace.get(p.meetingId) ?? "") && typeof p.text === "string") push(event.id, { agentName: event.agentId, content: p.text });
        break;
      }
      case "MEETING_CLOSED": {
        const p = event.payload as MeetingClosedPayload;
        if (places.has(meetingPlace.get(p.meetingId) ?? "")) {
          push(event.id, { content: `The meeting${p.topic ? ` on "${p.topic}"` : ""} has ended` });
        }
        break;
      }
      case "PULSE_STAGE_STARTED": {
        const p = event.payload as PulseStagePayload;
        if (places.has(PULSE_ANIMA_ROOM_PLACE_ID)) push(event.id, { content: `${event.agentId} began the ${p.stage} cycle` });
        break;
      }
      case "PULSE_STAGE_COMPLETED": {
        const p = event.payload as PulseStageCompletedPayload;
        if (places.has(PULSE_ANIMA_ROOM_PLACE_ID)) push(event.id, { agentName: event.agentId, content: p.text });
        break;
      }
      case "ENCOUNTER": {
        const p = event.payload as EncounterPayload;
        encounterPlace.set(p.encounterId, p.place);
        if (places.has(p.place)) push(event.id, { content: `${p.agents.join(" and ")} crossed paths here` });
        break;
      }
      case "ENCOUNTER_LINE": {
        const p = event.payload as EncounterLinePayload;
        if (places.has(encounterPlace.get(p.encounterId) ?? "") && typeof p.text === "string") push(event.id, { agentName: event.agentId, content: p.text });
        break;
      }
      case "SHARED_CONVERSATION_TURN": {
        const p = event.payload as SharedConversationTurnPayload;
        if (places.has(p.placeId) && typeof p.text === "string") push(event.id, { agentName: event.agentId, content: p.text });
        break;
      }
      default:
        break;
    }
  }

  return compiled;
}

/** Build the log for `placeId` from a chronological, append-only event list. */
export function buildRoomLogEntries(events: readonly GardenEvent[], placeId: string | readonly string[]): RoomLogEntry[] {
  return compileRoomLog(events, placeId).map((c) => c.entry);
}

export interface RoomLogStreamOptions {
  roomsDir?: string;
  /** One placeId, or every place the room's marker stands for (Bridge:
   *  gate_world + gate_machine) — a string keeps working unchanged. */
  placeId: string | readonly string[];
  /** Poll interval in ms when watching for new events. */
  pollMs?: number;
  /** Max entries to backfill when `since` is omitted. */
  backfillLimit?: number;
  /** Only stream entries whose source event id is strictly after `since`. */
  since?: string;
}

const DEFAULT_ROOMS_DIR = () => process.env.ANIMA_ROOMS_DIR ?? join(homedir(), ".anima", "rooms");

function eventsPath(roomsDir: string): string {
  return join(roomsDir, "_shared", "garden", "events.jsonl");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sliceAfter(compiled: CompiledRoomLogEntry[], since: string | undefined, backfillLimit: number): CompiledRoomLogEntry[] {
  if (!since) return compiled.slice(-backfillLimit);
  const idx = compiled.findIndex((c) => c.eventId === since);
  return compiled.slice(idx === -1 ? 0 : idx + 1);
}

/** SSE stream of `{id, ts, entry}` frames scoped to `opts.placeId`. Mirrors
 *  castle-feed.ts's poll/backfill shape but emits RoomLogEntry, not VNPayload —
 *  the two feeds have different payload shapes and audiences. */
export function createRoomLogStream(opts: RoomLogStreamOptions): ReadableStream<Uint8Array> {
  const roomsDir = opts.roomsDir ?? DEFAULT_ROOMS_DIR();
  const store = new JsonlGardenEventStore(eventsPath(roomsDir));
  const pollMs = opts.pollMs ?? 2000;
  const backfillLimit = opts.backfillLimit ?? 500;
  const placeId = opts.placeId;
  const encoder = new TextEncoder();
  let stopped = false;

  const frame = (eventId: string, event: GardenEvent, entry: RoomLogEntry): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({ id: eventId, ts: event.timestamp, entry })}\n\n`);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const all = await store.readAll({});
        const byId = new Map(all.map((e) => [e.id, e]));
        let compiled = compileRoomLog(all, placeId);
        let backfill = sliceAfter(compiled, opts.since, backfillLimit);
        let lastEventId = all.length > 0 ? all[all.length - 1].id : "";

        for (const c of backfill) {
          const source = byId.get(c.eventId);
          if (source) controller.enqueue(frame(c.eventId, source, c.entry));
        }

        while (!stopped) {
          await sleep(pollMs);
          if (stopped) break;
          const fresh = await store.readAll({});
          const freshById = new Map(fresh.map((e) => [e.id, e]));
          // Find "new since last poll" against the RAW event list, not the
          // room-filtered compiled one — most raw events (other rooms, other
          // types) produce no compiled entry at all, so looking up lastEventId
          // inside `compiled` routinely misses and falls back to "not found",
          // which used to replay the entire history every poll tick (a room-log stream re-sent its full backlog
          // on every poll once anything else in the colony ticked).
          const lastRawIdx = lastEventId ? fresh.findIndex((e) => e.id === lastEventId) : -1;
          const newRawIds = new Set((lastRawIdx === -1 ? fresh : fresh.slice(lastRawIdx + 1)).map((e) => e.id));
          compiled = compileRoomLog(fresh, placeId).filter((c) => newRawIds.has(c.eventId));
          for (const c of compiled) {
            const source = freshById.get(c.eventId);
            if (source) controller.enqueue(frame(c.eventId, source, c.entry));
          }
          if (fresh.length > 0) lastEventId = fresh[fresh.length - 1].id;
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      stopped = true;
    },
  });
}
