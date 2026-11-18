import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRoomsDir } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps } from "../../../types";


export function handleVNScene(agentId: string, sceneId: string, deps?: UIServerDeps): Response {
  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();
  const scenesYaml = join(roomsDir, "_shared", "vn", "scenes.yaml");

  let scenes: Record<string, unknown> = {};

  // Parse YAML scenes config
  if (existsSync(scenesYaml)) {
    try {
      const yaml = readFileSync(scenesYaml, "utf-8");
      scenes = parseYamlScenes(yaml);
    } catch {
      // fall through to empty
    }
  }

  // Look up per-agent override first, then generic scene
  const agentOverrides = (scenes.agent_scenes as Record<string, Record<string, unknown>>)?.[agentId];
  const agentScene = agentOverrides?.[sceneId];
  const genericScenes = scenes.scenes as Record<string, unknown> | undefined;
  const genericScene = genericScenes?.[sceneId];

  const scene = agentScene || genericScene;
  if (!scene) {
    return json({ error: "scene_not_found" }, 404);
  }

  return json({
    ...scene as Record<string, unknown>,
    id: sceneId,
    agentId,
  });
}

/** Minimal YAML scenes parser — only handles the scenes.yaml structure we define */
export function parseYamlScenes(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = { scenes: {}, agent_scenes: {} };
  let section: string | null = null;
  let currentScene: string | null = null;
  let currentAgent: string | null = null;

  for (const line of yaml.split("\n")) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      if (trimmed === "scenes:") { section = "scenes"; continue; }
      if (trimmed === "agent_scenes:") { section = "agent_scenes"; continue; }
      section = null;
      continue;
    }

    if (section === "scenes" && indent === 2) {
      currentScene = trimmed.replace(/:$/, "");
      currentAgent = null;
      const scenes = result.scenes as Record<string, unknown>;
      if (!scenes[currentScene]) scenes[currentScene] = {};
      continue;
    }

    if (section === "agent_scenes" && indent === 2) {
      currentAgent = trimmed.replace(/:$/, "");
      currentScene = null;
      const agents = result.agent_scenes as Record<string, Record<string, unknown>>;
      if (!agents[currentAgent]) agents[currentAgent] = {};
      continue;
    }

    if (section === "agent_scenes" && indent === 4 && currentAgent) {
      currentScene = trimmed.replace(/:$/, "");
      currentScene = null; // reset after reading scene name under agent
      // Actually, we need to track the scene under agent
      const agents = result.agent_scenes as Record<string, Record<string, unknown>>;
      if (!agents[currentAgent][trimmed.replace(/:$/, "")]) {
        agents[currentAgent][trimmed.replace(/:$/, "")] = {};
      }
      continue;
    }

    // Key-value pairs: parse "key: value" or "key:"
    if (indent >= 2) {
      const kvMatch = trimmed.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (!kvMatch) continue;
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (key === "positions" || typeof value === "undefined") continue; // skip positions map for now

      // Handle unquoted values: remove quotes if present
      const cleanValue = (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;

      // Find the right target object
      if (section === "scenes" && currentScene) {
        (result.scenes as Record<string, Record<string, unknown>>)[currentScene][key] = cleanValue;
      } else if (section === "agent_scenes" && currentAgent) {
        // Find the current scene under this agent — use the last scene key added
        const agentScenes = (result.agent_scenes as Record<string, Record<string, unknown>>)[currentAgent];
        const agentSceneKeys = Object.keys(agentScenes);
        const lastScene = agentSceneKeys[agentSceneKeys.length - 1];
        if (lastScene && agentScenes[lastScene]) {
          (agentScenes[lastScene] as Record<string, unknown>)[key] = cleanValue;
        }
      }
    }
  }

  return result;
}
