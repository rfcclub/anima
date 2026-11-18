/**
 * Memory Health Registry — singleton that tracks all AgentMemoryStore instances.
 * Provides health check endpoint data.
 */

import type { AgentMemoryStore, AgentMemoryEntry } from "./contract";

export interface HealthEntry {
  agentId: string;
  status: "ok" | "error";
  entries?: number;
  latencyMs?: number;
  error?: string;
}

export class MemoryHealthRegistry {
  private static instance: MemoryHealthRegistry;
  private stores = new Map<string, AgentMemoryStore>();

  static getInstance(): MemoryHealthRegistry {
    if (!MemoryHealthRegistry.instance) {
      MemoryHealthRegistry.instance = new MemoryHealthRegistry();
    }
    return MemoryHealthRegistry.instance;
  }

  /** Reset all registered stores (for testing). */
  static reset(): void {
    MemoryHealthRegistry.instance = new MemoryHealthRegistry();
  }

  register(agentId: string, store: AgentMemoryStore): void {
    this.stores.set(agentId, store);
  }

  get(agentId: string): AgentMemoryStore | undefined {
    return this.stores.get(agentId);
  }

  getAll(): Array<{ agentId: string; store: AgentMemoryStore }> {
    return Array.from(this.stores.entries()).map(([agentId, store]) => ({
      agentId,
      store,
    }));
  }

  async checkHealth(): Promise<HealthEntry[]> {
    const results: HealthEntry[] = [];

    for (const [agentId, store] of this.stores) {
      const start = Date.now();
      try {
        const entries = await store.recall("health-check", { topK: 1 });
        results.push({
          agentId,
          status: "ok",
          entries: entries.length,
          latencyMs: Date.now() - start,
        });
      } catch (err) {
        results.push({
          agentId,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - start,
        });
      }
    }

    return results;
  }
}
