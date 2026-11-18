import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LucidDream } from "./lucid-dream";
import type { Provider } from "../providers/interface";
import type { AgentMemoryStore } from "../memory/contract";

export interface LucidDreamSweepState {
  startedAt: string;
  completedAgents: string[];
  currentAgent: string;
}

export interface LucidDreamSweepOptions {
  roomsDir: string;
  resolveProvider: (roomDir: string) => Promise<Provider>;
  /** Optional — when provided, each agent's reflection is also persisted
   *  directly via AgentMemoryStore.remember(). Omitting it keeps the sweep
   *  file-only, same as before this was added. */
  resolveMemoryStore?: (roomDir: string) => Promise<AgentMemoryStore | undefined>;
  prompt: string;
}

/**
 * Lucid Dream Sweep — scheduled cron that runs LucidDream for every agent,
 * sequentially. Mirrors DeepDream's iteration/crash-recovery pattern
 * (listAgents by config.yaml, `.{name}-state.json` in rooms/staging/,
 * stop-and-resume on per-agent failure) so the two crons behave the same
 * way operationally.
 *
 * This enforces WHEN a reflection happens (discipline: the agent doesn't
 * have to remember to trigger it herself) without touching WHAT she decides
 * to keep — LucidDream still just writes the raw reflection to
 * staging/dreams/; nothing here promotes anything into an agent's substrate.
 */
export class LucidDreamSweep {
  async run(options: LucidDreamSweepOptions): Promise<void> {
    const { roomsDir, resolveProvider, resolveMemoryStore, prompt } = options;
    try {
      const stagingDir = join(roomsDir, "staging");
      await mkdir(stagingDir, { recursive: true });
      const statePath = join(stagingDir, ".lucid-sweep-state.json");

      let state = await this.loadState(statePath);
      const agents = await this.listAgents(roomsDir);

      if (!state) {
        state = {
          startedAt: new Date().toISOString(),
          completedAgents: [],
          currentAgent: agents[0] || "",
        };
      }

      const completedSet = new Set(state.completedAgents);
      const lucidDream = new LucidDream();

      for (const agent of agents) {
        if (completedSet.has(agent)) continue;
        state.currentAgent = agent;
        await this.saveState(statePath, state);

        try {
          const roomDir = join(roomsDir, agent);
          const provider = await resolveProvider(roomDir);
          const memoryStore = await resolveMemoryStore?.(roomDir);
          await lucidDream.run({ roomDir, roomsDir, agentName: agent, userPrompt: prompt, provider, memoryStore });
          state.completedAgents.push(agent);
          await this.saveState(statePath, state);
        } catch (err) {
          console.error(
            JSON.stringify({
              level: "error",
              ts: new Date().toISOString(),
              msg: "lucid dream sweep failed for agent",
              agent,
              error: String(err),
            }),
          );
          break; // stop processing — resume from this agent next run
        }
      }

      if (agents.length > 0 && state.completedAgents.length === agents.length) {
        await writeFile(
          statePath,
          JSON.stringify({ completed: true, completedAt: new Date().toISOString() }, null, 2),
          "utf-8",
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          msg: "lucid dream sweep run failed",
          error: String(err),
        }),
      );
    }
  }

  /** List agent directories that contain a config.yaml file. */
  private async listAgents(roomsDir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(roomsDir);
    } catch {
      return [];
    }

    const agents: string[] = [];
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const configPath = join(roomsDir, name, "config.yaml");
      if (existsSync(configPath)) agents.push(name);
    }
    return agents.sort();
  }

  private async loadState(statePath: string): Promise<LucidDreamSweepState | null> {
    try {
      if (!existsSync(statePath)) return null;
      const parsed = JSON.parse(await readFile(statePath, "utf-8"));
      if (parsed.completed) return null; // previous run completed — start fresh
      if (
        typeof parsed.startedAt !== "string" ||
        !Array.isArray(parsed.completedAgents)
      ) {
        return null;
      }
      return parsed as LucidDreamSweepState;
    } catch {
      return null; // corrupt or unreadable — start fresh
    }
  }

  private async saveState(statePath: string, state: LucidDreamSweepState): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  }
}
