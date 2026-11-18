import type { SessionStore } from "../memory/session-store";
import { SessionManager } from "./manager";

export interface CloseOpenSessionsOptions {
  store: SessionStore;
  agents: string[];
  channel: string;
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
}

export interface CloseOpenSessionsResult {
  closed: string[];
  /** True when no onEnd was given: sessions end without a summary or beam. */
  endHandlerMissing: boolean;
  failed: Array<{ agent: string; error: string }>;
}

/** Ends each agent's latest open session on `channel`. One agent failing does not stop the rest. */
export function closeOpenSessions(options: CloseOpenSessionsOptions): CloseOpenSessionsResult {
  const { store, agents, channel, onEnd } = options;
  // Each end handler can call a model, and a first run may close a dozen at once: run them one after another.
  let chain: Promise<void> = Promise.resolve();
  const serialEnd = onEnd
    ? (sessionId: string, agent: string): Promise<void> => {
        const next = chain.then(() => onEnd(sessionId, agent));
        chain = next.catch(() => {});
        return next;
      }
    : undefined;
  const manager = new SessionManager({ store, onEnd: serialEnd });
  const result: CloseOpenSessionsResult = { closed: [], failed: [], endHandlerMissing: !onEnd };
  for (const agent of agents) {
    try {
      const session = store.getLatestSession(agent, channel);
      if (!session || session.ended) continue;
      manager.closeSession(agent, channel);
      result.closed.push(agent);
    } catch (err) {
      result.failed.push({ agent, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** The store that holds `sessionId`. Town/Castle sessions live in a different sessions.db than gateway sessions. */
export function resolveSessionStore(sessionId: string, candidates: SessionStore[]): SessionStore | undefined {
  return candidates.find((store) => store.getSession(sessionId) !== null);
}
