import { BrunoRuntime, type BrunoRememberInput, type JoinBrunoInput } from "./runtime.ts";
import { privateTransportSecurity, type SecurityProvider } from "../../eli-runtime/src/security.ts";
import { recall, type RecallDeps } from "./recall-dispatcher.ts";

export function startBrunoRuntimeHttp(
  runtime: BrunoRuntime,
  host: string,
  port: number,
  security: SecurityProvider = privateTransportSecurity,
  recallDeps: RecallDeps = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: host,
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, identity: "bruno" });
      if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
      if (!(await security.admit(request))) return Response.json({ error: "admission denied" }, { status: 401 });
      try {
        const body = await request.json();
        if (url.pathname === "/v1/join") {
          if (isRecord(body) && body.identity !== undefined && body.identity !== "bruno") {
            return Response.json({ error: "this runtime admits Bruno only" }, { status: 400 });
          }
          return Response.json(await runtime.join(body as JoinBrunoInput));
        }
        if (url.pathname === "/v1/continuity/remember") return Response.json(await runtime.remember(body as BrunoRememberInput));
        if (url.pathname === "/v1/continuity/recall") {
          if (!isRecord(body) || typeof body.query !== "string" || !body.query) {
            return Response.json({ error: "query is required" }, { status: 400 });
          }
          return Response.json(await recall(body.query, recallDeps));
        }
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "runtime request failed" }, { status: 409 });
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
