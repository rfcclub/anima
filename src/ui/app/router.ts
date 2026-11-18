import { existsSync, readFileSync } from "node:fs";
import { join, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { json } from "../utils/http";
import { serveStatic } from "../utils/static";
import { UI_DIR } from "../services/session-store";
import { handleMemoryHealth } from "../../api/memory/health";
import { handleApiLogs, DEFAULT_LOG_PATH } from "../../api/logs";
import { createLogStream } from "../../api/logs-stream";
import * as town from "../features/town/routes";
import * as vnAssets from "../features/vn-assets/routes";
import * as castle from "../features/castle/routes";
import * as cost from "../features/cost/routes";
import * as status from "../features/status/routes";
import * as work from "../features/work/routes";
import { checkRequest, guardConfig } from "./origin-guard";
import type { UIServerDeps } from "../types";

// Build version — read from ~/.anima/state/version.json (written by
// deploy.sh on each build). Lets the UI server answer /api/version so
// the browser can verify the running bundle matches the source.
function readBuildVersion(): { version: string; builtAt: string } {
  try {
    const p = pathJoin(homedir(), ".anima", "state", "version.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { version: "dev", builtAt: new Date().toISOString() };
  }
}

export async function handleUIRequest(req: Request, deps?: UIServerDeps): Promise<Response> {
  // Before any route: untrusted Host, foreign Origin and cross-site writes stop here.
  const refusal = checkRequest(req, deps?.guard ?? guardConfig(Number(Bun.env.ANIMA_UI_PORT ?? 3000), Bun.env));
  if (refusal) return refusal;

  const url = new URL(req.url);
  const { pathname } = url;

  try {
    if (pathname === "/api/version" && req.method === "GET") {
      const v = readBuildVersion();
      return json(v);
    }
    if (pathname === "/api/memory/health" && req.method === "GET") {
      return handleMemoryHealth();
    }
    if (pathname === "/api/logs" && req.method === "GET") {
      return handleApiLogs(req, DEFAULT_LOG_PATH);
    }
    if (pathname === "/api/logs/stream" && req.method === "GET") {
      return createLogStream(req, DEFAULT_LOG_PATH);
    }

    for (const feature of [town, vnAssets, castle, cost, status, work]) {
      const result = await feature.routes(req, pathname, deps);
      if (result) return result;
    }

    const staticResult = serveStatic(UI_DIR, pathname);
    if (staticResult) return staticResult;

    // SPA fallback: non-API, non-asset GET → serve index.html so the client
    // router handles the route (deep links + full-page refresh work).
    // Reject path-traversal attempts (.. segments) — never serve the shell for them.
    // Prefer the built bundle (UI_DIR/dist/index.html) if present; fall back to
    // the source index.html (dev mode, transpiled on the fly).
    if (req.method === "GET" && !pathname.startsWith("/api/") && !pathname.includes("/../") && !pathname.includes("/..")) {
      const builtIndex = join(UI_DIR, "dist", "index.html");
      const sourceIndex = join(UI_DIR, "index.html");
      const indexPath = existsSync(builtIndex) ? builtIndex : (existsSync(sourceIndex) ? sourceIndex : null);
      if (indexPath) {
        return new Response(Bun.file(indexPath), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    console.error("UI server error:", error);
    return json({ error: "internal_server_error" }, 500);
  }
}
