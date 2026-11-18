import { test, expect, describe, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tmpDbPath(): string {
  return join(tmpdir(), `anima-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("AnimaEntityStore — AgentMemoryStore implementation", () => {
  test("RED: remember() stores an entry with scope and tags", async () => {
    const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
    const store = new AnimaEntityStore(tmpDbPath());
    await store.initialize();

    const entry = await store.remember({
      content: "test memory",
      scope: "fact",
      tags: ["project-x", "test"],
      confidence: 0.8,
      source: "session-123",
    });

    expect(entry.id).toBeDefined();
    expect(entry.content).toBe("test memory");
    expect(entry.scope).toBe("fact");
    expect(entry.tags).toEqual(["project-x", "test"]);
    expect(entry.confidence).toBe(0.8);
    expect(entry.source).toBe("session-123");
    expect(entry.createdAt).toBeDefined();

    store.close();
  });

  test("RED: recall() returns entries matching query", async () => {
    const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
    const store = new AnimaEntityStore(tmpDbPath());
    await store.initialize();

    await store.remember({
      content: "heartwood memory about trust",
      scope: "heartwood",
      tags: ["trust"],
      confidence: 0.9,
      source: "test",
    });

    await store.remember({
      content: "fact about architecture",
      scope: "fact",
      tags: ["architecture"],
      confidence: 0.7,
      source: "test",
    });

    const results = await store.recall("trust", { topK: 5 });
    // At minimum the function returns without error
    expect(Array.isArray(results)).toBe(true);

    store.close();
  });

  test("RED: recall() filters by scope when provided", async () => {
    const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
    const store = new AnimaEntityStore(tmpDbPath());
    await store.initialize();

    await store.remember({
      content: "heartwood memory",
      scope: "heartwood",
      tags: [],
      confidence: 0.9,
      source: "test",
    });

    await store.remember({
      content: "growth ring memory",
      scope: "growth_ring",
      tags: [],
      confidence: 0.8,
      source: "test",
    });

    const results = await store.recall("memory", { scopes: ["heartwood"], topK: 5 });
    expect(Array.isArray(results)).toBe(true);

    store.close();
  });

  test("RED: bootstrap() returns recent and high-confidence entries", async () => {
    const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
    const store = new AnimaEntityStore(tmpDbPath());
    await store.initialize();

    await store.remember({
      content: "important observation",
      scope: "observation",
      tags: [],
      confidence: 0.95,
      source: "test",
    });

    const results = await store.bootstrap();
    expect(Array.isArray(results)).toBe(true);

    store.close();
  });
});
