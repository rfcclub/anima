import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { A2AStore } from "../src/memory/a2a-store";
import {
  createA2ATools,
  type A2AToolContext,
} from "../src/tools/a2a";

let tmpDir: string;
let store: A2AStore;
let ctx: A2AToolContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "a2a-tools-test-"));
  store = new A2AStore(join(tmpDir, "test.db"));
  ctx = { store, agentName: "bruno" };
});

afterEach(async () => {
  store.close();
  await rm(tmpDir, { recursive: true, force: true });
});

test("send_message tool stores a message and returns confirmation", async () => {
  const tools = createA2ATools(ctx);
  const sendTool = tools.find((t) => t.name === "send_message");
  expect(sendTool).toBeDefined();

  const result = await sendTool!.handler({
    to: "lena",
    subject: "Test",
    body: "Hello from test",
  });

  const parsed = JSON.parse(result);
  expect(parsed.status).toBe("sent");
  expect(parsed.to).toBe("lena");
  expect(parsed.subject).toBe("Test");
  expect(parsed.id).toBeGreaterThan(0);

  // Verify it's actually stored in lena's inbox
  expect(store.countUnread("lena")).toBe(1);
  expect(store.countUnread("bruno")).toBe(0);
});

test("send_message with optional thread_id", async () => {
  const tools = createA2ATools(ctx);
  const sendTool = tools.find((t) => t.name === "send_message")!;

  const result = await sendTool.handler({
    to: "lena",
    subject: "RE: test",
    body: "Reply",
    thread_id: "abc-123",
  });

  const parsed = JSON.parse(result);
  expect(parsed.status).toBe("sent");
  expect(parsed.thread_id).toBe("abc-123");
});

test("send_message returns error on missing fields", async () => {
  const tools = createA2ATools(ctx);
  const sendTool = tools.find((t) => t.name === "send_message")!;

  const result = await sendTool.handler({
    to: "lena",
    subject: "Test",
  } as any);

  expect(result).toContain("error");
  expect(result).toContain("body");
});

test("read_inbox tool returns message list as JSON", async () => {
  // Set up messages from other agents to bruno
  store.send({ from: "lena", to: "bruno", subject: "Msg1", body: "One" });
  store.send({ from: "lena", to: "bruno", subject: "Msg2", body: "Two" });

  const tools = createA2ATools(ctx);
  const inboxTool = tools.find((t) => t.name === "read_inbox")!;

  const result = await inboxTool.handler({ unread_only: false });
  const parsed = JSON.parse(result);

  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(2);
  expect(parsed[0].subject).toBe("Msg1");
  expect(parsed[1].subject).toBe("Msg2");
});

test("read_inbox tool with unread_only=true returns only unread", async () => {
  const msg1 = store.send({ from: "lena", to: "bruno", subject: "Read", body: "Already seen" });
  store.send({ from: "lena", to: "bruno", subject: "Unread", body: "New" });
  store.markRead("bruno", [msg1.id]);

  const tools = createA2ATools(ctx);
  const inboxTool = tools.find((t) => t.name === "read_inbox")!;

  // First with unread_only
  const unreadResult = await inboxTool.handler({ unread_only: true });
  const unreadParsed = JSON.parse(unreadResult);
  expect(unreadParsed).toHaveLength(1);
  expect(unreadParsed[0].subject).toBe("Unread");

  // Then without filter
  const allResult = await inboxTool.handler({ unread_only: false });
  const allParsed = JSON.parse(allResult);
  expect(allParsed).toHaveLength(2);
});

test("createA2ATools returns both tools with correct definitions", () => {
  const tools = createA2ATools(ctx);
  expect(tools).toHaveLength(2);

  const sendDef = tools.find((t) => t.name === "send_message")!;
  expect(sendDef.description).toBeDefined();
  expect(sendDef.parameters.properties.to).toBeDefined();
  expect(sendDef.parameters.properties.subject).toBeDefined();
  expect(sendDef.parameters.properties.body).toBeDefined();
  expect(sendDef.parameters.required).toContain("to");
  expect(sendDef.parameters.required).toContain("subject");
  expect(sendDef.parameters.required).toContain("body");

  const inboxDef = tools.find((t) => t.name === "read_inbox")!;
  expect(inboxDef.description).toBeDefined();
  expect(inboxDef.parameters.properties.unread_only).toBeDefined();
});

test("read_inbox returns empty array when no messages", async () => {
  const tools = createA2ATools(ctx);
  const inboxTool = tools.find((t) => t.name === "read_inbox")!;

  const result = await inboxTool.handler({});
  const parsed = JSON.parse(result);
  expect(parsed).toEqual([]);
});

test("send_message uses agentName from context as from_agent", async () => {
  const lenaCtx: A2AToolContext = { store, agentName: "lena" };
  const tools = createA2ATools(lenaCtx);
  const sendTool = tools.find((t) => t.name === "send_message")!;

  await sendTool.handler({ to: "bruno", subject: "From Lena", body: "Hey" });

  const incoming = store.readInbox("bruno");
  expect(incoming).toHaveLength(1);
  expect(incoming[0].from_agent).toBe("lena");
  expect(incoming[0].subject).toBe("From Lena");
});
