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
  /** Agents whose reflection failed in this run; the run moves on and they are retried by the next run. */
  failedAgents?: string[];
  /** Consecutive failing runs per agent as of the previous run (carried so the next streak can be computed). */
  previousStreak?: Record<string, number>;
}

/**
 * An unfinished run older than this is dropped instead of resumed. It must be clearly shorter than the weekly
 * schedule period: the next scheduled slot fires about a week after an interrupted run, and that slot must always
 * start fresh and retry every agent, not resume or skip depending on a few minutes of timer jitter. Resuming is only
 * meant for a prompt manual re-run on the same day.
 */
const STALE_RUN_MS = 2 * 24 * 3600 * 1000;
/** Warn when an agent has failed to reflect this many runs in a row. */
const STREAK_WARN_AT = 2;

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

      const previousStreak = await this.loadStreak(statePath);
      let state = await this.loadState(statePath);
      const agents = await this.listAgents(roomsDir);

      if (!state) {
        state = {
          startedAt: new Date().toISOString(),
          completedAgents: [],
          currentAgent: agents[0] || "",
          failedAgents: [],
          previousStreak,
        };
      }
      state.failedAgents ??= [];

      const completedSet = new Set([...state.completedAgents, ...state.failedAgents]);
      const lucidDream = new LucidDream();

      for (const agent of agents) {
        if (completedSet.has(agent)) continue;
        state.currentAgent = agent;
        await this.checkpoint(statePath, state, agent);

        let reflected = false;
        try {
          const roomDir = join(roomsDir, agent);
          const provider = await resolveProvider(roomDir);
          const memoryStore = await resolveMemoryStore?.(roomDir);
          await lucidDream.run({ roomDir, roomsDir, agentName: agent, userPrompt: prompt, provider, memoryStore });
          reflected = true;
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
        }
        // One failing agent must not block the rest of the colony (a single provider error used to stall the
        // sweep for weeks): record the outcome and move on; the next weekly run retries failed agents.
        (reflected ? state.completedAgents : state.failedAgents).push(agent);
        // A checkpoint write error is not a reflection outcome: it is reported on its own and never turns a
        // finished reflection into a second (failed) record for the same agent.
        await this.checkpoint(statePath, state, agent);
      }

      // Judge completion against the CURRENT roster: a persisted outcome for an agent that has since been removed must
      // neither block finalization nor appear in the failure summary.
      const outcomes = new Set([...state.completedAgents, ...state.failedAgents]);
      const failedNow = state.failedAgents.filter((a) => agents.includes(a));
      if (agents.length > 0 && agents.every((a) => outcomes.has(a))) {
        const failureStreak: Record<string, number> = {};
        for (const agent of failedNow) {
          failureStreak[agent] = (state.previousStreak?.[agent] ?? 0) + 1;
          if (failureStreak[agent] >= STREAK_WARN_AT) {
            console.error(
              JSON.stringify({
                level: "warn",
                ts: new Date().toISOString(),
                msg: "lucid dream sweep: agent has not reflected for consecutive runs",
                agent,
                runs: failureStreak[agent],
              }),
            );
          }
        }
        await writeFile(
          statePath,
          JSON.stringify(
            { completed: true, completedAt: new Date().toISOString(), failedAgents: failedNow, failureStreak },
            null,
            2,
          ),
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

  /**
   * Persist progress. A write error here is a checkpoint problem, reported on its own: it must never abort the sweep
   * or be mistaken for a reflection outcome (the in-memory state still carries the run to its end).
   */
  private async checkpoint(statePath: string, state: LucidDreamSweepState, agent: string): Promise<void> {
    try {
      await this.saveState(statePath, state);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          msg: "lucid dream sweep checkpoint write failed",
          agent,
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
      // An unparseable or future start time (hand-edited state, clock stepped back) is as unusable as a stale one.
      const startedMs = Date.parse(parsed.startedAt);
      if (!Number.isFinite(startedMs) || startedMs > Date.now() || Date.now() - startedMs > STALE_RUN_MS) return null;
      return parsed as LucidDreamSweepState;
    } catch {
      return null; // corrupt or unreadable — start fresh
    }
  }

  /** Consecutive failing runs per agent recorded by the previous run (empty when unknown or unreadable). */
  private async loadStreak(statePath: string): Promise<Record<string, number>> {
    try {
      if (!existsSync(statePath)) return {};
      const parsed = JSON.parse(await readFile(statePath, "utf-8"));
      const raw = parsed.completed ? parsed.failureStreak : parsed.previousStreak;
      return raw && typeof raw === "object" ? (raw as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private async saveState(statePath: string, state: LucidDreamSweepState): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  }
}
