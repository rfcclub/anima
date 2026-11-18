import { createHash, timingSafeEqual } from "node:crypto";
import type { RemoteTalkGrant } from "./config";

/** What a remote turn receives. Agent and caller come from the grant, never from the request. */
export interface RemoteTalkRequest {
  agent: string;
  caller: string;
  message: string;
}

export interface RemoteTalkHandlerOptions {
  grants: RemoteTalkGrant[];
  talk: (request: RemoteTalkRequest) => Promise<Response>;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

/**
 * Request → Response for the remote talk listener. Serves only `POST /talk`.
 * Order: route (404) → token (401) → expiry (401) → body (400) → talk.
 * The token and the Authorization header are never logged.
 */
export function createRemoteTalkHandler(options: RemoteTalkHandlerOptions): (req: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const digests = options.grants.map((grant) => ({ grant, digest: Buffer.from(grant.tokenSha256, "hex") }));

  return async (req) => {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST" || pathname !== "/talk") {
      log({ event: "remote_talk", path: pathname, status: 404 });
      return new Response(null, { status: 404 });
    }

    const token = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const digest = token ? createHash("sha256").update(token).digest() : null;
    const match = digest ? digests.find((entry) => timingSafeEqual(entry.digest, digest)) : undefined;
    if (!match || now() >= match.grant.expiresAt) {
      log({ event: "remote_talk", path: pathname, status: 401, ...(match ? { caller: match.grant.caller, reason: "expired" } : {}) });
      return new Response(null, { status: 401 });
    }

    const { agent, caller } = match.grant;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      log({ event: "remote_talk", path: pathname, status: 400, caller });
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }
    const message = (body as { message?: unknown } | null)?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      log({ event: "remote_talk", path: pathname, status: 400, caller });
      return Response.json({ error: "message_required" }, { status: 400 });
    }
    if (message.trimStart().startsWith("/")) {
      log({ event: "remote_talk", path: pathname, status: 400, caller });
      return Response.json({ error: "slash_commands_not_allowed" }, { status: 400 });
    }

    log({ event: "remote_talk", path: pathname, status: 200, caller, agent });
    return options.talk({ agent, caller, message });
  };
}
