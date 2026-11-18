import { EliRuntime, type EliRecallInput, type EliRememberInput, type JoinEliInput } from "./runtime";
import { privateTransportSecurity, type SecurityProvider } from "./security";

export function startEliRuntimeHttp(runtime: EliRuntime, host: string, port: number, security: SecurityProvider = privateTransportSecurity): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: host,
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, identity: "eli" });
      if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
      if (!(await security.admit(request))) return Response.json({ error: "admission denied" }, { status: 401 });
      try {
        const body = await request.json();
        if (url.pathname === "/v1/join") {
          if (isRecord(body) && body.identity !== undefined && body.identity !== "eli") {
            return Response.json({ error: "this runtime admits Eli only" }, { status: 400 });
          }
          return Response.json(await runtime.join(body as JoinEliInput));
        }
        if (url.pathname === "/v1/continuity/remember") return Response.json(await runtime.remember(body as EliRememberInput));
        if (url.pathname === "/v1/continuity/recall") return Response.json(await runtime.recall(body as EliRecallInput));
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
