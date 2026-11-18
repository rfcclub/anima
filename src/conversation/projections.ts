import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationService } from "./service";
import type { SharedConversationRecord, SharedUtteranceRecord } from "./types";
import { SessionStore } from "../memory/session-store";
import { createGardenEvent } from "../garden/events";
import type { JsonlGardenEventStore } from "../garden/event-store";

/** Garden/room feeds are not authority-bearing readers. A restricted turn is
 * represented there by immutable references only; its text is resolved only
 * by the authorised canonical conversation endpoint. */
export function gardenSpeechPayload(
  conversation: SharedConversationRecord,
  turn: SharedUtteranceRecord,
): Record<string, unknown> {
  const reference = {
    conversationId: conversation.sessionId,
    turnId: turn.turnId,
    audience: conversation.visibility,
  };
  return conversation.visibility === "colony"
    ? { ...reference, text: turn.content }
    : reference;
}

export function exportMeetingConversation(input: {
  store: SessionStore;
  service: ConversationService;
  principalId: string;
  conversationId: string;
  meetingId: string;
  roomsDir: string;
}): string {
  const conversation = input.store.getSharedConversation(input.conversationId);
  if (!conversation || conversation.kind !== "meeting" || conversation.meetingId !== input.meetingId) {
    throw new Error("meeting conversation not found");
  }
  if (!input.service.authorizeRead(input.principalId, input.conversationId)) {
    throw new Error("meeting export forbidden");
  }
  // meetingId comes from canonical metadata and is deliberately not a topic
  // or day path; constrain it anyway before constructing the export path.
  if (!/^[a-zA-Z0-9_-]+$/.test(input.meetingId)) throw new Error("invalid meeting id");
  const target = join(input.roomsDir, "_meeting", "by-id", `${input.meetingId}.md`);
  mkdirSync(join(target, ".."), { recursive: true });
  const lines = ["# Restricted meeting transcript", ""];
  for (const turn of input.store.getSharedUtterances(input.conversationId, { limit: 100 })) {
    lines.push(`## ${turn.speakerId}`, "", turn.content, "");
  }
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  return target;
}

/** Idempotent one-way drain from canonical turns to display-only Garden
 * events. It never reads legacy room transcripts and it never makes Garden a
 * source of truth. A crash after SQL commit is repaired by calling this again. */
export async function drainConversationProjection(input: {
  store: SessionStore;
  eventStore: Pick<JsonlGardenEventStore, "appendIfAbsent">;
  conversationId: string;
}): Promise<number> {
  const conversation = input.store.getSharedConversation(input.conversationId);
  if (!conversation) return 0;
  let projected = 0;
  for (const turn of input.store.getSharedUtterances(input.conversationId, { limit: 100 })) {
    const event = createGardenEvent({
      id: `shared-conversation:${conversation.sessionId}:${turn.turnId}`,
      type: "SHARED_CONVERSATION_TURN",
      timestamp: turn.ts,
      agentId: turn.speakerId,
      instanceId: "shared-conversation",
      runtime: "hub",
      project: "castle",
      payload: { placeId: conversation.placeId, role: turn.role, ...gardenSpeechPayload(conversation, turn) },
    });
    if (await input.eventStore.appendIfAbsent(event)) projected++;
  }
  return projected;
}
