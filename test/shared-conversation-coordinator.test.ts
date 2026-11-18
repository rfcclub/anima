import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedTurnCoordinator } from "../src/conversation/coordinator";
import { SessionStore } from "../src/memory/session-store";

let dir: string;
let store: SessionStore;
beforeEach(() => { dir = join(tmpdir(), `shared-coordinator-${Date.now()}-${Math.random()}`); store = new SessionStore(join(dir, "sessions.db")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("SharedTurnCoordinator", () => {
  test("serializes one conversation and replays a completed request without regenerating", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });
    const coordinator = new SharedTurnCoordinator(store);
    let calls = 0;
    const input = { conversationId: conversation.sessionId, requestKey: "req", inputHash: "hash", userId: "operator-42", speakerId: "bruno", userText: "hello" };

    const first = await coordinator.submit(input, async () => { calls++; return "hello back"; });
    const replay = await coordinator.submit(input, async () => { calls++; return "must not run"; });

    expect(first.map((u) => u.content)).toEqual(["hello", "hello back"]);
    expect(replay.map((u) => u.content)).toEqual(["hello", "hello back"]);
    expect(first[0]?.speakerId).toBe("operator-42");
    expect(calls).toBe(1);
  });

  test("commits ordered speakers sequentially so the second beat sees the first", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "eli", "owner"] });
    const coordinator = new SharedTurnCoordinator(store);
    const seenByEli: string[] = [];

    const result = await coordinator.submitOrdered({
      conversationId: conversation.sessionId, requestKey: "ordered", inputHash: "ordered-hash", userId: "owner", userText: "hello", speakerIds: ["bruno", "eli"],
    }, async (speakerId) => {
      seenByEli.push(...store.getSharedUtterances(conversation.sessionId).map((u) => `${speakerId}:${u.content}`));
      return speakerId === "bruno" ? "first reply" : "second reply";
    });

    expect(result.map((u) => u.content)).toEqual(["hello", "first reply", "second reply"]);
    expect(seenByEli).toContain("eli:first reply");
  });

  test("rejects a replay key whose input hash changed", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });
    const coordinator = new SharedTurnCoordinator(store);
    const base = { conversationId: conversation.sessionId, requestKey: "same", inputHash: "first", userId: "owner", speakerId: "bruno", userText: "hello" };
    await coordinator.submit(base, async () => "ok");

    await expect(coordinator.submit({ ...base, inputHash: "changed" }, async () => "must not run")).rejects.toThrow(/conflicts/);
  });

  test("replays committed partial rows after a failed request without regenerating", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "eli", "owner"] });
    const coordinator = new SharedTurnCoordinator(store);
    const input = { conversationId: conversation.sessionId, requestKey: "partial", inputHash: "partial-hash", userId: "owner", userText: "hello", speakerIds: ["bruno", "eli"] };
    let calls = 0;

    await expect(coordinator.submitOrdered(input, async (speaker) => {
      calls++;
      if (speaker === "eli") throw new Error("provider down");
      return "bruno committed";
    })).rejects.toThrow(/provider down/);
    const replay = await coordinator.submitOrdered(input, async () => { calls++; return "must not run"; });

    expect(replay.map((turn) => turn.content)).toEqual(["hello", "bruno committed"]);
    expect(calls).toBe(2);
    expect(store.getSharedRequest("partial")?.status).toBe("failed");
  });

  test("records a decline as completed progress without inventing an utterance", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });
    const coordinator = new SharedTurnCoordinator(store);

    const rows = await coordinator.submit({ conversationId: conversation.sessionId, requestKey: "decline", inputHash: "decline-hash", userId: "owner", speakerId: "bruno", userText: "hello" }, async () => null);

    expect(rows.map((turn) => turn.content)).toEqual(["hello"]);
    expect(store.getSharedRequest("decline")?.completedSpeakers).toEqual(["bruno"]);
  });

  test("serializes a conversation across coordinator instances", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "eli", "owner"] });
    const firstCoordinator = new SharedTurnCoordinator(store);
    const secondCoordinator = new SharedTurnCoordinator(store);
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];

    const first = firstCoordinator.submit({ conversationId: conversation.sessionId, requestKey: "one", inputHash: "one", userId: "owner", speakerId: "bruno", userText: "one" }, async () => {
      started.push("first");
      await firstStarted;
      return "first reply";
    });
    const second = secondCoordinator.submit({ conversationId: conversation.sessionId, requestKey: "two", inputHash: "two", userId: "owner", speakerId: "eli", userText: "two" }, async () => {
      started.push("second");
      return "second reply";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["first", "second"]);
  });

  test("marks unfinished work interrupted at startup and replays its canonical rows", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });
    store.beginSharedRequest({ requestKey: "restart", conversationId: conversation.sessionId, inputHash: "restart-hash" });
    store.appendSharedUtterance({ conversationId: conversation.sessionId, role: "user", speakerId: "owner", content: "before restart", utteranceKey: "restart:user", requestId: "restart", source: "ui" });
    const coordinator = new SharedTurnCoordinator(store);

    expect(coordinator.recoverInterruptedRequests()).toBe(1);
    const rows = await coordinator.submit({ conversationId: conversation.sessionId, requestKey: "restart", inputHash: "restart-hash", userId: "owner", speakerId: "bruno", userText: "before restart" }, async () => "must not run");

    expect(rows.map((turn) => turn.content)).toEqual(["before restart"]);
    expect(store.getSharedRequest("restart")?.status).toBe("interrupted");
  });

  test("cancellation fences a late provider result before it can be committed", async () => {
    const conversation = store.createSharedConversation({ kind: "ambient", placeId: "garden", visibility: "colony", readerIds: ["bruno", "owner"] });
    const coordinator = new SharedTurnCoordinator(store);
    const abort = new AbortController();

    await expect(coordinator.submit(
      { conversationId: conversation.sessionId, requestKey: "cancel", inputHash: "cancel-hash", userId: "owner", speakerId: "bruno", userText: "hello", signal: abort.signal },
      async () => { abort.abort(); return "late reply"; },
    )).rejects.toThrow(/cancelled/);

    expect(store.getSharedUtterances(conversation.sessionId).map((turn) => turn.content)).toEqual(["hello"]);
    expect(store.getSharedRequest("cancel")?.status).toBe("interrupted");
  });
});
