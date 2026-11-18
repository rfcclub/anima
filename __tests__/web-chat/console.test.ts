import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleHandler } from "../../src/web-chat/console";
import { OperatorController } from "../../src/web-chat/operator";
import { WebChatService } from "../../src/web-chat/service";
import { ADAPTER_VERSION, BrowserFailure } from "../../src/web-chat/types";
import type { BridgeConfig } from "../../src/web-chat/config";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup(uncertain = false) {
  const root = mkdtempSync(join(tmpdir(), "console-http-"));
  const config: BridgeConfig = {
    accounts: [
      {
        id: "gpt",
        service: "chatgpt",
        validatedVersion: ADAPTER_VERSION,
        validatedService: "chatgpt",
      },
      { id: "claude", service: "claude" },
    ],
    privateSources: [],
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  let effects = 0;
  const browser = {
    run: async () => {
      effects++;
      if (uncertain) throw new BrowserFailure("unknown_submission", false);
      return {
        text: "<script>unsafe()</script>",
        turnId: "new",
        url: "https://chatgpt.com/c/fixture",
      };
    },
    close: async () => {},
    login: async () => {
      effects++;
    },
    finishLogin: async () => {},
  };
  let service = new WebChatService({
    root,
    accounts: config.accounts,
    browser,
  });
  let operator = new OperatorController({ root, config, service, browser });
  let handler!: (request: Request) => Promise<Response>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler(request),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  handler = createConsoleHandler({ root, origin, service, operator });
  cleanups.push(async () => {
    await server.stop(true);
    await operator.shutdown();
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (
    path: string,
    body?: unknown,
    session?: { cookie: string; csrf: string },
    extra: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(session
          ? { cookie: session.cookie, "x-console-csrf": session.csrf }
          : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async () => {
    const token = readFileSync(join(root, "operator-token"), "utf8").trim();
    const response = await call("/api/login", { token });
    expect(response.status).toBe(200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      csrf: (await response.json()).csrf,
    };
  };
  const restart = async () => {
    await operator.shutdown();
    await service.shutdown();
    service = new WebChatService({ root, accounts: config.accounts, browser });
    operator = new OperatorController({ root, config, service, browser });
    handler = createConsoleHandler({ root, origin, service, operator });
  };
  return {
    root,
    service,
    call,
    login,
    origin,
    restart,
    effects: () => effects,
  };
}

test("recovery-relogin: uncertain chat survives logout, reauthentication and service restart", async () => {
  const s = setup(true);
  let session = await s.login();
  const conversation = await (
    await s.call("/api/conversations", { account: "gpt" }, session)
  ).json();
  const request = await (
    await s.call(
      "/api/send",
      {
        conversationId: conversation.id,
        retryKey: "uncertain",
        prompt: "public fixture",
      },
      session,
    )
  ).json();
  for (let i = 0; i < 100; i++) {
    const result = await (
      await s.call(`/api/requests/${request.id}`, undefined, session)
    ).json();
    if (result.state === "unknown_submission") break;
    await Bun.sleep(10);
  }
  await s.call("/api/logout", {}, session);
  session = await s.login();
  let history = await (await s.call("/api/history", undefined, session)).json();
  expect(history.requests.map((r: any) => r.id)).toContain(request.id);
  await s.restart();
  expect((await s.call("/api/history", undefined, session)).status).toBe(401);
  session = await s.login();
  history = await (await s.call("/api/history", undefined, session)).json();
  expect(history.requests.map((r: any) => r.id)).toContain(request.id);
  expect(
    (await s.call(`/api/requests/${request.id}`, undefined, session)).status,
  ).toBe(200);
  expect(s.effects()).toBe(1);
});

test("SC-1/SC-5: HTTP API guards precede effects and private-root files are never served", async () => {
  const s = setup();
  expect((await s.call("/api/accounts")).status).toBe(401);
  expect((await s.call("/api/accounts/claude/login", {})).status).toBe(401);
  expect(s.effects()).toBe(0);
  for (const headers of [
    { origin: "https://evil.test" },
    { host: "evil.test" },
  ]) {
    expect(
      (await s.call("/api/accounts/claude/login", {}, undefined, headers))
        .status,
    ).toBe(403);
    expect(s.effects()).toBe(0);
  }
  const session = await s.login();
  expect((await s.call("/api/accounts", undefined, session)).status).toBe(200);
  expect(
    (
      await s.call(
        "/api/conversations",
        { account: "gpt", agent: "forged" },
        session,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await s.call("/api/accounts/claude/login", {}, session, {
        "x-console-csrf": "wrong",
      })
    ).status,
  ).toBe(403);
  for (const path of [
    "/operator-token",
    "/profiles/gpt/Cookies",
    "/state.db",
    "/api/evaluate",
    "/api/cookies",
  ])
    expect((await s.call(path, undefined, session)).status).toBe(404);
  const oversized = await s.call(
    "/api/conversations",
    { account: "x".repeat(300_001) },
    session,
  );
  expect(oversized.status).toBe(413);
  expect(s.effects()).toBe(0);
});

test("SC-2/SC-5: real HTTP chat uses server ownership and stable retry keys across duplicate requests", async () => {
  const s = setup();
  const session = await s.login();
  const other = await s.login();
  const created = await s.call(
    "/api/conversations",
    { account: "gpt" },
    session,
  );
  expect(created.status).toBe(200);
  const conversation = await created.json();
  const body = {
    conversationId: conversation.id,
    retryKey: "stable",
    prompt: "public test",
  };
  const first = await (await s.call("/api/send", body, session)).json();
  const duplicate = await (await s.call("/api/send", body, session)).json();
  expect(duplicate.id).toBe(first.id);
  let result: any;
  for (let i = 0; i < 100; i++) {
    result = await (
      await s.call(`/api/requests/${first.id}`, undefined, session)
    ).json();
    if (result.state === "completed") break;
    await Bun.sleep(10);
  }
  expect(result.answer).toBe("<script>unsafe()</script>");
  expect(s.effects()).toBe(1);
  expect(
    (await s.call(`/api/requests/${first.id}`, undefined, other)).status,
  ).toBe(200);
  const foreign = s.service.create(
    { agent: "foreign", session: "agent-session" },
    "gpt",
  );
  expect(
    (
      await s.call(
        "/api/send",
        { ...body, conversationId: foreign.id, retryKey: "foreign" },
        other,
      )
    ).status,
  ).toBe(403);
  const history = await (
    await s.call("/api/history", undefined, session)
  ).json();
  expect(history.requests.map((r: any) => r.id)).toContain(first.id);
  expect(history.requests[0].prompt).toBeUndefined();
  expect(
    (await s.call("/api/session", undefined, session)).headers.get(
      "cache-control",
    ),
  ).toBe("no-store");
});

test("SC-3: Connect exposes only configured-account login and explicit validation", async () => {
  const s = setup();
  const session = await s.login();
  expect(
    (await s.call("/api/accounts/missing/login", {}, session)).status,
  ).toBe(400);
  expect(
    (
      await s.call(
        "/api/accounts/claude/login",
        { url: "https://evil.test" },
        session,
      )
    ).status,
  ).toBe(400);
  expect((await s.call("/api/accounts/claude/login", {}, session)).status).toBe(
    200,
  );
  expect(s.effects()).toBe(1);
  expect(s.service.list().find((a) => a.account === "claude")!.reason).toBe(
    "maintenance",
  );
  const other = await s.login();
  expect(
    (await s.call("/api/accounts/claude/finish-login", {}, other)).status,
  ).toBe(403);
  expect(
    (await s.call("/api/accounts/claude/finish-login", {}, session)).status,
  ).toBe(200);
  expect(s.service.list().find((a) => a.account === "claude")!.available).toBe(
    false,
  );
  expect((await s.call("/api/logout", {}, session)).status).toBe(200);
  expect((await s.call("/api/accounts", undefined, session)).status).toBe(401);
});
