import { test, expect, describe } from "bun:test";
import type { AgentMemoryEntry, AgentMemoryStore, RecallOptions, BootstrapOptions, AgentBootHooks, MemoryScope } from "../../src/memory/contract";

describe("agent-memory-contract — type-only module", () => {
  test("RED: contract module can be imported without runtime errors", async () => {
    // This test validates the contract has zero runtime imports
    const mod = await import("../../src/memory/contract");
    expect(mod).toBeDefined();
  });

  test("RED: MemoryScope type covers all colony scopes", () => {
    // Compile-time check — verify all expected scopes exist
    const scopes: MemoryScope[] = [
      "episode", "fact", "observation", "scent", "preference",
      "private", "scar", "decision", "project", "heartwood",
      "growth_ring", "canopy", "identity",
    ];
    expect(scopes.length).toBe(13);
    // Each scope is a valid string
    for (const s of scopes) {
      expect(typeof s).toBe("string");
    }
  });

  test("RED: AgentMemoryEntry interface shape is correct", () => {
    const entry: AgentMemoryEntry = {
      id: "test-id",
      content: "test content",
      scope: "observation",
      tags: ["test"],
      confidence: 0.8,
      source: "test-script",
      createdAt: new Date().toISOString(),
    };
    expect(entry.id).toBe("test-id");
    expect(entry.content).toBe("test content");
    expect(entry.scope).toBe("observation");
    expect(entry.tags).toEqual(["test"]);
    expect(entry.confidence).toBe(0.8);
    expect(entry.source).toBe("test-script");
  });

  test("RED: AgentMemoryStore interface methods compile correctly", () => {
    // Create a mock store
    const store: AgentMemoryStore = {
      remember: async (entry) => ({
        id: "generated-id",
        content: entry.content,
        scope: entry.scope,
        tags: entry.tags ?? [],
        confidence: entry.confidence ?? 0.5,
        source: entry.source,
        createdAt: new Date().toISOString(),
      }),
      recall: async (query, opts) => [],
      bootstrap: async (opts) => [],
      forget: async (id) => {},
    };
    expect(store).toBeDefined();
    expect(typeof store.remember).toBe("function");
    expect(typeof store.recall).toBe("function");
    expect(typeof store.bootstrap).toBe("function");
    expect(typeof store.forget).toBe("function");
  });

  test("RED: AgentBootHooks all optional", () => {
    const hooks: AgentBootHooks = {};
    // All fields are optional — this should not error
    expect(hooks.beforeSoulRead).toBeUndefined();
    expect(hooks.afterSoulRead).toBeUndefined();
    expect(hooks.afterBootstrap).toBeUndefined();
  });
});
