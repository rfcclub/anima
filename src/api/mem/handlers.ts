// ---------------------------------------------------------------------------
// abel-mem HTTP API Handlers
// ---------------------------------------------------------------------------
// Five endpoints: POST /mem/store, POST /mem/recall, POST /mem/bootstrap,
// POST /mem/dream, GET /mem/health
// All except /mem/health require Bearer token auth with scope "abel".
// ---------------------------------------------------------------------------

import { authorizeRequest } from "../../services/abel-mem";
import type { AbelMemService } from "../../services/abel-mem";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Authorize a request. Returns a 403 Response if unauthorized, or null if OK.
 */
/**
 * Auth middleware for protected endpoints.
 * Returns a 403 Response if unauthorized, or null if OK.
 */
function requireAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization");
  if (!authorizeRequest(auth)) {
    return json({ error: "forbidden" }, 403);
  }
  return null;
}

export function createMemHandlers(service: AbelMemService) {
  return {
    /** POST /mem/store — store a memory entry */
    async handleStore(req: Request): Promise<Response> {
      const authErr = requireAuth(req);
      if (authErr) return authErr;

      try {
        const body = await req.json() as { content?: string; agent?: string; tags?: string[] };
        if (!body.content || !body.agent) {
          return json({ error: "content and agent required" }, 400);
        }

        const result = await service.store({
          content: body.content,
          agent: body.agent,
          timestamp: new Date().toISOString(),
          tags: body.tags,
        });

        return json(result);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    },

    /** POST /mem/recall — semantic memory recall */
    async handleRecall(req: Request): Promise<Response> {
      const authErr = requireAuth(req);
      if (authErr) return authErr;

      try {
        const body = await req.json() as { query?: string; topK?: number };
        if (!body.query) {
          return json({ error: "query required" }, 400);
        }

        const result = await service.recall({
          query: body.query,
          topK: body.topK ?? 10,
        });

        return json(result);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    },

    /** POST /mem/bootstrap — bootstrap a 2B instance */
    async handleBootstrap(req: Request): Promise<Response> {
      const authErr = requireAuth(req);
      if (authErr) return authErr;

      try {
        const body = await req.json() as { agent?: string };
        if (!body.agent) {
          return json({ error: "agent required" }, 400);
        }

        const result = await service.bootstrap({ agent: body.agent });
        return json(result);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    },

    /** POST /mem/dream — trigger dream cycle */
    async handleDream(req: Request): Promise<Response> {
      const authErr = requireAuth(req);
      if (authErr) return authErr;

      try {
        const body = await req.json() as { agent?: string; prompt?: string };
        if (!body.agent) {
          return json({ error: "agent required" }, 400);
        }

        const result = await service.dream({
          agent: body.agent,
          prompt: body.prompt,
        });
        return json(result);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    },

    /** GET /mem/health — health check (no auth required) */
    async handleHealth(_req: Request): Promise<Response> {
      const health = await service.health();
      return json(health);
    },
  };
}
