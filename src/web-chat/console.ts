import page from "./console/page.html.txt" with { type: "text" };
import style from "./console/style.css.txt" with { type: "text" };
import script from "./console/app.js.txt" with { type: "text" };
import { ConsoleAuth, consoleOrigin } from "./console-auth";
import { OperatorController } from "./operator";
import { WebChatService } from "./service";
import { acquireBridgeLock, readConfig } from "./config";
import { BrowserProcess } from "./browser-process";
import { readFileSync } from "node:fs";

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function body(
  request: Request,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new HttpFailure(415, "JSON required");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (reader)
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 300_000) {
          await reader.cancel();
          throw new HttpFailure(413, "request body too large");
        }
        chunks.push(value);
      }
  } finally {
    reader?.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpFailure(400, "invalid JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new HttpFailure(400, "unexpected request fields");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new HttpFailure(400, "string required");
  return value;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });

/** Operator-only HTTP composition. Never mounted on the unauthenticated ANIMA UI. */
export function createConsoleHandler(options: {
  root: string;
  origin: string;
  allowRemote?: boolean;
  service: WebChatService;
  operator: OperatorController;
}) {
  const auth = new ConsoleAuth(options);
  const expected = new URL(options.origin);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.origin !== expected.origin ||
      request.headers.get("host") !== expected.host ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== expected.origin)
    )
      return json({ error: "foreign console request" }, 403);
    const asset = (
      {
        "/": [page, "text/html"],
        "/console.css": [style, "text/css"],
        "/console.js": [script, "text/javascript"],
      } as Record<string, string[]>
    )[url.pathname];
    if (asset && request.method === "GET")
      return new Response(asset[0], {
        headers: {
          "content-type": asset[1]! + "; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        },
      });
    if (!url.pathname.startsWith("/api/"))
      return json({ error: "not found" }, 404);
    if (url.pathname === "/api/login") return auth.login(request);
    const session = auth.authorize(request);
    if (session instanceof Response) return session;
    // Every bootstrap-authenticated session represents this root's one operator.
    // Cookie expiry must not orphan durable requests or their recovery controls.
    const owner = { agent: "operator-console", session: "operator" };
    const service = options.service;
    try {
      if (url.pathname === "/api/logout") {
        if (request.method !== "POST")
          throw new HttpFailure(405, "POST required");
        await body(request, []);
        await options.operator.releaseOwner(session.id);
        return auth.logout(request);
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/session")
          return json({ csrf: session.csrf, expiresAt: session.expiresAt });
        if (url.pathname === "/api/accounts") return json(service.list());
        if (url.pathname === "/api/history")
          return json(service.history(owner));
        const match = /^\/api\/requests\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        if (match)
          return json(
            service.result(
              owner,
              match[1]!,
              Number(url.searchParams.get("after") ?? 0),
            ),
          );
      } else if (request.method === "POST") {
        if (url.pathname === "/api/conversations") {
          const input = await body(request, ["account"]);
          return json(service.create(owner, text(input.account)));
        }
        if (url.pathname === "/api/send") {
          const input = await body(request, [
            "conversationId",
            "retryKey",
            "prompt",
          ]);
          return json(
            service.send(owner, {
              conversationId: text(input.conversationId),
              retryKey: text(input.retryKey),
              prompt: text(input.prompt),
            }),
          );
        }
        const action =
          /^\/api\/requests\/([a-zA-Z0-9_-]+)\/(cancel|reconcile)$/.exec(
            url.pathname,
          );
        if (action) {
          await body(request, []);
          return json(
            action[2] === "cancel"
              ? service.cancel(owner, action[1]!)
              : await service.reconcile(owner, action[1]!),
          );
        }
        const account =
          /^\/api\/accounts\/([a-zA-Z0-9_-]+)\/(login|finish-login|validate)$/.exec(
            url.pathname,
          );
        if (account) {
          if (account[2] === "validate") {
            const input = await body(request, ["prompt", "planTier"]);
            return json(
              await options.operator.validate(session.id, account[1]!, {
                prompt: text(input.prompt),
                planTier: text(input.planTier),
              }),
            );
          }
          await body(request, []);
          if (account[2] === "login")
            return json(
              await options.operator.startLogin(session.id, account[1]!),
            );
          await options.operator.finishLogin(session.id, account[1]!);
          return json({ finished: true, verified: false });
        }
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof HttpFailure)
        return json({ error: error.message }, error.status);
      const message = error instanceof Error ? error.message : "";
      // Never serialize arbitrary filesystem, browser or transport errors.
      if (/owner denied/.test(message))
        return json({ error: "owner denied" }, 403);
      const known =
        /^(account|conversation|request|bridge|operator console|unknown configured account|invalid |retry |queue |validation |egress denied)/;
      return json(
        {
          error: known.test(message)
            ? message
            : "operation failed; inspect local console state",
        },
        400,
      );
    }
  };
}

/** Explicit standalone entrypoint: does not read or inherit an agent signing key. */
export async function startConsole(options: {
  root: string;
  port?: number;
  host?: string;
  origin?: string;
}) {
  const port = options.port ?? 3080;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw Error("invalid console port");
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host))
    throw Error("invalid console host; use 127.0.0.1 or 0.0.0.0");
  const allowRemote = host === "0.0.0.0";
  if (allowRemote && (!options.origin || port === 0))
    throw Error("remote console requires --origin and a fixed --port");
  if (options.origin) {
    const origin = consoleOrigin(options.origin, allowRemote);
    if (Number(origin.port || 80) !== port)
      throw Error("console origin port must match listener port");
  }
  const release = acquireBridgeLock(options.root);
  let browser: BrowserProcess | undefined;
  let service: WebChatService | undefined;
  let operator: OperatorController | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      let failure: unknown;
      try {
        for (const cleanup of [
          () => server?.stop(true),
          () => operator?.shutdown(),
          () => service?.shutdown(),
          () => browser?.shutdown(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failure ??= error;
          }
        }
      } finally {
        release();
      }
      if (failure) throw failure;
    })());
  try {
    const config = readConfig(options.root);
    browser = new BrowserProcess({
      root: options.root,
      accounts: config.accounts,
    });
    service = new WebChatService({
      root: options.root,
      accounts: config.accounts,
      limits: config.limits,
      browser,
    });
    for (const path of config.privateSources) {
      const bytes = readFileSync(path);
      if (bytes.length > 1_000_000) throw Error("private source too large");
      service.registerPrivateContent(bytes.toString("utf8"));
    }
    operator = new OperatorController({
      root: options.root,
      config,
      service,
      browser,
    });
    let handler!: ReturnType<typeof createConsoleHandler>;
    server = Bun.serve({
      hostname: host,
      port,
      idleTimeout: 0,
      maxRequestBodySize: 300_000,
      fetch: (request) => handler(request),
    });
    const url = options.origin ?? `http://127.0.0.1:${server.port}`;
    handler = createConsoleHandler({
      root: options.root,
      origin: url,
      allowRemote,
      service,
      operator,
    });
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
