import type { LoadedAgent } from "../agents/loader";
import type { SessionRecord } from "../memory/session-store";
import { HANDOFF_PROMPT, readHandoff, writeHandoff } from "./handoff";

/** One turn in which the agent writes its own handoff before its session is reset (#669). */
export type HandoffTurn = (agent: string, session: SessionRecord) => Promise<boolean>;

export interface CreateHandoffTurnOptions {
  loadAgent: (agent: string) => Promise<LoadedAgent>;
  /** Runs one turn with the agent's own tools; the message is the handoff prompt. */
  runTurn: (agent: LoadedAgent, sessionId: string, message: string) => Promise<unknown>;
  now?: () => Date;
}

/**
 * Build the handoff turn the reset runs before ending an idle session: the agent gets one turn to write
 * `HANDOFF.md`, and the version it replaces is archived. Returns true when the room holds a handoff
 * afterwards, false when the agent wrote nothing (the reset ends the session either way).
 */
export function createHandoffTurn(options: CreateHandoffTurnOptions): HandoffTurn {
  const now = options.now ?? (() => new Date());
  return async (agentName: string, session: SessionRecord): Promise<boolean> => {
    const agent = await options.loadAgent(agentName);
    const previous = await readHandoff(agent.roomDir);
    await options.runTurn(agent, session.id, HANDOFF_PROMPT);
    const written = await readHandoff(agent.roomDir);
    if (!written) return false;
    // Unchanged content is already where the next session will read it; don't archive the same note twice.
    if (written !== previous) await writeHandoff(agent.roomDir, written, now());
    return true;
  };
}
