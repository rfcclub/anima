/**
 * Cross-Session Memory — session-end summary write and session-start bootstrap.
 *
 * When a session ends (via /new or agent switch), this module:
 * 1. Fetches all non-deleted turns for the session
 * 2. Skips if zero turns
 * 3. Constructs a Compactor for the agent, calls summarize(turns)
 * 4. Writes the summary via agent.memoryStore.remember()
 *
 * Dependencies: agent-memory-contract (AgentMemoryStore), Compactor, SessionStore
 */

import type { AgentMemoryStore } from "../memory/contract";
import type { SessionStore, TurnRecord } from "../memory/session-store";
import type { Provider } from "../providers/interface";
import { Compactor } from "./compactor";
import type { SessionTurn } from "./types";
import { LightNap } from "../dream/light-nap";

/**
 * Build a session-end handler for an agent with cross-session memory enabled.
 *
 * Returns an async function suitable for SessionManagerOptions.onEnd.
 * Fetches the session's turns from the SessionStore and writes a summary
 * via writeSessionSummary. When `roomDir` is given, also runs LightNap over
 * the same turns — Town/Castle chat (`SessionManager`) had no beam-writing
 * path at all until this (only Telegram's `SessionLifecycle.onClose` wrote
 * beams), so DeepDream/LucidDream never saw anything from a Town/Castle
 * conversation. (requirement: LightNap applies to Town/Castle too)
 */
export function buildSessionEndHandler(
  memoryStore: AgentMemoryStore,
  provider: Provider,
  sessionStore: SessionStore,
  model?: string,
  roomDir?: string,
): (sessionId: string, agentName: string) => Promise<void> {
  return async (sessionId: string, agentName: string): Promise<void> => {
    try {
      const turns = sessionStore.getTurns(sessionId);
      if (turns.length === 0) {
        console.log(`[cross-session-memory] session ${sessionId} has no turns, skipping summary`);
        return;
      }
      await writeSessionSummary(memoryStore, provider, sessionId, turns, model);
      if (roomDir) {
        await lightNapFromTurns(roomDir, agentName, sessionId, turns);
      }
    } catch (err) {
      console.error(`[cross-session-memory] handler failed for ${agentName}:`, err);
    }
  };
}

/**
 * Adapt SessionManager's TurnRecord[] (SQLite turns) into LightNap's
 * JsonlEvent[] shape and run it — the only bridge between the Town/Castle
 * turn store and the beam-writing pipeline DeepDream/LucidDream read from.
 */
export async function lightNapFromTurns(
  roomDir: string,
  agentName: string,
  sessionId: string,
  turns: TurnRecord[],
): Promise<void> {
  const lightNap = new LightNap();
  await lightNap.run({
    roomDir,
    agentName,
    sessionId,
    sessionEvents: turns.map((t) => ({
      timestamp: t.ts,
      type: `turn_${t.role}`,
      sessionId,
      body: t.content,
    })),
  });
}

/**
 * Generate a continuity summary from session turns and persist it.
 */
export async function writeSessionSummary(
  memoryStore: AgentMemoryStore,
  provider: Provider,
  sessionId: string,
  turns: TurnRecord[],
  model?: string,
): Promise<void> {
  if (turns.length === 0) return;

  const sessionTurns: SessionTurn[] = turns.map((t) => ({
    timestamp: t.ts,
    type: "turn" as const,
    sessionId,
    role: t.role,
    content: t.content,
  }));

  const compactor = new Compactor({
    provider,
    sessionId,
    model,
  });

  const summary = await compactor.summarize(sessionTurns);
  if (!summary) return;

  const dateRange = summary.dateRange;
  await memoryStore.remember({
    content: summary.summary,
    scope: "observation",
    tags: ["session-summary", `session-${sessionId}`],
    confidence: 0.8,
    source: "cross-session-memory",
    metadata: {
      turnCount: summary.turnCount,
      sessionId,
      dateRange,
    },
  });

  console.log(`[cross-session-memory] summary written for session ${sessionId} (${summary.turnCount} turns)`);
}

/**
 * Format bootstrap content for system prompt injection.
 */
export function formatBootstrapContent(entries: string): string {
  if (!entries || entries.trim().length === 0) return "";
  return `## Bootstrap Memory\n\n${entries.trim()}`;
}
