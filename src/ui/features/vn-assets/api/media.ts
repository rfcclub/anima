import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRoomsDir } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps } from "../../../types";

/** `public, max-age=3600` (the old value) told the browser to serve a
 *  cached copy for up to an hour with NO revalidation at all — a portrait
 *  or background reuploaded mid-session (a re-uploaded image kept showing the old
 *  version) stayed invisible until the
 *  hour elapsed or the tab got a hard refresh. `no-cache` (despite the
 *  name) still lets the browser cache the bytes — it just forces a
 *  conditional revalidation against `last-modified` on every load, so an
 *  unchanged file is a cheap 304 (no body) and a changed one is caught
 *  immediately. */
function fileHeaders(path: string, contentType: string): { "content-type": string; "cache-control": string; "last-modified": string } {
  return {
    "content-type": contentType,
    "cache-control": "no-cache",
    "last-modified": statSync(path).mtime.toUTCString(),
  };
}

/** 304 when the client's cached copy (`if-modified-since`) is still current
 *  for `path` — second-resolution compare, matching HTTP date precision. */
function notModified(req: Request | undefined, path: string): Response | null {
  const ifModifiedSince = req?.headers.get("if-modified-since");
  if (!ifModifiedSince) return null;
  const clientDate = Date.parse(ifModifiedSince);
  if (Number.isNaN(clientDate)) return null;
  const mtimeSec = Math.floor(statSync(path).mtimeMs / 1000);
  if (mtimeSec > Math.floor(clientDate / 1000)) return null;
  return new Response(null, { status: 304, headers: { "cache-control": "no-cache", "last-modified": statSync(path).mtime.toUTCString() } });
}

export function handleVNPortrait(agentId: string, emotion: string, _deps?: UIServerDeps, req?: Request): Response {
  const vnShared = join(defaultRoomsDir(), "_shared", "vn");
  const assetsDir = join(vnShared, "assets");

  // Supported formats in priority order (transparent formats first)
  const formats = ["gif", "png", "webp", "jpg", "jpeg"];
  const mimeTypes: Record<string, string> = {
    gif: "image/gif", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg",
  };

  // Try per-agent emotion portrait: portraits/bruno/neutral.{ext}
  for (const fmt of formats) {
    const emotionPath = join(assetsDir, "portraits", agentId, `${emotion}.${fmt}`);
    if (existsSync(emotionPath)) {
      return notModified(req, emotionPath) ?? new Response(Bun.file(emotionPath), {
        headers: fileHeaders(emotionPath, mimeTypes[fmt]),
      });
    }
  }

  // Fallback: portraits/bruno.{ext} (main portrait regardless of emotion)
  for (const fmt of formats) {
    const mainPath = join(assetsDir, "portraits", `${agentId}.${fmt}`);
    if (existsSync(mainPath)) {
      return notModified(req, mainPath) ?? new Response(Bun.file(mainPath), {
        headers: fileHeaders(mainPath, mimeTypes[fmt]),
      });
    }
  }

  return json({ error: "portrait_not_found", agentId, emotion }, 404);
}

export function handleVNBackground(sceneId: string, _deps?: UIServerDeps, req?: Request): Response {
  const vnShared = join(defaultRoomsDir(), "_shared", "vn");
  const assetsDir = join(vnShared, "assets");

  const formats = ["png", "webp", "jpg", "jpeg"];
  const mimeTypes: Record<string, string> = {
    png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg",
  };

  // Try backgrounds/<sceneId>.<ext>
  for (const fmt of formats) {
    const path = join(assetsDir, "backgrounds", `${sceneId}.${fmt}`);
    if (existsSync(path)) {
      return notModified(req, path) ?? new Response(Bun.file(path), {
        headers: fileHeaders(path, mimeTypes[fmt]),
      });
    }
  }

  // Try backgrounds/default.png as ultimate fallback
  for (const fmt of formats) {
    const path = join(assetsDir, "backgrounds", `default.${fmt}`);
    if (existsSync(path)) {
      return notModified(req, path) ?? new Response(Bun.file(path), {
        headers: fileHeaders(path, mimeTypes[fmt]),
      });
    }
  }

  return json({ error: "background_not_found", sceneId }, 404);
}
