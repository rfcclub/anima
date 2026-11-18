/**
 * Agent Memory Contract — shared memory interfaces for all ANIMA agents.
 *
 * This file contains only TypeScript types and interfaces. Zero runtime imports.
 * Agents implement these interfaces with their chosen backends.
 */

/**
 * Union of all memory scopes across the colony.
 * Each agent uses a subset relevant to its role.
 */
export type MemoryScope =
  | "episode"
  | "fact"
  | "observation"
  | "scent"
  | "preference"
  | "private"
  | "scar"
  | "decision"
  | "project"
  | "heartwood"
  | "growth_ring"
  | "canopy"
  | "identity"
  | "narrative"
  | "behavior"
  | "skill"
  | "relationship";

/**
 * A single memory entry stored and retrieved by AgentMemoryStore.
 */
export interface AgentMemoryEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  tags: string[];
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  /** IDs of parent entries this memory was derived from (provenance tracking). */
  parentIds?: string[];
  /** Constraints or conditions under which this memory is valid (e.g., "only_in_private_mode", "before_2026-07"). */
  constraints?: string[];
}

export interface RecallOptions {
  scopes?: MemoryScope[];
  tags?: string[];
  minConfidence?: number;
  topK?: number;
  offset?: number;
}

export interface BootstrapOptions {
  currentPrompt?: string;
  maxEntries?: number;
}

/**
 * Hook points for agents to inject custom behavior into the boot sequence.
 * All methods are optional — agents implement what they need.
 */
export interface AgentBootHooks {
  beforeSoulRead?: () => Promise<void>;
  afterSoulRead?: () => Promise<void>;
  afterMemoryIndexRead?: () => Promise<void>;
  afterRecentRead?: () => Promise<void>;
  afterBootstrap?: (entries: AgentMemoryEntry[]) => Promise<AgentMemoryEntry[]>;
}

/**
 * The memory store contract every agent implements.
 *
 * - remember(): persist a new entry
 * - recall(): query for relevant entries
 * - bootstrap(): load startup context for a new session
 */
export interface AgentMemoryStore {
  remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry>;
  recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]>;
  bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]>;
  /** Remove an entry by id. Returns silently if id does not exist. */
  forget(id: string): Promise<void>;
  /**
   * Find an entry carrying an exact tag (e.g. an idempotency key). Used to make
   * remember() idempotent: a caller checks this before writing so a retried
   * write with the same key returns the original entry instead of duplicating
   * it. Stores that cannot support an exact lookup omit this method; callers
   * treat its absence as "cannot dedupe" and always write.
   */
  findByTag?(tag: string): Promise<AgentMemoryEntry | undefined>;
}
