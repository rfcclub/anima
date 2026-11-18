import { describe, expect, test } from "bun:test";
import { NullMemoryAdapter } from "../src/memory/null-adapter";
import type { MemoryEntry } from "../src/memory/adapter";

const adapter = new NullMemoryAdapter();

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    namespace: overrides.namespace ?? "test-agent",
    content: overrides.content ?? "test content",
    type: overrides.type ?? "message",
    timestamp: overrides.timestamp ?? "2026-05-17T10:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  store() is a no-op                                                 */
/* ------------------------------------------------------------------ */

describe("NullMemoryAdapter.store", () => {
  test("does not throw", async () => {
    const entry = makeEntry();
    await expect(adapter.store(entry)).resolves.toBeUndefined();
  });

  test("has no side effects after multiple stores", async () => {
    await adapter.store(makeEntry({ content: "a" }));
    await adapter.store(makeEntry({ content: "b" }));
    await adapter.store(makeEntry({ content: "c" }));

    // Recall should still return empty
    const results = await adapter.recall("anything");
    expect(results).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  recall() always returns []                                          */
/* ------------------------------------------------------------------ */

describe("NullMemoryAdapter.recall", () => {
  test("returns empty array for any query", async () => {
    const results = await adapter.recall("some query");
    expect(results).toEqual([]);
  });

  test("returns empty array with namespace filter", async () => {
    const results = await adapter.recall("query", { namespace: "test-agent" });
    expect(results).toEqual([]);
  });

  test("returns empty array with topK", async () => {
    const results = await adapter.recall("query", { topK: 5 });
    expect(results).toEqual([]);
  });

  test("returns empty array with all opts", async () => {
    const results = await adapter.recall("query", { namespace: "common", topK: 10 });
    expect(results).toEqual([]);
  });
});
