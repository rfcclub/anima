import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedAutonomousConversationAdapter } from "../src/conversation/autonomous";
import { ConversationService } from "../src/conversation/service";
import { SessionStore } from "../src/memory/session-store";
import { SharedNarrativeStore } from "../src/narrative/shared-store";
import { JsonlGardenEventStore } from "../src/garden/event-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

let dir: string;
let sessionStore: SessionStore;
let narrative: SharedNarrativeStore;
beforeEach(() => {
  dir = join(tmpdir(), `shared-autonomous-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, "rooms", "_shared"), { recursive: true });
  sessionStore = new SessionStore(join(dir, "sessions.db"));
  narrative = new SharedNarrativeStore(join(dir, "rooms", "_shared", "memory.db"));
  narrative.seedPlacesFromRoster(["bruno", "eli"]);
  narrative.setPresence({ agentId: "bruno", placeId: "garden", since: 1 });
  narrative.setPresence({ agentId: "eli", placeId: "garden", since: 1 });
});
afterEach(() => { sessionStore.close(); rmSync(dir, { recursive: true, force: true }); });

class SafeProvider implements Provider {
  name = "safe";
  sharedSafe = true;
  calls: ProviderRequest[] = [];
  query(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    return Promise.resolve({ message: { role: "assistant", content: "canonical autonomous speech" } });
  }
}

function adapter(provider = new SafeProvider()) {
  const service = new ConversationService({
    store: sessionStore,
    operatorId: "owner",
    resolvePlace: (placeId) => {
      const place = narrative.getPlace(placeId);
      return place ? { placeId, visibility: place.kind === "chamber" ? "members" : "colony", occupants: narrative.listPresence().filter((p) => p.placeId === placeId).map((p) => p.agentId) } : null;
    },
    isKnownColonyPrincipal: (id) => ["bruno", "eli"].includes(id),
    listKnownColonyPrincipals: () => ["bruno", "eli"],
  });
  return { provider, adapter: new SharedAutonomousConversationAdapter({ sessionStore, conversationService: service, narrativeStore: narrative, operatorId: "owner", providers: new Map([["bruno", provider], ["eli", provider]]), roomsDir: join(dir, "rooms"), now: () => 12 }) };
}

test("encounter appends only canonical assistant speech and the second line reads the first", async () => {
  const { adapter: shared, provider } = adapter();
  const first = await shared.speakEncounter({ encounterId: "e-1", speakerId: "bruno", colleagueId: "eli", placeId: "garden" });
  const second = await shared.speakEncounter({ encounterId: "e-1", speakerId: "eli", colleagueId: "bruno", placeId: "garden" });

  expect(first?.role).toBe("assistant");
  expect(sessionStore.getSharedUtterances(first!.conversationId).map((turn) => turn.role)).toEqual(["assistant", "assistant"]);
  expect(provider.calls[1]?.messages[0]?.content).toContain("canonical autonomous speech");
  expect(provider.calls.every((call) => call.tools?.length === 0)).toBe(true);
  expect(second?.source).toBe("encounter");
});

test("autonomous speech drains its canonical turn to the display projection", async () => {
  const { adapter: shared } = adapter();
  const turn = await shared.speakEncounter({ encounterId: "e-visible", speakerId: "bruno", colleagueId: "eli", placeId: "garden" });

  const events = await new JsonlGardenEventStore(join(dir, "rooms", "_shared", "garden", "events.jsonl")).readAll({});
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("SHARED_CONVERSATION_TURN");
  expect(events[0]?.payload).toMatchObject({ conversationId: turn?.conversationId, turnId: turn?.turnId, text: "canonical autonomous speech" });
});

test("restricted meeting freezes its original reader set and denies a non-attending speaker", async () => {
  narrative.conveneMeeting({ id: "m-1", topic: "same topic", convener: "bruno", placeId: "garden", agenda: "focus", invite: ["eli"], now: 10 });
  const { adapter: shared } = adapter();

  await expect(shared.speakMeeting({ meetingId: "m-1", speakerId: "eli" })).rejects.toThrow(/not attending/);
  narrative.joinMeeting("m-1", "eli", 11);
  const turn = await shared.speakMeeting({ meetingId: "m-1", speakerId: "eli" });
  const conversation = sessionStore.getSharedConversation(turn!.conversationId)!;

  expect(conversation.kind).toBe("meeting");
  expect(conversation.readerIds).toEqual(["bruno", "eli", "owner"]);
  expect(narrative.getMeetingConversation("m-1")?.conversationId).toBe(conversation.sessionId);
  expect(sessionStore.getSharedUtterances(conversation.sessionId).map((row) => row.role)).toEqual(["assistant"]);
});

test("an explicitly room-public meeting binds the ambient conversation", async () => {
  narrative.conveneMeeting({ id: "m-public", topic: "public", convener: "bruno", placeId: "garden", agenda: "share", visibility: "colony", now: 10 });
  const { adapter: shared } = adapter();
  const turn = await shared.speakMeeting({ meetingId: "m-public", speakerId: "bruno" });
  const conversation = sessionStore.getSharedConversation(turn!.conversationId)!;

  expect(conversation.kind).toBe("ambient");
  expect(conversation.visibility).toBe("colony");
  expect(narrative.getMeetingConversation("m-public")?.visibility).toBe("colony");
});
