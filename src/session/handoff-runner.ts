import type { AgentSession } from "../agents/session";
import type { LoadedAgent } from "../agents/loader";
import { AgentLoader } from "../agents/loader";
import type { SessionStore } from "../memory/session-store";
import type { Provider } from "../providers/interface";
import { createHandoffTurn, type HandoffTurn } from "./handoff-turn";

export interface HandoffRunnerOptions {
  sessionStore: SessionStore;
  roomsDir: string;
  /** Resolve the provider the same way the agent's talk path does. */
  resolveProvider: (roomDir: string) => Promise<Provider>;
  /** Build the session that runs the single handoff turn (same shape as the talk path's). */
  createSession: (provider: Provider) => Pick<AgentSession, "run">;
  loadAgent?: (agent: string) => Promise<LoadedAgent>;
}

/** How many of the session's own turns the handoff turn gets as context. */
const HANDOFF_HISTORY_TURNS = 40;

/**
 * The handoff turn the post-consolidation reset runs before it ends an idle session (#669): one turn,
 * with the agent's own tools, asked to write `HANDOFF.md`. Running it in the session that is about to
 * end is the point — the agent summarizes the conversation it is losing.
 */
export function createSessionHandoffTurn(options: HandoffRunnerOptions): HandoffTurn {
  const loader = new AgentLoader({ roomsDir: options.roomsDir });
  const loadAgent = options.loadAgent ?? ((agent: string) => loader.load(agent));

  const runTurn = async (agent: LoadedAgent, sessionId: string, message: string): Promise<unknown> => {
    const provider = await options.resolveProvider(agent.roomDir);
    const turns = options.sessionStore.getTurns(sessionId).slice(-HANDOFF_HISTORY_TURNS);
    const session = options.createSession(provider);
    return session.run({
      agent,
      message,
      mode: "edit",
      sessionId,
      memoryAdapter: agent.memoryAdapter,
      memoryStore: agent.memoryStore,
      sessionStore: options.sessionStore,
      priorMessages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    });
  };

  return createHandoffTurn({ loadAgent, runTurn });
}
