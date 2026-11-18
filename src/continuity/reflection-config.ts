// ---------------------------------------------------------------------------
// loadReflectionAgents — scan room configs for reflection-enabled agents.
//
// Accepts both room config shapes:
//   reflection:                      session:
//     enabled: true                    reflectionEnabled: true
//     intervalMs: 43200000             reflectionIntervalHours: 12
//     urgencyThreshold: 3
//
// The reflection: block wins when both are present. This dual-shape support
// exists because the scheduler would silently schedule zero agents for a
// config written in the session: shape.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface ReflectionAgentConfig {
  name: string;
  reflectionEnabled?: boolean;
  reflectionIntervalHours?: number;
  urgencyThreshold?: number;
  provider?: any;
}

export async function loadReflectionAgents(roomsDir: string): Promise<ReflectionAgentConfig[]> {
  const agents: ReflectionAgentConfig[] = [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(roomsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const configPath = join(roomsDir, entry.name, "config.yaml");
    if (!existsSync(configPath)) continue;
    try {
      const cfg = yaml.load(readFileSync(configPath, "utf8")) as any;
      if (cfg?.reflection?.enabled) {
        const ms = Number(cfg.reflection.intervalMs ?? 3600000);
        agents.push({
          name: entry.name,
          reflectionEnabled: true,
          reflectionIntervalHours: Math.max(1, Math.round(ms / 3600000)),
          urgencyThreshold: cfg.reflection.urgencyThreshold,
          provider: cfg.provider,
        });
      } else if (cfg?.session?.reflectionEnabled) {
        agents.push({
          name: entry.name,
          reflectionEnabled: true,
          reflectionIntervalHours: Math.max(1, Math.round(Number(cfg.session.reflectionIntervalHours ?? 4))),
          urgencyThreshold: cfg.session.urgencyThreshold,
          provider: cfg.provider,
        });
      }
    } catch (err) {
      console.warn(`[reflection] failed to parse config for ${entry.name}:`, err);
    }
  }
  return agents;
}
