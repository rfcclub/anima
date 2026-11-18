import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedMemoryAdapter } from "../src/memory/shared-adapter";
import type { MemoryEntry } from "../src/memory/adapter";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const testDb = join(tmpdir(), "anima-shared-test.db");

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    namespace: overrides.namespace ?? "test-agent",
    content: overrides.content ?? "test content",
    type: overrides.type ?? "observation",
    timestamp: overrides.timestamp ?? "2026-05-20T10:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  store()                                                            */
/* ------------------------------------------------------------------ */

describe("SharedMemoryAdapter.store", () => {
  let adapter: SharedMemoryAdapter;

  beforeAll(() => {
    adapter = new SharedMemoryAdapter(testDb);
  });

  afterAll(() => {
    adapter.close();
  });

  test("stores a single entry without throwing", async () => {
    const entry = makeEntry({ content: "hello world" });
    await expect(adapter.store(entry)).resolves.toBeUndefined();
  });

  test("stores multiple entries", async () => {
    await adapter.store(makeEntry({ content: "alpha", namespace: "ns-a" }));
    await adapter.store(makeEntry({ content: "beta", namespace: "ns-b" }));
    await adapter.store(makeEntry({ content: "gamma delta", namespace: "ns-a" }));
  });

  test("stores entry with metadata", async () => {
    const entry = makeEntry({
      content: "with metadata",
      metadata: { source: "test", priority: 1 },
    });
    await expect(adapter.store(entry)).resolves.toBeUndefined();
  });

  test("stores entry without metadata", async () => {
    const entry = makeEntry({ content: "no metadata", metadata: undefined });
    await expect(adapter.store(entry)).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  recall() — basic keyword search                                    */
/* ------------------------------------------------------------------ */

describe("SharedMemoryAdapter.recall", () => {
  let adapter: SharedMemoryAdapter;

  beforeAll(() => {
    adapter = new SharedMemoryAdapter(testDb);
  });

  afterAll(() => {
    adapter.close();
  });

  test("returns empty for non-matching query", async () => {
    const results = await adapter.recall("zzznonexistent");
    expect(results).toEqual([]);
  });

  test("finds entries by single keyword", async () => {
    const results = await adapter.recall("hello");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("hello");
  });

  test("returns entries matching any word (UNION)", async () => {
    const results = await adapter.recall("alpha beta");
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c === "alpha")).toBe(true);
    expect(contents.some((c) => c === "beta")).toBe(true);
  });

  test("respects topK limit", async () => {
    const results = await adapter.recall("a", { topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("uses default topK of 5", async () => {
    const results = await adapter.recall("a");
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------ */
/*  recall() — namespace filter                                        */
/* ------------------------------------------------------------------ */

describe("SharedMemoryAdapter.recall with namespace", () => {
  let adapter: SharedMemoryAdapter;

  beforeAll(() => {
    adapter = new SharedMemoryAdapter(testDb);
  });

  afterAll(() => {
    adapter.close();
  });

  test("filters by namespace", async () => {
    const results = await adapter.recall("alpha", { namespace: "ns-a" });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => expect(r.namespace).toBe("ns-a"));
  });

  test("returns empty when namespace has no matches", async () => {
    const results = await adapter.recall("alpha", { namespace: "ns-unknown" });
    expect(results).toEqual([]);
  });

  test("searches all namespaces when namespace not provided", async () => {
    const results = await adapter.recall("gamma");
    expect(results.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  recall() — entry shape                                             */
/* ------------------------------------------------------------------ */

describe("SharedMemoryAdapter.recall entry shape", () => {
  let adapter: SharedMemoryAdapter;

  beforeAll(() => {
    adapter = new SharedMemoryAdapter(testDb);
  });

  afterAll(() => {
    adapter.close();
  });

  test("returned entries have correct shape", async () => {
    const results = await adapter.recall("metadata");
    expect(results.length).toBeGreaterThan(0);
    const entry = results[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("namespace");
    expect(entry).toHaveProperty("content");
    expect(entry).toHaveProperty("type");
    expect(entry).toHaveProperty("timestamp");
  });

  test("metadata is parsed back to object", async () => {
    const results = await adapter.recall("with metadata");
    const entry = results.find((r) => r.metadata?.source === "test");
    expect(entry).toBeDefined();
    expect(entry!.metadata).toEqual({ source: "test", priority: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  recall() — empty query                                             */
/* ------------------------------------------------------------------ */

describe("SharedMemoryAdapter.recall edge cases", () => {
  let adapter: SharedMemoryAdapter;

  beforeAll(() => {
    adapter = new SharedMemoryAdapter(testDb);
  });

  afterAll(() => {
    adapter.close();
  });

  test("empty query returns empty array", async () => {
    const results = await adapter.recall("");
    expect(results).toEqual([]);
  });

  test("whitespace-only query returns empty array", async () => {
    const results = await adapter.recall("   ");
    expect(results).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Constructor — default path                                         */
/* ------------------------------------------------------------------ */

describe("SharedMemoryAdapter constructor", () => {
  test("default constructor does not throw", () => {
    const a = new SharedMemoryAdapter();
    a.close();
  });

  test("custom path constructor does not throw", () => {
    const customDb = join(tmpdir(), "anima-custom-test.db");
    const a = new SharedMemoryAdapter(customDb);
    a.close();
  });
});
