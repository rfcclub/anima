import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { coreGuardConfig, startCoreHttpServer, withCoreGuard } from "../../../src/core-http";
import { TelegramGateway } from "../../../src/channels/telegram-gateway";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const config = coreGuardConfig(3700, {});
const localRequest = (path: string, method = "POST", extra: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:3700${path}`, {
    method, headers: { host: "127.0.0.1:3700", ...extra },
    ...(method === "POST" ? { body: "{}" } : {}),
  });

test("CORE-1 binds loopback by default and respects explicit opt-in", () => {
  for (const [env, hostname] of [[{}, "127.0.0.1"], [{ ANIMA_CORE_HOST: "0.0.0.0" }, "0.0.0.0"]] as const) {
    const server = startCoreHttpServer(() => new Response("ok"), { port: 0, env });
    servers.push(server);
    expect(server.hostname).toBe(hostname);
  }
});

describe("CORE-2 protects every privileged route before dispatch", () => {
  for (const path of ["/dream", "/reflection/tick", "/ai/v1/chat/completions", "/colony/reflect", "/pulse-anima/force-tick", "/internal/continuity/eli", "/api/mesh/notify", "/webhook/telegram"]) {
    test(path, async () => {
      let calls = 0;
      const handler = withCoreGuard(() => { calls++; return new Response("must not run"); }, config);
      for (const headers of [{ origin: "http://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
        expect((await handler(localRequest(path, "POST", headers))).status).toBe(403);
      }
      expect((await handler(localRequest(path, "POST", { origin: "not a URL" }))).status).toBe(400);
      expect(calls).toBe(0);
    });
  }
});

test("CORE-3 allows Origin-less local callers and same-origin browser mutations", async () => {
  let calls = 0;
  const handler = withCoreGuard(() => { calls++; return new Response("ok"); }, config);
  expect((await handler(localRequest("/reflection/tick"))).status).toBe(200);
  expect((await handler(localRequest("/dream", "POST", { origin: "http://127.0.0.1:3700" }))).status).toBe(200);
  expect(calls).toBe(2);
});

test("CORE-4 refuses hostile or missing Host for safe and unsafe methods", async () => {
  let calls = 0;
  const handler = withCoreGuard(() => { calls++; return new Response("bad"); }, config);
  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
    for (const headers of [{}, { host: "evil.example:3700" }]) {
      expect((await handler(new Request("http://127.0.0.1:3700/health", { method, headers }))).status).toBe(403);
    }
  }
  expect(calls).toBe(0);
});

test("CORE-5 real listener keeps health and continuity callers reachable", async () => {
  const paths: string[] = [];
  const server = startCoreHttpServer(req => { paths.push(new URL(req.url).pathname); return Response.json({ ok: true }); }, { port: 0, env: {} });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await fetch(`${base}/internal/continuity/eli`, { method: "POST", body: "{}" })).status).toBe(200);
  expect((await fetch(`${base}/dream`, { method: "POST", headers: { origin: base }, body: "{}" })).status).toBe(200);
  expect((await fetch(`${base}/dream`, { method: "POST", headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect((await fetch(`${base}/health`, { headers: { host: "evil.example" } })).status).toBe(403);
  expect(paths).toEqual(["/health", "/internal/continuity/eli", "/dream"]);
});

test("CORE-6 real Telegram secret validation stays behind the Host guard", async () => {
  const gateway = new TelegramGateway({ botToken: "fixture-not-a-token", webhookSecret: "fixture-secret" });
  let calls = 0;
  const server = startCoreHttpServer(req => { calls++; return gateway.handleWebhook(req); }, { port: 0, env: {} });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}/webhook/telegram`;
  // No message => no model call, outbound Telegram request or process start.
  for (const [headers, status] of [
    [{ "x-telegram-bot-api-secret-token": "fixture-secret" }, 200],
    [{}, 401],
    [{ "x-telegram-bot-api-secret-token": "wrong" }, 401],
    [{ host: "evil.example", "x-telegram-bot-api-secret-token": "fixture-secret" }, 403],
  ] as const) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ update_id: 1 }) });
    expect(res.status).toBe(status);
  }
  expect(calls).toBe(3);
});

test("CORE-1 core origin settings are independent of UI and scheme/port stay exact", async () => {
  const core = coreGuardConfig(3700, { ANIMA_CORE_ALLOWED_ORIGINS: "https://core.example", ANIMA_UI_ALLOWED_ORIGINS: "https://ui.example" });
  const handler = withCoreGuard(() => new Response("ok"), core);
  expect((await handler(localRequest("/dream", "POST", { host: "core.example", origin: "https://core.example" }))).status).toBe(200);
  for (const headers of [
    { host: "ui.example", origin: "https://ui.example" },
    { host: "core.example", origin: "http://core.example" },
    { host: "core.example:444", origin: "https://core.example:444" },
  ]) expect((await handler(localRequest("/dream", "POST", headers))).status).toBe(403);
});

// Verify the listening socket rather than Bun's hostname metadata: empty bind
// reports localhost while accepting non-loopback connections on affected Bun.
const hostAddress = Object.values(networkInterfaces()).flat().find(a => a && !a.internal && a.family === "IPv4")?.address;
test.skipIf(!hostAddress)("CORE-1 regression: blank/whitespace bind never accepts this host's non-loopback address", async () => {
  const wildcard = startCoreHttpServer(() => new Response("control"), { port: 0, env: { ANIMA_CORE_HOST: "0.0.0.0" } });
  servers.push(wildcard);
  const request = (port: number) => fetch(`http://${hostAddress}:${port}/health`, { headers: { host: `127.0.0.1:${port}` }, signal: AbortSignal.timeout(1500) });
  expect((await request(wildcard.port!)).status).toBe(200);
  for (const value of ["", " ", "\t\n"]) {
    const server = startCoreHttpServer(() => new Response("must stay local"), { port: 0, env: { ANIMA_CORE_HOST: value } });
    servers.push(server);
    expect(await fetch(`http://127.0.0.1:${server.port}/health`).then(r => r.status)).toBe(200);
    await expect(request(server.port!)).rejects.toThrow();
  }
});
