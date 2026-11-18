import { test, expect, describe, beforeEach } from "bun:test";
import type { AgentMemoryStore, AgentMemoryEntry } from "../../src/memory/contract";

async function freshRegistry() {
  const mod = await import("../../src/memory/health-registry");
  mod.MemoryHealthRegistry.reset();
  return mod.MemoryHealthRegistry.getInstance();
}

describe("MemoryHealthRegistry — health check registry", () => {
  test("RED: register and getAll return stored entries", async () => {
    const registry = await freshRegistry();
    const store: AgentMemoryStore = {
      remember: async (e: any) => ({ id: "1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [],
      bootstrap: async () => [],
    };

    registry.register("test-agent", store);
    const all = registry.getAll();
    expect(all.length).toBeGreaterThan(0);
    expect(all[0].agentId).toBe("test-agent");
  });

  test("RED: health check returns ok for healthy store", async () => {
    const registry = await freshRegistry();
    const store: AgentMemoryStore = {
      remember: async (e: any) => ({ id: "1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [{ id: "1", content: "test", scope: "fact" as const, tags: [], confidence: 0.5, source: "test", createdAt: new Date().toISOString() }],
      bootstrap: async () => [],
    };

    registry.register("healthy-agent", store);
    const results = await registry.checkHealth();
    const entry = results.find((r) => r.agentId === "healthy-agent");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("ok");
  });

  test("RED: error in recall shows error status without crashing other agents", async () => {
    const registry = await freshRegistry();
    const badStore: AgentMemoryStore = {
      remember: async () => { throw new Error("db down"); },
      recall: async () => { throw new Error("db down"); },
      bootstrap: async () => { throw new Error("db down"); },
    };

    const goodStore: AgentMemoryStore = {
      remember: async (e: any) => ({ id: "1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [],
      bootstrap: async () => [],
    };

    registry.register("bad-agent", badStore);
    registry.register("good-agent", goodStore);

    const results = await registry.checkHealth();
    const bad = results.find((r) => r.agentId === "bad-agent");
    const good = results.find((r) => r.agentId === "good-agent");

    expect(bad).toBeDefined();
    expect(bad!.status).toBe("error");
    expect(good).toBeDefined();
    expect(good!.status).toBe("ok");
  });
});
