import type { RoomConfig } from "../config/types";
import type { SessionStore } from "../memory/session-store";
import type { HandoffTurn } from "./handoff-turn";
import {
  DEFAULT_RESET_IDLE_MS,
  resetIdleSessions,
  type ResetIdleSessionsResult,
} from "./reset-idle-sessions";

export interface ResetAfterDreamOptions {
  store: SessionStore;
  agents: string[];
  /** The agent's room config, or undefined when it cannot be read (the agent is then left alone). */
  readConfig: (agent: string) => Promise<RoomConfig | undefined>;
  handoff?: HandoffTurn;
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * The post-consolidation reset as the room config describes it (#669): each agent's own
 * `session.resetAfterDream` / `session.resetIdleMs` decide whether and how early its open
 * conversational sessions end. An unreadable config never blocks the other agents.
 */
export async function resetAfterDream(options: ResetAfterDreamOptions): Promise<ResetIdleSessionsResult> {
  const { store, agents, readConfig, handoff, onEnd, log } = options;
  const now = options.now ?? (() => Date.now());
  const total: ResetIdleSessionsResult = { reset: [], skipped: [], failed: [], handoffMissing: [] };

  for (const agent of agents) {
    let config: RoomConfig | undefined;
    try {
      config = await readConfig(agent);
    } catch (err) {
      total.failed.push({ agent, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!config) continue;
    const result = await resetIdleSessions({
      store,
      agents: [agent],
      idleMs: config.session.resetIdleMs ?? DEFAULT_RESET_IDLE_MS,
      shouldReset: () => config!.session.resetAfterDream !== false,
      handoff,
      onEnd,
      now,
      log,
    });
    total.reset.push(...result.reset);
    total.skipped.push(...result.skipped);
    total.failed.push(...result.failed);
    total.handoffMissing.push(...result.handoffMissing);
  }
  return total;
}
