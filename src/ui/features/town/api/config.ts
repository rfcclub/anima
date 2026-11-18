import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadRoomConfig } from "../../../../config/types";
import { defaultRoomsDir, defaultStateDir, readMode, writeMode, VALID_MODES } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps, ModelOption } from "../../../types";


export async function handleSetConfig(req: Request, agentName: string, deps?: UIServerDeps): Promise<Response> {
  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();
  let body: { model?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (!body.model) return json({ error: "model_required" }, 400);

  const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
  const configPath = join(roomsDir, agentName, "config.yaml");
  try {
    const content = await rf(configPath, "utf-8");
    // body.model may be "providerId/modelId" — split both parts
    const slashIdx = body.model.indexOf("/");
    const providerId = slashIdx !== -1 ? body.model.slice(0, slashIdx) : null;
    const modelId = slashIdx !== -1 ? body.model.slice(slashIdx + 1) : body.model;

    let updated = content.replace(/(^provider:\s*\n(?:.*\n)*?  model:\s*).+/m, `$1${modelId}`);
    if (updated === content) {
      return json({ error: "config_model_not_found" }, 400);
    }
    if (providerId) {
      updated = updated.replace(/(^provider:\s*\n(?:.*\n)*?  type:\s*).+/m, `$1${providerId}`);
    }
    await wf(configPath, updated, "utf-8");
    return json({ ok: true, model: modelId, provider: providerId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}


export async function handleModels(deps?: UIServerDeps): Promise<Response> {
  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();
  const providersDir = join(roomsDir, "..", "providers.d");
  const options: ModelOption[] = [];
  try {
    const { readdir: rd, readFile: rf } = await import("node:fs/promises");
    const entries = await rd(providersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "import.yaml") continue;
      try {
        const raw = yaml.load(await rf(join(providersDir, entry.name), "utf8")) as Record<string, unknown>;
        const id = raw.id as string;
        const label = (raw.label as string | undefined) ?? id;
        const models = (raw.models as Array<{ id: string }> | undefined) ?? [];
        for (const m of models) {
          options.push({ value: `${id}/${m.id}`, label: `${label} — ${m.id}`, providerId: id, modelId: m.id });
        }
      } catch { /* skip bad file */ }
    }
  } catch {
    // providers.d missing — return empty list
  }
  return json({ models: options });
}

export async function handleMode(
  req: Request,
  deps?: UIServerDeps,
): Promise<Response> {
  const stateDir = deps?.stateDir ?? defaultStateDir();

  if (req.method === "GET") {
    return json({ mode: readMode(stateDir) });
  }

  let body: { mode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }

  if (!body.mode) {
    return json({ error: "mode_required" }, 400);
  }

  if (!VALID_MODES.has(body.mode)) {
    return json({ error: `invalid_mode: must be one of ${[...VALID_MODES].join(", ")}` }, 400);
  }

  writeMode(stateDir, body.mode);
  return json({ mode: body.mode });
}

/* -------------------------------------------------------------------------- */
/*  Request router                                                            */
/* -------------------------------------------------------------------------- */

const API_PREFIX = "/api/";

/**
 * Handle an incoming HTTP request for the Agent Town UI server.
 *
 * Routes:
 *   GET  /                → index.html
 *   GET  /<file>          → static file (transpiles .tsx/.ts)
 *   GET  /api/status      → agent statuses + meeting topics
 *   POST /api/talk/:agent → SSE streaming provider response
 *   GET  /api/session/:agent → session info
 *   POST /api/meet        → SSE meeting transcript
 *   GET  /api/mode        → current mode
 *   POST /api/mode        → set mode (persisted)
 *   GET  /api/cost        → token usage + cost summary (?since=ISO&until=ISO&agent=id)
 */
