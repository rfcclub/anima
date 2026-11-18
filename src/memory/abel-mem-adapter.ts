// ---------------------------------------------------------------------------
// AbelMemAdapter — agent-memory-contract adapter for abel-mem
// ---------------------------------------------------------------------------
// Implements AgentMemoryStore by wrapping the AbelMemService.
// This allows 2B's memory to be accessed through the standard ANIMA
// memory interface used by all colony agents.
// ---------------------------------------------------------------------------

import type { AgentMemoryEntry, AgentMemoryStore, MemoryScope, RecallOptions } from "./contract";
import { AbelMemService } from "../services/abel-mem";

/**
 * AbelMemAdapter — AgentMemoryStore adapter for the abel-mem HTTP service.
 *
 * Wraps AbelMemService to provide the standard memory contract for 2B agents.
 * All operations (remember, recall, bootstrap) are delegated to the external
 * abel-mem engine via HTTP. Falls back gracefully when the service is unreachable.
 */
export class AbelMemAdapter implements AgentMemoryStore {
  private readonly service: AbelMemService;

  constructor(service?: AbelMemService) {
    this.service = service ?? new AbelMemService();
  }

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    const result = await this.service.store({
      content: entry.content,
      agent: entry.source,
      timestamp: new Date().toISOString(),
      tags: entry.tags,
    });

    return {
      id: result.id,
      content: entry.content,
      scope: entry.scope,
      tags: entry.tags,
      confidence: entry.confidence,
      source: entry.source,
      createdAt: new Date().toISOString(),
    };
  }

  async recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    const result = await this.service.recall({
      query,
      topK: options?.topK ?? 10,
    });

    return result.results.map((r) => ({
      id: r.id,
      content: r.content,
      scope: "observation" as MemoryScope,
      tags: [],
      confidence: r.relevance,
      source: r.agent,
      createdAt: r.timestamp,
    }));
  }

  async forget(id: string): Promise<void> {
    // abel-mem engine manages its own lifecycle — delegate deletion
    await this.service.delete(id);
  }

  async bootstrap(options?: { currentPrompt?: string; maxEntries?: number }): Promise<AgentMemoryEntry[]> {
    const result = await this.service.bootstrap({
      agent: "abel",
    });

    if (result.status === "bootstrapped" || result.status === "stub_ok") {
      return [
        {
          id: result.status,
          content: `Bootstrap completed for agent ${result.agent} with status ${result.status}`,
          scope: "observation" as MemoryScope,
          tags: ["bootstrap", `agent-${result.agent}`],
          confidence: 0.9,
          source: "abel-mem-adapter",
          createdAt: new Date().toISOString(),
        },
      ];
    }

    return [];
  }
}

/**
 * Create a AbelMemAdapter with default service.
 */
export function createAbelMemAdapter(): AbelMemAdapter {
  return new AbelMemAdapter();
}
