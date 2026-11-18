import { test, expect, describe, mock } from "bun:test";
import type { AgentMemoryStore, AgentMemoryEntry } from "../../src/memory/contract";

// Mock store that returns test bootstrap entries
function createMockStore(entries: AgentMemoryEntry[]): AgentMemoryStore {
  return {
    remember: async (e) => ({
      id: "mock-id",
      ...e,
      createdAt: new Date().toISOString(),
    }),
    recall: async () => [],
    bootstrap: async () => entries,
  };
}

describe("runAgentBoot() — boot protocol", () => {
  test("RED: boot returns bootstrap entries from store", async () => {
    const { runAgentBoot } = await import("../../src/memory/boot");
    const expected: AgentMemoryEntry[] = [
      {
        id: "1",
        content: "test entry",
        scope: "observation",
        tags: [],
        confidence: 0.8,
        source: "test",
        createdAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(expected);
    const result = await runAgentBoot(store);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].content).toBe("test entry");
  });

  test("RED: boot runs without hooks", async () => {
    const { runAgentBoot } = await import("../../src/memory/boot");
    const store = createMockStore([]);
    const result = await runAgentBoot(store);
    expect(Array.isArray(result)).toBe(true);
  });

  test("RED: boot completes within 500ms for mock store", async () => {
    const { runAgentBoot } = await import("../../src/memory/boot");
    const store = createMockStore([]);
    const start = Date.now();
    await runAgentBoot(store);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test("RED: afterBootstrap hook can filter entries", async () => {
    const { runAgentBoot } = await import("../../src/memory/boot");
    const entries: AgentMemoryEntry[] = [
      {
        id: "1",
        content: "keep this",
        scope: "observation",
        tags: [],
        confidence: 0.9,
        source: "test",
        createdAt: new Date().toISOString(),
      },
      {
        id: "2",
        content: "filter this",
        scope: "fact",
        tags: [],
        confidence: 0.1,
        source: "test",
        createdAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(entries);
    const result = await runAgentBoot(store, {
      afterBootstrap: async (entries) => entries.filter((e) => e.confidence >= 0.5),
    });
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("keep this");
  });
});
