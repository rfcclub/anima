/**
 * Castle Director — compiles Garden events into VN payloads for the watch feed.
 *
 * The VN client should not learn castle semantics. This director translates
 * AGENT_MOVED events into the existing VN JSON payload shape so the client
 * can render the feed with the same applyPayload pipeline.
 */

import type { GardenEvent } from "../../../garden/events";

/**
 * Local VNPayload mirror — kept structurally compatible with
 * packages/castle-vn/src/lib/vn-payload.ts so the client's applyPayload
 * accepts it. Duplicated (not imported) to avoid a build-time dependency
 * from src/ui on the castle-vn bundle.
 */
export interface VNPayload {
  text: string;
  mood?: string;
  emotion?: string;
  scene?: string;
  transition?: string;
  characters?: Array<{
    agentId: string;
    action: string;
    position?: string;
    emotion?: string;
  }>;
  choices?: Array<{ label: string; value: string }>;
  action?: string;
  music?: string | null;
  sfx?: string;
  speakerId?: string;
  raw: string;
  parsed: boolean;
}

interface AgentMovedPayload {
  from: string;
  to: string;
  disposition: string;
  seed: number;
}

export function eventToVnPayload(event: GardenEvent): VNPayload | null {
  if (event.type === "DISCOVERY") {
    const p = event.payload as { expeditionId?: string; summary?: string };
    return {
      text: p.summary ?? "",
      mood: "neutral",
      speakerId: event.agentId,
      choices: [],
      raw: "",
      parsed: true,
    };
  }
  if (event.type === "ENCOUNTER") {
    const p = event.payload as { encounterId?: string; agents?: string[]; place?: string };
    return {
      text: "",
      mood: "neutral",
      scene: p.place ?? "hall_main",
      transition: "fade",
      characters: (p.agents ?? []).map((agentId, i) => ({
        agentId,
        action: "enter",
        position: i === 0 ? "center-left" : "center-right",
        emotion: "neutral",
      })),
      choices: [],
      raw: "",
      parsed: true,
    };
  }
  if (event.type === "ENCOUNTER_LINE") {
    const p = event.payload as { encounterId?: string; text?: string };
    return {
      text: p.text ?? "",
      mood: "neutral",
      speakerId: event.agentId,
      choices: [],
      raw: "",
      parsed: true,
    };
  }
  if (event.type === "MEETING_CONVENED" || event.type === "MEETING_JOINED") {
    const p = event.payload as { meetingId?: string; placeId?: string };
    return {
      text: "",
      mood: "neutral",
      scene: p.placeId ?? "hall_main",
      transition: "fade",
      speakerId: event.agentId,
      characters: [{ agentId: event.agentId, action: "enter", position: "center", emotion: "neutral" }],
      choices: [],
      raw: "",
      parsed: true,
    };
  }
  if (event.type === "MEETING_TURN") {
    const p = event.payload as { meetingId?: string; text?: string };
    return {
      text: p.text ?? "",
      mood: "neutral",
      speakerId: event.agentId,
      choices: [],
      raw: "",
      parsed: true,
    };
  }
  if (event.type === "SHARED_CONVERSATION_TURN") {
    const p = event.payload as { text?: string };
    if (typeof p.text !== "string") return null;
    return { text: p.text, mood: "neutral", speakerId: event.agentId, choices: [], raw: "", parsed: true };
  }
  if (event.type === "MEETING_CLOSED") {
    const p = event.payload as { meetingId?: string; topic?: string };
    return {
      text: `The meeting${p.topic ? ` on "${p.topic}"` : ""} has ended.`,
      mood: "neutral",
      choices: [],
      raw: "",
      parsed: true,
    };
  }
  if (event.type !== "AGENT_MOVED") return null;
  const payload = event.payload as AgentMovedPayload;
  if (payload.from === payload.to) return null;

  return movedEnterPayload(event.agentId, payload.to);
}

/**
 * Exit payload for a move: the agent leaves the source place. Carried on its
 * own frame so the client can animate the departure before the arrival.
 */
function movedExitPayload(agentId: string, from: string): VNPayload {
  return {
    text: "",
    mood: "neutral",
    scene: from,
    transition: "fade",
    speakerId: agentId,
    characters: [
      {
        agentId,
        action: "exit",
        position: "center",
        emotion: "neutral",
      },
    ],
    choices: [],
    raw: "",
    parsed: true,
  };
}

/** Enter payload for a move: the agent arrives at the destination place. */
function movedEnterPayload(agentId: string, to: string): VNPayload {
  return {
    text: "",
    mood: "neutral",
    scene: to,
    transition: "fade",
    speakerId: agentId,
    characters: [
      {
        agentId,
        action: "enter",
        position: "center",
        emotion: "neutral",
      },
    ],
    choices: [],
    raw: "",
    parsed: true,
  };
}

/**
 * Full payload sequence for an event. AGENT_MOVED expands to [exit, enter] so
 * the client sees the departure from `from` before the arrival at `to`; a
 * zero-distance move yields no frames. All other event types return a
 * single-element array (or empty when the director returns null).
 *
 * The feed and replay streams flatten this sequence — one SSE frame per
 * payload, preserving order.
 */
export function eventToVnPayloads(event: GardenEvent): VNPayload[] {
  if (event.type === "AGENT_MOVED") {
    const payload = event.payload as AgentMovedPayload;
    if (payload.from === payload.to) return [];
    return [movedExitPayload(event.agentId, payload.from), movedEnterPayload(event.agentId, payload.to)];
  }
  const single = eventToVnPayload(event);
  return single ? [single] : [];
}
