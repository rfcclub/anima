import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store";

let tempDir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-shared-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(tempDir, "sessions.db");
  store = new SessionStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("shared conversation storage", () => {
  test("creates an isolated ambient root and persists attributed canonical utterances", () => {
    const bruno = store.createSession("bruno", "ui");
    const room = store.createSharedConversation({
      kind: "ambient",
      placeId: "garden",
      visibility: "colony",
      readerIds: ["bruno", "eli", "owner"],
    });

    expect(room.sessionId).not.toBe(bruno.id);
    expect(room.kind).toBe("ambient");
    expect(room.readerIds).toEqual(["bruno", "eli", "owner"]);
    expect(store.getSession(room.sessionId)).toMatchObject({ agent: "@shared", channel: "ambient:garden" });
    expect(store.getActiveBranch(room.sessionId)?.id).toBe(room.rootBranchId);
    expect(store.getOpenAmbientConversation("garden")?.sessionId).toBe(room.sessionId);

    const first = store.appendSharedUtterance({
      conversationId: room.sessionId,
      role: "user",
      speakerId: "owner",
      content: "Hello room",
      utteranceKey: "ui:request-1:user",
      requestId: "request-1",
      source: "ui",
    });
    const second = store.appendSharedUtterance({
      conversationId: room.sessionId,
      role: "assistant",
      speakerId: "bruno",
      content: "Hello Owner",
      utteranceKey: "ui:request-1:bruno",
      requestId: "request-1",
      source: "ui",
    });

    expect(second.turnId).toBeGreaterThan(first.turnId);
    expect(store.getSharedUtterances(room.sessionId)).toMatchObject([
      { turnId: first.turnId, speakerId: "owner", content: "Hello room" },
      { turnId: second.turnId, speakerId: "bruno", content: "Hello Owner" },
    ]);
    expect(store.getTurns(bruno.id)).toEqual([]);
  });

  test("records request progress against one shared conversation", () => {
    const room = store.createSharedConversation({
      kind: "ambient",
      placeId: "garden",
      visibility: "colony",
      readerIds: ["bruno", "owner"],
    });

    const request = store.beginSharedRequest({
      requestKey: "ui:request-2",
      conversationId: room.sessionId,
      inputHash: "hash-2",
    });
    const updated = store.updateSharedRequest("ui:request-2", {
      status: "complete",
      completedSpeakers: ["bruno"],
    });

    expect(request).toMatchObject({ status: "running", completedSpeakers: [] });
    expect(updated).toMatchObject({ status: "complete", completedSpeakers: ["bruno"] });
  });
});
