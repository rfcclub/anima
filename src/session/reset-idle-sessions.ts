import type { SessionRecord, SessionStore } from "../memory/session-store";
import type { HandoffTurn } from "./handoff-turn";

/** Default idle threshold: a session whose newest turn is older than this is reset after the nightly dream. */
export const DEFAULT_RESET_IDLE_MS = 30 * 60 * 1000;

/** Channels that carry a conversation and are reset after the consolidation. `ambient:*` is the shared room talk. */
export function isResettableChannel(channel: string): boolean {
  return channel === "talk" || channel === "ui" || channel.startsWith("ambient:");
}

export interface ResetIdleSessionsOptions {
  store: SessionStore;
  agents: string[];
  /** Sessions whose newest turn is older than this are reset. Default DEFAULT_RESET_IDLE_MS. */
  idleMs?: number;
  /** The nightly opt-out per agent (`session.resetAfterDream: false`). */
  shouldReset?: (agent: string) => boolean;
  /** Runs before the session ends so the agent can write its handoff; its failure never blocks the reset. */
  handoff?: HandoffTurn;
  /** The same end handler `newSession` fires: writes the session summary into memory. */
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export interface ResetIdleSessionsResult {
  /** Sessions ended, by agent. */
  reset: string[];
  /** Open sessions left alone because a turn is newer than the idle threshold. */
  skipped: string[];
  /** Per-agent failures; the other agents are still reset. */
  failed: Array<{ agent: string; error: string }>;
  /** Agents whose handoff turn failed or wrote nothing; the session was still ended. */
  handoffMissing: string[];
}

/** The newest activity of a session: its last turn, or the session start when it has no turns. */
export function lastActivityMs(store: SessionStore, session: SessionRecord): number {
  const turns = store.getTurns(session.id);
  const last = turns.at(-1);
  return last ? Date.parse(last.ts) : Date.parse(session.started);
}

/**
 * After the nightly consolidation, end each agent's open conversational sessions that have been idle for at
 * least `idleMs`, through the same path as `newSession`: a handoff turn first (so the agent leaves a note), then
 * the `onEnd` hook (so the summary reaches memory), then the end. A conversation with a recent turn is never cut.
 */
export async function resetIdleSessions(options: ResetIdleSessionsOptions): Promise<ResetIdleSessionsResult> {
  const { store, agents, handoff, onEnd } = options;
  const idleMs = options.idleMs ?? DEFAULT_RESET_IDLE_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const result: ResetIdleSessionsResult = { reset: [], skipped: [], failed: [], handoffMissing: [] };

  for (const agent of agents) {
    if (options.shouldReset && !options.shouldReset(agent)) continue;
    let sessions: SessionRecord[];
    try {
      sessions = store.getOpenSessions(agent).filter((session) => isResettableChannel(session.channel));
    } catch (err) {
      result.failed.push({ agent, error: errorMessage(err) });
      continue;
    }
    for (const session of sessions) {
      try {
        if (now() - lastActivityMs(store, session) < idleMs) {
          result.skipped.push(agent);
          continue;
        }
        if (handoff) {
          try {
            // `false` means the agent left no handoff: the reset still ends the session, but say so.
            if ((await handoff(agent, session)) === false) {
              result.handoffMissing.push(agent);
              log("warn", "handoff turn wrote nothing; ending the session anyway", { agent, sessionId: session.id });
            }
          } catch (err) {
            // A missing handoff never blocks the reset; the run is logged and the session still ends.
            result.handoffMissing.push(agent);
            log("warn", "handoff turn failed; ending the session anyway", { agent, sessionId: session.id, error: errorMessage(err) });
          }
        }
        if (onEnd) {
          try {
            await onEnd(session.id, agent);
          } catch (err) {
            // The summary failed, but the stale context is still dropped.
            log("error", "session end handler failed; ending the session anyway", { agent, sessionId: session.id, error: errorMessage(err) });
          }
        }
        store.endSession(session.id);
        result.reset.push(agent);
        log("info", "idle session reset after consolidation", { agent, sessionId: session.id, channel: session.channel });
      } catch (err) {
        result.failed.push({ agent, error: errorMessage(err) });
      }
    }
  }
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
