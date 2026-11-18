import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { A2AStore } from "../src/memory/a2a-store";

let tmpDir: string;
let store: A2AStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "a2a-test-"));
  store = new A2AStore(join(tmpDir, "test.db"));
});

afterEach(async () => {
  store.close();
  await rm(tmpDir, { recursive: true, force: true });
});

test("send inserts a message and returns it with an id and ts", () => {
  const msg = store.send({
    from: "bruno",
    to: "lena",
    subject: "Hello",
    body: "Test message",
  });

  expect(msg.id).toBeGreaterThan(0);
  expect(msg.from_agent).toBe("bruno");
  expect(msg.to_agent).toBe("lena");
  expect(msg.subject).toBe("Hello");
  expect(msg.body).toBe("Test message");
  expect(msg.read).toBe(0);
  expect(msg.ts).toBeDefined();
  expect(msg.thread_id).toBeNull();
});

test("send with thread_id stores the thread reference", () => {
  const msg = store.send({
    from: "bruno",
    to: "lena",
    subject: "RE: Hello",
    body: "Reply",
    thread_id: "abc-123",
  });

  expect(msg.thread_id).toBe("abc-123");
});

test("readInbox returns messages for an agent ordered by id", () => {
  store.send({ from: "bruno", to: "lena", subject: "First", body: "A" });
  store.send({ from: "bruno", to: "lena", subject: "Second", body: "B" });
  store.send({ from: "lena", to: "bruno", subject: "Reply", body: "C" });

  const lenaInbox = store.readInbox("lena");
  expect(lenaInbox).toHaveLength(2);
  expect(lenaInbox[0].subject).toBe("First");
  expect(lenaInbox[1].subject).toBe("Second");

  const brunoInbox = store.readInbox("bruno");
  expect(brunoInbox).toHaveLength(1);
  expect(brunoInbox[0].subject).toBe("Reply");
});

test("readInbox with unreadOnly=true only returns unread messages", () => {
  const msg1 = store.send({ from: "bruno", to: "lena", subject: "First", body: "A" });
  store.send({ from: "bruno", to: "lena", subject: "Second", body: "B" });

  store.markRead("lena", [msg1.id]);

  const unread = store.readInbox("lena", true);
  expect(unread).toHaveLength(1);
  expect(unread[0].subject).toBe("Second");
});

test("markRead sets read=1 for specified message ids", () => {
  const msg1 = store.send({ from: "bruno", to: "lena", subject: "First", body: "A" });
  const msg2 = store.send({ from: "bruno", to: "lena", subject: "Second", body: "B" });

  store.markRead("lena", [msg1.id, msg2.id]);

  const inbox = store.readInbox("lena");
  expect(inbox.every((m) => m.read === 1)).toBe(true);
});

test("countUnread returns number of unread messages for an agent", () => {
  store.send({ from: "bruno", to: "lena", subject: "A", body: "1" });
  store.send({ from: "bruno", to: "lena", subject: "B", body: "2" });

  expect(store.countUnread("lena")).toBe(2);
  expect(store.countUnread("bruno")).toBe(0);
});

test("countUnread decreases after markRead", () => {
  const msg = store.send({ from: "bruno", to: "lena", subject: "Test", body: "Body" });
  expect(store.countUnread("lena")).toBe(1);

  store.markRead("lena", [msg.id]);
  expect(store.countUnread("lena")).toBe(0);
});

test("readInbox with thread_id filter returns messages in a thread", () => {
  const threadId = "thread-1";
  store.send({ from: "bruno", to: "lena", subject: "Original", body: "Start", thread_id: threadId });
  store.send({ from: "lena", to: "bruno", subject: "RE: Original", body: "Reply", thread_id: threadId });

  const thread = store.readInbox("lena", false, threadId);
  expect(thread).toHaveLength(1);
});

test("persists messages across store instances", () => {
  store.send({ from: "bruno", to: "lena", subject: "Persist", body: "Check" });
  store.close();

  const store2 = new A2AStore(join(tmpDir, "test.db"));
  const inbox = store2.readInbox("lena");
  expect(inbox).toHaveLength(1);
  expect(inbox[0].subject).toBe("Persist");
  store2.close();
});

test("readInbox returns empty array for agent with no messages", () => {
  const inbox = store.readInbox("nonexistent");
  expect(inbox).toEqual([]);
});

test("countUnread returns 0 for agent with no messages", () => {
  expect(store.countUnread("nonexistent")).toBe(0);
});
