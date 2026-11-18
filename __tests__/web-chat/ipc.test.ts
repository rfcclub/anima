import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { startIpc, signedHeaders } from "../../src/web-chat/ipc";
import { WebChatClient } from "../../src/web-chat/client";
import { WebChatService } from "../../src/web-chat/service";
const roots: string[] = [],
  stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function start() {
  const root = mkdtempSync(join(tmpdir(), "webchat-ipc-"));
  roots.push(root);
  const key = randomBytes(32);
  const service = new WebChatService({
    root,
    accounts: [
      {
        id: "gpt",
        service: "chatgpt",
        validatedVersion: "test",
        validatedService: "chatgpt" as const,
      },
    ],
    adapterVersion: "test",
    browser: {
      run: async (c, p) => ({
        text: p,
        turnId: "1",
        url: "https://chatgpt.com/c/1",
      }),
      close: async () => {},
    },
  });
  const server = await startIpc({ root, key, service });
  stops.push(() => server.close());
  return {
    root,
    key,
    socket: join(root, "bridge.sock"),
    client: new WebChatClient(join(root, "bridge.sock"), key),
  };
}
async function post(
  socket: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return fetch("http://localhost/rpc", {
    method: "POST",
    body,
    headers,
    unix: socket,
  } as RequestInit);
}
test("WB-4: real private Unix IPC authenticates and rejects replay/forgery", async () => {
  const x = await start();
  expect(statSync(x.socket).mode & 0o777).toBe(0o600);
  const body = JSON.stringify({
    owner: { agent: "finn", session: "s" },
    operation: "list",
  });
  expect((await post(x.socket, body)).status).toBe(401);
  const headers = signedHeaders(x.key, body);
  expect((await post(x.socket, body, headers)).status).toBe(200);
  expect((await post(x.socket, body, headers)).status).toBe(409);
  expect(
    (await post(x.socket, body + " ", signedHeaders(x.key, body))).status,
  ).toBe(401);
  expect(
    (
      await post(
        x.socket,
        body,
        signedHeaders(x.key, body, Date.now() - 31_000),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await x.client.call(
        { agent: "finn", session: "s" },
        { operation: "create", account: "gpt" },
      )
    ).account,
  ).toBe("gpt");
  const forged = JSON.stringify({
    owner: { agent: "finn", session: "s" },
    operation: "create",
    account: "gpt",
    profile: "/tmp",
  });
  expect(
    (await post(x.socket, forged, signedHeaders(x.key, forged))).status,
  ).toBe(400);
});
test("WB-4: body bound and owner binding survive transport", async () => {
  const x = await start(),
    owner = { agent: "finn", session: "a" },
    other = { agent: "finn", session: "b" };
  const c = await x.client.call(owner, { operation: "create", account: "gpt" });
  await expect(
    x.client.call(other, {
      operation: "send",
      conversationId: c.id,
      retryKey: "1",
      prompt: "one",
    }),
  ).rejects.toThrow("owner");
  const body = "x".repeat(65537);
  expect((await post(x.socket, body, signedHeaders(x.key, body))).status).toBe(
    413,
  );
});
test("WB-4: startup refuses a second live bridge", async () => {
  const x = await start();
  await expect(
    startIpc({ root: x.root, key: x.key, service: {} as any }),
  ).rejects.toThrow("owned");
});

test("SC-4: signed agent IPC has no operator console or maintenance operations", async () => {
  const x = await start();
  for (const operation of [
    "login",
    "finish-login",
    "validate",
    "history",
    "acquireMaintenance",
    "console",
    "cookies",
    "evaluate",
  ]) {
    const body = JSON.stringify({
      owner: { agent: "finn", session: "s" },
      operation,
      account: "gpt",
    });
    expect(
      (await post(x.socket, body, signedHeaders(x.key, body))).status,
    ).toBe(400);
  }
});
