import { expect, test } from "bun:test";
import { enqueue, flush, messagesFor, readTelegramEnv, telegramTransport } from "./alerts.ts";
import type { State } from "./types.ts";

const empty = (): State => ({
  version: 1,
  failCount: {},
  incidents: {},
  restarts: {},
  runSamples: {},
  presenceSince: {},
  queue: [],
});

const fs = (contents?: string) => ({ read: (_path: string) => contents }) as Parameters<typeof readTelegramEnv>[0];

const open = (key = "mesh.join|node-a", reason = "not joined") => ({ kind: "opened" as const, key, reason });
const recovered = (key = "mesh.join|node-a") => ({ kind: "closed" as const, key, reason: "recovered" });

test("SC-017: an incident and its recovery each send once", async () => {
  let state = enqueue(empty(), messagesFor([open()], [], []));
  const sent: string[] = [];
  const transport = { send: async (text: string) => { sent.push(text); } };
  const first = await flush(state, transport, false);
  state = enqueue(first.state, messagesFor([recovered()], [], []));
  const second = await flush(state, transport, false);
  const third = await flush(second.state, transport, false);
  expect(sent).toEqual(["INCIDENT mesh.join|node-a: not joined", "RECOVERED mesh.join|node-a"]);
  expect(first.sent).toBe(1);
  expect(second.sent).toBe(1);
  expect(third.sent).toBe(0);
  expect(third.state.queue).toEqual([]);
});

test("SC-018: dry run shows outgoing lines without sending or changing the queue", async () => {
  const state = enqueue(empty(), messagesFor([open()], [], []));
  const result = await flush(state, { send: async () => { throw new Error("must not send"); } }, true);
  expect(result.sent).toBe(0);
  expect(result.lines).toEqual(["DRY-RUN INCIDENT mesh.join|node-a: not joined"]);
  expect(result.state.queue).toEqual(state.queue);
});

test("SC-019: a failed send keeps that message and later messages for the next flush", async () => {
  let state = enqueue(empty(), messagesFor([open("a", "one"), open("b", "two"), open("c", "three")], [], []));
  let attempts = 0;
  const flaky = { send: async (_text: string) => { attempts++; if (attempts === 2) throw new Error("offline"); } };
  const first = await flush(state, flaky, false);
  state = first.state;
  expect(first.sent).toBe(1);
  expect(state.queue.map((item) => item.key)).toEqual(["b", "c"]);
  const sent: string[] = [];
  const next = await flush(state, { send: async (text) => { sent.push(text); } }, false);
  expect(sent).toEqual(["INCIDENT b: two", "INCIDENT c: three"]);
  expect(next.state.queue).toEqual([]);
});

test("SC-020: a recovery cancels an opening alert that has not been sent", () => {
  const queued = enqueue(empty(), messagesFor([open(), recovered()], [], []));
  expect(queued.queue).toEqual([]);
});

test("SC-020 regression: cancelling a later unsent incident preserves an older queued recovery", async () => {
  const key = "mesh.join|node-a";
  const delivered = await flush(enqueue(empty(), messagesFor([open(key)], [], [])), { send: async () => {} }, false);
  const failedRecovery = await flush(
    enqueue(delivered.state, messagesFor([recovered(key)], [], [])),
    { send: async () => { throw new Error("offline"); } },
    false,
  );
  const queuedAgain = enqueue(failedRecovery.state, messagesFor([open(key), recovered(key)], [], []));
  expect(queuedAgain.queue).toEqual([{ kind: "recovered", key, text: `RECOVERED ${key}` }]);

  const sent: string[] = [];
  const recoveredFlush = await flush(queuedAgain, { send: async (text) => { sent.push(text); } }, false);
  expect(sent).toEqual([`RECOVERED ${key}`]);
  expect(recoveredFlush.state.queue).toEqual([]);
});

test("SC-021: token-like text is redacted in messages, dry runs, and transport input", async () => {
  const token = "A".repeat(40);
  let state = enqueue(empty(), messagesFor([open("incident", `bad ${token}`)], [], []));
  expect(state.queue[0]?.text).not.toContain(token);
  const dry = await flush(state, null, true);
  expect(dry.lines.join("\n")).not.toContain(token);
  let requestBody: unknown;
  const transport = telegramTransport({ token, chat: "123" }, async (input, init) => {
    expect(String(input)).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    requestBody = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  });
  await transport.send(state.queue[0]!.text);
  expect(JSON.stringify(requestBody)).not.toContain(token);
  expect(JSON.stringify(requestBody)).toContain("[redacted]");

  const rejected = telegramTransport({ token, chat: "123" }, async () => {
    const error = new Error("network failed");
    Object.assign(error, { path: `https://api.telegram.org/bot${token}/sendMessage` });
    throw error;
  });
  let errorText = "";
  try { await rejected.send("hello"); } catch (error) { errorText = `${String(error)} ${JSON.stringify(error)}`; }
  expect(errorText).not.toContain(token);
});

test("SC-021 regression: a rejected fetch cannot expose a token in its error fields", async () => {
  const token = "secret-token-value";
  const transport = telegramTransport({ token, chat: "123" }, async () => {
    const error = new Error("fetch failed");
    Object.assign(error, { path: `https://api.telegram.org/bot${token}/sendMessage` });
    throw error;
  });
  let errorText = "";
  try { await transport.send("hello"); } catch (error) { errorText = `${String(error)} ${JSON.stringify(error)}`; }
  expect(errorText).not.toContain(token);
});

test("SC-021 regression: a long done entry cannot consume the incident-reason budget", () => {
  const messages = messagesFor([open("k", "database is down")], [], ["x".repeat(1000)]);
  expect(messages[0]?.text).toContain("database is down");
  expect(messages[0]!.text.length).toBeLessThanOrEqual(400);
});

test("SC-021 regression: redaction never merges distinct incident identities", () => {
  const firstKey = "claim|00000000-0000-4000-8000-000000000001";
  const secondKey = "claim|00000000-0000-4000-8000-000000000002";
  let state = enqueue(empty(), messagesFor([open(firstKey), open(secondKey)], [], []));
  expect(state.queue.map((message) => message.key)).toEqual([firstKey, secondKey]);
  state = enqueue(state, messagesFor([recovered(secondKey)], [], []));
  expect(state.queue.map((message) => message.key)).toEqual([firstKey]);
});

test("SC-021 regression: action alert identities are stable hashes without sensitive labels", () => {
  const action = { kind: "alert-cap", label: "A".repeat(40) };
  const first = messagesFor([], [action], []);
  const second = messagesFor([], [action], []);
  expect(first[0]?.key).toMatch(/^cap\|[a-f0-9]{64}$/);
  expect(first[0]?.key).toBe(second[0]?.key);
  expect(first[0]?.key).not.toContain(action.label);
  expect(first[0]?.text).not.toContain(action.label);
});

test("readTelegramEnv: parses quoted values", () => {
  expect(readTelegramEnv(fs('TELEGRAM_BOT_TOKEN="abc:123"\nTELEGRAM_CHAT_ID=\'chat-7\'\n'), "env")).toEqual({ token: "abc:123", chat: "chat-7" });
});

test("readTelegramEnv: returns null when a key is missing or the file is unreadable", () => {
  expect(readTelegramEnv(fs("TELEGRAM_BOT_TOKEN=abc\n"), "env")).toBeNull();
  expect(readTelegramEnv({ read: () => { throw new Error("unreadable"); } } as Parameters<typeof readTelegramEnv>[0], "env")).toBeNull();
});

test("telegramTransport: posts the exact URL and JSON body", async () => {
  let actualUrl = "";
  let actualBody: unknown;
  const transport = telegramTransport({ token: "bot-token", chat: "chat-id" }, async (input, init) => {
    actualUrl = String(input);
    actualBody = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  });
  await transport.send("hello");
  expect(actualUrl).toBe("https://api.telegram.org/botbot-token/sendMessage");
  expect(actualBody).toEqual({ chat_id: "chat-id", text: "hello" });
});

test("telegramTransport: non-2xx errors omit the token", async () => {
  const transport = telegramTransport({ token: "sensitive-token", chat: "chat" }, async () => new Response("no", { status: 400 }));
  await expect(transport.send("hello")).rejects.toThrow("Telegram answered 400");
  await expect(transport.send("hello")).rejects.not.toThrow("sensitive-token");
});
