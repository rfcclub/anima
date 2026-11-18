import { existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { defaultRoomsDir } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps } from "../../../types";


export async function handleVNAssets(_deps?: UIServerDeps): Promise<Response> {
  const vnShared = join(defaultRoomsDir(), "_shared", "vn");
  const assetsDir = join(vnShared, "assets");

  function listDir(rel: string): string[] {
    const full = join(assetsDir, rel);
    if (!existsSync(full)) return [];
    try {
      return readdirSync(full).filter((f) => !f.startsWith("."));
    } catch {
      return [];
    }
  }

  return json({
    portraits: listDir("portraits").filter((f) => f.endsWith(".png") || f.endsWith(".webp") || f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".gif")),
    backgrounds: listDir("backgrounds"),
    icons: listDir("icons"),
    bgm: listDir("audio/bgm"),
    sfx: listDir("audio/sfx"),
    directories: {
      portraits: join(assetsDir, "portraits"),
      backgrounds: join(assetsDir, "backgrounds"),
      icons: join(assetsDir, "icons"),
      bgm: join(assetsDir, "audio", "bgm"),
      sfx: join(assetsDir, "audio", "sfx"),
    },
  });
}

export function handleVNAssetFile(type: string, filename: string, _deps?: UIServerDeps, req?: Request): Response {
  const vnShared = join(defaultRoomsDir(), "_shared", "vn");
  const assetsDir = join(vnShared, "assets");

  // Path traversal hardening
  const safeName = filename.replace(/\.\.\/|\.\.\\/g, "").replace(/[^a-zA-Z0-9_\-\.\/]/g, "");
  if (!safeName || safeName !== filename) return json({ error: "invalid_filename" }, 400);

  // Map type to subdirectory
  const typeDirs: Record<string, string> = {
    portraits: "portraits",
    backgrounds: "backgrounds",
    icons: "icons",
    bgm: "audio/bgm",
    sfx: "audio/sfx",
  };
  const subdir = typeDirs[type];
  if (!subdir) return json({ error: "invalid_type" }, 400);

  const filePath = join(assetsDir, subdir, safeName);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(assetsDir))) return json({ error: "forbidden" }, 403);
  if (!existsSync(resolved)) return json({ error: "not_found" }, 404);

  const ext = extname(safeName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
  };
  // Same fix as handleVNPortrait/handleVNBackground (media.ts): unconditional
  // max-age=3600 hid a re-uploaded file for up to an hour. no-cache still
  // lets the browser cache the bytes, it just forces revalidation against
  // last-modified every load — a cheap 304 when unchanged, immediate on update.
  const ifModifiedSince = req?.headers.get("if-modified-since");
  const mtime = statSync(resolved).mtime;
  if (ifModifiedSince) {
    const clientDate = Date.parse(ifModifiedSince);
    if (!Number.isNaN(clientDate) && Math.floor(mtime.getTime() / 1000) <= Math.floor(clientDate / 1000)) {
      return new Response(null, { status: 304, headers: { "cache-control": "no-cache", "last-modified": mtime.toUTCString() } });
    }
  }
  return new Response(Bun.file(resolved), {
    headers: { "content-type": mimeTypes[ext] || "application/octet-stream", "cache-control": "no-cache", "last-modified": mtime.toUTCString() },
  });
}

export async function handleVNAssetUpload(req: Request, _deps?: UIServerDeps): Promise<Response> {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  const ALLOWED_TYPES = ["image/png", "image/webp", "image/jpeg", "audio/ogg", "audio/mpeg"];

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }

  const file = formData.get("file") as Blob | null;
  if (!file) return json({ error: "file_required" }, 400);
  if (file.size > MAX_SIZE) return json({ error: "file_too_large", maxSize: MAX_SIZE }, 400);

  const type = (formData.get("type") as string) || "portraits";
  const agent = (formData.get("agent") as string) || null;
  const scene = (formData.get("scene") as string) || null;
  const room = (formData.get("room") as string) || null;
  const emotion = (formData.get("emotion") as string) || null;

  // Validate all path components against a strict pattern
  const SAFE_PATTERN = /^[a-zA-Z0-9_-]+$/;
  if (agent && !SAFE_PATTERN.test(agent)) return json({ error: "invalid_agent_name" }, 400);
  if (scene && !SAFE_PATTERN.test(scene)) return json({ error: "invalid_scene_name" }, 400);
  if (room && !SAFE_PATTERN.test(room)) return json({ error: "invalid_room_id" }, 400);
  if (emotion && !SAFE_PATTERN.test(emotion)) return json({ error: "invalid_emotion_name" }, 400);
  if (!SAFE_PATTERN.test(type)) return json({ error: "invalid_asset_type" }, 400);

  // Determine target path
  const vnShared = join(defaultRoomsDir(), "_shared", "vn");
  const assetsDir = join(vnShared, "assets");

  let targetDir: string;
  let fileName: string;

  if (type === "portraits") {
    if (emotion && agent) {
      targetDir = join(assetsDir, "portraits", agent);
      fileName = `${emotion}.png`;
    } else if (agent) {
      targetDir = join(assetsDir, "portraits");
      fileName = `${agent}.png`;
    } else {
      return json({ error: "portraits_require_agent_id" }, 400);
    }
  } else if (type === "backgrounds") {
    targetDir = join(assetsDir, "backgrounds");
    if (scene) {
      fileName = `${scene}.png`;
    } else if (agent) {
      fileName = `chamber_${agent}.png`;
    } else {
      const originalName: string = (file as any).name || "bg.png";
      const basename = originalName.split("/").pop()!.split("\\").pop()!;
      if (!SAFE_PATTERN.test(basename.replace(/\.[^.]+$/, ""))) {
        return json({ error: "invalid_filename_pattern" }, 400);
      }
      fileName = basename;
    }
  } else if (type === "icons") {
    if (!room) return json({ error: "icons_require_room_id" }, 400);
    targetDir = join(assetsDir, "icons");
    fileName = `${room}.png`;
  } else if (type === "bgm") {
    targetDir = join(assetsDir, "audio", "bgm");
    const bn = ((file as any).name || "track.ogg").split("/").pop()!.split("\\").pop()!;
    if (!SAFE_PATTERN.test(bn.replace(/\.[^.]+$/, ""))) {
      return json({ error: "invalid_filename_pattern" }, 400);
    }
    fileName = bn;
  } else if (type === "sfx") {
    targetDir = join(assetsDir, "audio", "sfx");
    const bn = ((file as any).name || "effect.ogg").split("/").pop()!.split("\\").pop()!;
    if (!SAFE_PATTERN.test(bn.replace(/\.[^.]+$/, ""))) {
      return json({ error: "invalid_filename_pattern" }, 400);
    }
    fileName = bn;
  } else {
    return json({ error: "invalid_asset_type" }, 400);
  }

  // Ensure directory exists
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const filePath = join(targetDir, fileName);
  await Bun.write(filePath, file);

  return json({ ok: true, path: `${type}/${fileName}`, fullPath: filePath });
}

export async function handleVNAssetDelete(req: Request, _deps?: UIServerDeps): Promise<Response> {
  let body: { type?: string; filename?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (!body.type || !body.filename) return json({ error: "type_and_filename_required" }, 400);
  if (body.filename.includes("..") || body.filename.includes("/")) {
    return json({ error: "invalid_filename" }, 400);
  }

  const vnShared = join(defaultRoomsDir(), "_shared", "vn");
  const assetsDir = join(vnShared, "assets");
  const typeMap: Record<string, string> = {
    portraits: "portraits", backgrounds: "backgrounds", icons: "icons", bgm: "audio/bgm", sfx: "audio/sfx",
  };
  const subdir = typeMap[body.type];
  if (!subdir) return json({ error: "invalid_type" }, 400);

  const filePath = join(assetsDir, subdir, body.filename);
  if (!existsSync(filePath)) return json({ error: "file_not_found" }, 404);

  const { unlinkSync } = await import("node:fs");
  unlinkSync(filePath);
  return json({ ok: true, deleted: body.filename });
}
