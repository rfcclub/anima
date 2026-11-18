import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationService, createConversationService } from "../src/conversation/service";
import { SessionStore } from "../src/memory/session-store";

let tempDir: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-shared-access-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  store = new SessionStore(join(tempDir, "sessions.db"));
});
afterEach(() => { store.close(); rmSync(tempDir, { recursive: true, force: true }); });

describe("ConversationService ambient audience", () => {
  test("opens a chamber epoch only on speech and rotates before a newly admitted reader can see history", () => {
    let occupants = ["bruno", "eli"];
    const service = new ConversationService({
      store,
      operatorId: "owner",
      resolvePlace: (placeId) => ({ placeId, visibility: "members", occupants }),
      isKnownColonyPrincipal: (id) => ["bruno", "eli"].includes(id),
    });

    const r1 = service.getOrCreateAmbientForSpeech("chamber_bruno");
    store.appendSharedUtterance({ conversationId: r1.conversation.sessionId, role: "assistant", speakerId: "bruno", content: "old secret", utteranceKey: "a1", requestId: "r1", source: "ui" });
    occupants = ["bruno", "eli", "dana"];

    const rotation = service.getOrCreateAmbientForSpeech("chamber_bruno", r1.conversation.sessionId);

    expect(rotation.changed).toBe(true);
    expect(rotation.conversation.sessionId).not.toBe(r1.conversation.sessionId);
    expect(store.getSharedUtterances(rotation.conversation.sessionId)).toEqual([]);
    expect(service.authorizeRead("dana", r1.conversation.sessionId)).toBe(false);
    expect(service.authorizeRead("dana", rotation.conversation.sessionId)).toBe(true);
  });

  test("carries history forward when the single agent reader admits a known colony principal", () => {
    let occupants = ["bruno"];
    const service = new ConversationService({
      store,
      operatorId: "owner",
      resolvePlace: (placeId) => ({ placeId, visibility: "members", occupants }),
      isKnownColonyPrincipal: (id) => ["bruno", "dana"].includes(id),
    });

    const r1 = service.getOrCreateAmbientForSpeech("chamber_bruno").conversation;
    store.appendSharedUtterance({ conversationId: r1.sessionId, role: "assistant", speakerId: "bruno", content: "welcome back", utteranceKey: "a2", requestId: "r2", source: "ui" });
    occupants = ["bruno", "dana"];

    const r2 = service.getOrCreateAmbientForSpeech("chamber_bruno", r1.sessionId).conversation;

    expect(r2.inheritedFromConversationId).toBe(r1.sessionId);
    expect(store.getSharedUtterances(r2.sessionId).map((turn) => turn.content)).toEqual(["welcome back"]);
    expect(service.voteHistorySharing(["bruno", "owner"], "dana")).toBe("share");
  });

  test("never counts the operator as a history-sharing voter", () => {
    const service = new ConversationService({
      store,
      operatorId: "owner",
      resolvePlace: () => null,
      isKnownColonyPrincipal: () => true,
    });

    expect(service.voteHistorySharing(["owner"], "dana")).toBe("deny");
  });

  test("allows known colony principals to join a common-room epoch without rotating it", () => {
    const service = new ConversationService({
      store,
      operatorId: "owner",
      resolvePlace: (placeId) => ({ placeId, visibility: "colony", occupants: ["bruno"] }),
      isKnownColonyPrincipal: (id) => ["bruno", "dana", "eli"].includes(id),
      listKnownColonyPrincipals: () => ["bruno", "dana", "eli"],
    });
    const garden = service.getOrCreateAmbientForSpeech("garden").conversation;
    store.appendSharedUtterance({ conversationId: garden.sessionId, role: "assistant", speakerId: "bruno", content: "garden history", utteranceKey: "garden-1", requestId: "garden-request", source: "ui" });

    const current = service.getOrCreateAmbientForSpeech("garden", garden.sessionId);

    expect(current.changed).toBe(false);
    expect(service.authorizeRead("dana", garden.sessionId)).toBe(true);
    expect(store.getSharedUtterances(garden.sessionId).map((turn) => turn.content)).toEqual(["garden history"]);
  });

  test("SC-T02-vacancy: a returning identical occupant set still gets a fresh epoch after the room went empty", () => {
    let occupants = ["bruno"];
    const service = new ConversationService({
      store,
      operatorId: "owner",
      resolvePlace: (placeId) => ({ placeId, visibility: "members", occupants }),
      isKnownColonyPrincipal: () => true,
    });

    const r1 = service.getOrCreateAmbientForSpeech("chamber_bruno").conversation;
    store.appendSharedUtterance({ conversationId: r1.sessionId, role: "assistant", speakerId: "bruno", content: "before vacancy", utteranceKey: "v1", requestId: "req-v1", source: "ui" });

    // Room goes empty, then the exact same occupant returns — reader-set
    // diffing alone sees no change (["bruno","owner"] before and after), so
    // without vacancy tracking this would wrongly continue r1.
    occupants = [];
    store.markPlaceVacant("chamber_bruno");
    occupants = ["bruno"];

    const r2 = service.getOrCreateAmbientForSpeech("chamber_bruno", r1.sessionId).conversation;

    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(r2.inheritedFromConversationId).toBeNull();
    expect(store.getSharedUtterances(r2.sessionId)).toEqual([]);
  });

  test("SC-T02-prod: real production wiring maps place kind to visibility and presence to occupants", () => {
    const places: Record<string, { id: string; kind: string }> = {
      chamber_bruno: { id: "chamber_bruno", kind: "chamber" },
      garden: { id: "garden", kind: "garden" },
    };
    const presence = [{ agentId: "bruno", placeId: "chamber_bruno" }, { agentId: "eli", placeId: "garden" }];
    const service = createConversationService({
      store,
      operatorId: "owner",
      narrativeStore: { getPlace: (id) => places[id] ?? null, listPresence: () => presence },
      listColonyAgentIds: () => ["bruno", "eli"],
    });

    const chamber = service.getOrCreateAmbientForSpeech("chamber_bruno").conversation;
    expect(chamber.visibility).toBe("members");
    expect(chamber.readerIds).toEqual(["bruno", "owner"]);

    const gardenConv = service.getOrCreateAmbientForSpeech("garden").conversation;
    expect(gardenConv.visibility).toBe("colony");
    expect(gardenConv.readerIds).toEqual(["bruno", "eli", "owner"]);

    expect(() => service.getOrCreateAmbientForSpeech("nowhere")).toThrow(/unknown shared place/);
  });

  test("permits only the operator to reset an ambient epoch without touching its archive", () => {
    const service = new ConversationService({
      store,
      operatorId: "owner",
      resolvePlace: (placeId) => ({ placeId, visibility: "members", occupants: ["bruno"] }),
      isKnownColonyPrincipal: () => true,
    });
    const room = service.getOrCreateAmbientForSpeech("chamber_bruno").conversation;

    expect(() => service.resetAmbient("bruno", room.sessionId)).toThrow(/operator/);
    service.resetAmbient("owner", room.sessionId);

    expect(store.getSharedConversation(room.sessionId)?.closedAt).toBeTruthy();
    expect(store.getOpenAmbientConversation("chamber_bruno")).toBeNull();
  });
});
