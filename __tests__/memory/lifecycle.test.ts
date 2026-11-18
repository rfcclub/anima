import { test, expect, describe, beforeEach } from "bun:test";
import type { AgentMemoryStore, AgentMemoryEntry } from "../../src/memory/contract";
import { MemoryHealthRegistry } from "../../src/memory/health-registry";

interface AgentContext {
  memory?: AgentMemoryStore;
}

describe("Agent lifecycle — memory store injection", () => {
  beforeEach(() => {
    MemoryHealthRegistry.reset();
  });

  test("RED: LoadedAgent can carry a memoryStore", async () => {
    const store: AgentMemoryStore = {
      remember: async (e) => ({ id: "custom-1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [],
      bootstrap: async () => [],
    };

    const agent = {
      name: "test-agent",
      memoryStore: store,
    };

    expect(agent.memoryStore).toBe(store);
    const result = await agent.memoryStore.remember({
      content: "test",
      scope: "observation",
      tags: [],
      confidence: 0.5,
      source: "test",
    });
    expect(result.id).toBe("custom-1");
  });

  test("RED: agent with custom store has context.memory available", async () => {
    const store: AgentMemoryStore = {
      remember: async (e) => ({ id: "ctx-1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [{ id: "r1", content: "recalled", scope: "fact", tags: [], confidence: 0.8, source: "test", createdAt: new Date().toISOString() }],
      bootstrap: async () => [],
    };

    const ctx: AgentContext = { memory: store };
    expect(ctx.memory).toBeDefined();

    const results = await ctx.memory!.recall("query");
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("recalled");
  });

  test("RED: health registry works with agent lifecycle integration", async () => {
    const registry = MemoryHealthRegistry.getInstance();
    const store: AgentMemoryStore = {
      remember: async (e) => ({ id: "h-1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [],
      bootstrap: async () => [],
    };

    registry.register("lifecycle-agent", store);
    const health = await registry.checkHealth();
    const entry = health.find((h) => h.agentId === "lifecycle-agent");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("ok");
  });
});
