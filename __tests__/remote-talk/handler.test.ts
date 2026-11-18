import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRemoteTalkHandler, type RemoteTalkRequest } from "../../src/remote-talk/handler";

const TOKEN = "f".repeat(32) + "0123456789abcdef0123456789abcdef";
const EXPIRES = Date.parse("2026-10-17T04:00:00Z");
const grants = [{ tokenSha256: createHash("sha256").update(TOKEN).digest("hex"), agent: "jade", caller: "jade@grok", expiresAt: EXPIRES }];

let calls: RemoteTalkRequest[];
let logs: string[];
let now: number;

function handler() {
  return createRemoteTalkHandler({
    grants,
    now: () => now,
    log: (line) => logs.push(JSON.stringify(line)),
    talk: async (request) => {
      calls.push(request);
      return new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
}

function post(path: string, body: unknown, token: string | null = TOKEN, raw = false): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`http://127.0.0.1:3710${path}`, { method: "POST", headers, body: raw ? String(body) : JSON.stringify(body) });
}

beforeEach(() => {
  calls = [];
  logs = [];
  now = Date.parse("2026-10-13T12:00:00Z");
});

test("other paths and methods → 404, talk not called", async () => {
  const h = handler();
  const requests = [
    new Request("http://127.0.0.1:3710/talk", { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }),
    post("/api/talk/bruno", { message: "hi" }),
    post("/api/vn/assets/delete", { name: "x" }),
    post("/talk/", { message: "hi" }),
  ];
  for (const request of requests) {
    expect((await h(request)).status).toBe(404);
  }
  expect(calls).toHaveLength(0);
});

test("unauthorized: missing header, wrong token, wrong scheme → 401, talk not called", async () => {
  const h = handler();
  for (const request of [
    post("/talk", { message: "hi" }, null),
    post("/talk", { message: "hi" }, "wrong-token"),
    new Request("http://127.0.0.1:3710/talk", { method: "POST", headers: { authorization: `Basic ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) }),
  ]) {
    const response = await h(request);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  }
  expect(calls).toHaveLength(0);
});

test("expired token → 401, talk not called", async () => {
  now = EXPIRES;
  const response = await handler()(post("/talk", { message: "hi" }));
  expect(response.status).toBe(401);
  expect(calls).toHaveLength(0);
});

test("slash command, empty or non-string message, invalid JSON → 400, talk not called", async () => {
  const h = handler();
  for (const request of [
    post("/talk", { message: "/clear" }),
    post("/talk", { message: "  /new" }),
    post("/talk", { message: "" }),
    post("/talk", { message: 42 }),
    post("/talk", "{not json", TOKEN, true),
  ]) {
    expect((await h(request)).status).toBe(400);
  }
  expect(calls).toHaveLength(0);
});

test("valid token → talk called once with the grant's agent and caller, body overrides ignored", async () => {
  const response = await handler()(post("/talk", { message: "hi", mode: "auto", addressee: "bruno", model: "x", imageData: "data:image/png;base64,AA", agent: "bruno" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(calls).toEqual([{ agent: "jade", caller: "jade@grok", message: "hi" }]);
});

test("the raw token never appears in a log line", async () => {
  const h = handler();
  await h(post("/talk", { message: "hi" }));
  await h(post("/talk", { message: "hi" }, "wrong-token"));
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.some((line) => line.includes(TOKEN))).toBe(false);
});
