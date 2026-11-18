import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drainConversationProjection, exportMeetingConversation, gardenSpeechPayload } from "../src/conversation/projections";
import { ConversationService } from "../src/conversation/service";
import { SessionStore } from "../src/memory/session-store";
import { buildRoomLogEntries } from "../src/ui/features/castle/castle-room-log";
import type { GardenEvent } from "../src/garden/events";
import { JsonlGardenEventStore } from "../src/garden/event-store";

let dir: string;
let store: SessionStore;
let service: ConversationService;
beforeEach(() => {
  dir = join(tmpdir(), `shared-projection-${Date.now()}-${Math.random()}`);
  store = new SessionStore(join(dir, "sessions.db"));
  service = new ConversationService({ store, operatorId: "owner", resolvePlace: (placeId) => ({ placeId, visibility: "members", occupants: ["bruno"] }), isKnownColonyPrincipal: () => false });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("restricted shared speech exposes only a reference to public garden/log projections", () => {
  const conversation = service.getOrCreateAmbientForSpeech("chamber_bruno").conversation;
  const turn = store.appendSharedUtterance({ conversationId: conversation.sessionId, role: "assistant", speakerId: "bruno", content: "PRIVATE_MARKER", utteranceKey: "p", requestId: "p", source: "meeting" });
  const payload = gardenSpeechPayload(conversation, turn);
  const event = { id: "e", type: "MEETING_TURN", timestamp: new Date().toISOString(), agentId: "bruno", instanceId: "i", runtime: "hub", project: "castle", payload: { meetingId: "m", ...payload } } as GardenEvent;

  expect(JSON.stringify(event)).not.toContain("PRIVATE_MARKER");
  expect(buildRoomLogEntries([{ ...event, payload: { meetingId: "m", placeId: "chamber_bruno", ...payload } }], "chamber_bruno")).toEqual([]);
  expect(store.getSharedUtterances(conversation.sessionId)[0]?.content).toBe("PRIVATE_MARKER");
});

test("meeting export is ACL-gated and keyed only by meeting id", () => {
  const conversation = store.createSharedConversation({ kind: "meeting", meetingId: "meeting-42", placeId: "garden", visibility: "members", readerIds: ["bruno", "owner"] });
  store.appendSharedUtterance({ conversationId: conversation.sessionId, role: "assistant", speakerId: "bruno", content: "PRIVATE_EXPORT", utteranceKey: "x", requestId: "x", source: "meeting", meetingId: "meeting-42" });

  expect(() => exportMeetingConversation({ store, service, principalId: "eli", conversationId: conversation.sessionId, meetingId: "meeting-42", roomsDir: dir })).toThrow(/forbidden/);
  const path = exportMeetingConversation({ store, service, principalId: "owner", conversationId: conversation.sessionId, meetingId: "meeting-42", roomsDir: dir });

  expect(path).toBe(join(dir, "_meeting", "by-id", "meeting-42.md"));
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("PRIVATE_EXPORT");
});

test("projection drain retries a post-commit turn without duplicate garden events", async () => {
  const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });
  store.appendSharedUtterance({ conversationId: conversation.sessionId, role: "assistant", speakerId: "bruno", content: "PUBLIC_PROJECTION", utteranceKey: "drain", requestId: "drain", source: "ui" });
  const events = new JsonlGardenEventStore(join(dir, "events.jsonl"));

  expect(await drainConversationProjection({ store, eventStore: events, conversationId: conversation.sessionId })).toBe(1);
  expect(await drainConversationProjection({ store, eventStore: events, conversationId: conversation.sessionId })).toBe(0);
  const projected = await events.readAll({});
  expect(projected).toHaveLength(1);
  expect(projected[0]?.payload).toMatchObject({ conversationId: conversation.sessionId, text: "PUBLIC_PROJECTION" });
});
