import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { defaultRoomsDir } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps } from "../../../types";


export async function handleVNStateSave(req: Request, _deps?: UIServerDeps): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json_body" }, 400); }

  const agentId = body.agentId as string;
  if (!agentId) return json({ error: "agentId_required" }, 400);
  // Validate agentId format to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return json({ error: "invalid_agentId" }, 400);
  }

  const branchId = body.branchId != null ? Number(body.branchId) : undefined;
  const fileName = branchId != null ? `${agentId}_${branchId}.json` : `${agentId}.json`;

  const stateDir = join(defaultRoomsDir(), "_shared", "vn", "state");
  try { mkdirSync(stateDir, { recursive: true }); } catch {}

  const statePath = resolve(join(stateDir, fileName));
  const resolvedStateDir = resolve(stateDir);
  if (!statePath.startsWith(resolvedStateDir + sep)) {
    return json({ error: "invalid_path" }, 400);
  }

  try {
    writeFileSync(statePath, JSON.stringify({ ...body, savedAt: new Date().toISOString() }, null, 2));
    return json({ ok: true });
  } catch {
    return json({ error: "failed_to_save_state" }, 500);
  }
}

export function handleVNStateLoad(req: Request, agentId: string, _deps?: UIServerDeps): Response {
  // Validate agentId format to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return json({ error: "invalid_agentId" }, 400);
  }
  const url = new URL(req.url);
  const branchId = url.searchParams.has("branchId") ? Number(url.searchParams.get("branchId")) : undefined;
  const fileName = branchId != null ? `${agentId}_${branchId}.json` : `${agentId}.json`;

  const stateDir = join(defaultRoomsDir(), "_shared", "vn", "state");
  const statePath = resolve(join(stateDir, fileName));
  const resolvedStateDir = resolve(stateDir);
  if (!statePath.startsWith(resolvedStateDir + sep)) {
    return json({ error: "invalid_path" }, 400);
  }
  if (!existsSync(statePath)) return json({ error: "no_saved_state" }, 404);
  try {
    return new Response(Bun.file(statePath), { headers: { "content-type": "application/json" } });
  } catch {
    return json({ error: "failed_to_load_state" }, 500);
  }
}
