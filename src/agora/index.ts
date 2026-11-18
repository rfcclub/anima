// ---------------------------------------------------------------------------
// Agora — Inter-agent event bus + ANIMA dispatcher
// ---------------------------------------------------------------------------
// Public API for the Agora system. Exports the AgoraClient singleton,
// event types, and the ANIMA namespace with requestLegio().
// ---------------------------------------------------------------------------

export { AgoraClient } from "./client";
export type * from "./types";
export { defaultLegioForDomain, LEGIO_ROUTING } from "./types";
export type {
  AgoraEvent,
  AgoraEventType,
  AgoraEventHandler,
  AgoraTaskCompleteEvent,
  AgoraTaskFailedEvent,
  AgoraTaskBlockedEvent,
  AgoraAgentOfflineEvent,
  AgoraAgentOnlineEvent,
  AgoraTaskAssignedEvent,
  LegioDescriptor,
  LegioType,
  RequestLegioOptions,
} from "./types";

// ---------------------------------------------------------------------------
// ANIMA namespace — global dispatcher facade
// ---------------------------------------------------------------------------
// Provides ANIMA.requestLegio() for use throughout the codebase.
// The AgoraClient instance must be initialized before use.
// ---------------------------------------------------------------------------

import { AgoraClient } from "./client";
import type { RequestLegioOptions } from "./types";
import type { TrustDomain } from "../evaluation/trust-system";

/** Global AgoraClient singleton. Set via ANIMA.initialize(). */
let _client: AgoraClient | null = null;
let _initialized = false;

/**
 * ANIMA — the global namespace for ANIMA system operations.
 *
 * Usage:
 *   import { ANIMA } from "../agora";
 *   const assignment = await ANIMA.requestLegio("bruno", "code_review");
 */
export const ANIMA = {
  /**
   * Initialize the ANIMA dispatcher with an AgoraClient instance.
   * Must be called once before requestLegio.
   */
  initialize(client: AgoraClient): void {
    _client = client;
    _initialized = true;
  },

  /** True if ANIMA.initialize() has been called. */
  get initialized(): boolean {
    return _initialized;
  },

  /** Get the underlying AgoraClient instance. */
  get client(): AgoraClient | null {
    return _client;
  },

  /**
   * Request a Legio to handle a task.
   * Selects the best available Legio by availability -> trust -> cost,
   * assigns the task, and returns the assignment.
   *
   * @param agentId - The agent requesting the legio
   * @param taskDomain - The domain of the task (determines preferred legio type)
   * @param options - Optional cartridges, priority
   * @returns The task assignment event, or null if no legio available
   */
  async requestLegio(
    agentId: string,
    taskDomain: TrustDomain,
    options?: RequestLegioOptions,
  ) {
    if (!_initialized || !_client) {
      throw new Error("ANIMA not initialized. Call ANIMA.initialize(client) first.");
    }
    return _client.requestLegio(agentId, taskDomain, options);
  },

  /**
   * Convenience: request codex legio for code tasks.
   */
  async requestCodex(agentId: string, domain: TrustDomain, options?: RequestLegioOptions) {
    return ANIMA.requestLegio(agentId, domain, options);
  },

  /**
   * Convenience: request qwen legio for parallel/quota-tight tasks.
   */
  async requestQwen(agentId: string, domain: TrustDomain, options?: RequestLegioOptions) {
    return ANIMA.requestLegio(agentId, domain, options);
  },

  /**
   * Convenience: request gemini legio for analysis/research tasks.
   */
  async requestGemini(agentId: string, domain: TrustDomain, options?: RequestLegioOptions) {
    return ANIMA.requestLegio(agentId, domain, options);
  },
};
