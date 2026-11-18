import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbelMemBunAdapter } from "../src/memory/abel-mem-bun-adapter";
import type { AnimaEntityStore } from "../src/memory/anima-entity-store";
import type { AgentMemoryEntry } from "../src/memory/contract";
import { MemoryWriteError } from "../src/memory/errors";

/** A real abel-mem.db schema at a fresh temp path, for tests where the primary write must succeed. */
function makeSeededDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "abel-mem-test-"));
  const dbPath = join(dir, "abel-mem.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL,
      tags TEXT,
      abstraction_level TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      deactivated_at TEXT
    )
  `);
  db.close();
  return dbPath;
}

function makeEntry(
  overrides: Partial<Omit<AgentMemoryEntry, "id" | "createdAt">> = {},
): Omit<AgentMemoryEntry, "id" | "createdAt"> {
  return {
    content: overrides.content ?? "test observation",
    scope: overrides.scope ?? ("observation" as any),
    tags: overrides.tags ?? [],
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source ?? "abel",
    ...overrides,
  };
}

/** A fallback whose remember() always fails, for forcing total-failure scenarios. */
function brokenFallback(): AnimaEntityStore {
  return {
    initialize: async () => {},
    remember: async () => {
      throw new Error("fallback store unavailable");
    },
    recall: async () => [],
    forget: async () => {},
    bootstrap: async () => [],
  } as unknown as AnimaEntityStore;
}

describe("AbelMemBunAdapter.remember", () => {
  test("rejects with MemoryWriteError when both abel-mem and the fallback fail", async () => {
    // ":memory:" has no `memories` table, so the primary INSERT throws.
    const adapter = new AbelMemBunAdapter(":memory:", brokenFallback(), "abel");

    await expect(
      adapter.remember(makeEntry({ content: "should not silently succeed" })),
    ).rejects.toThrow(MemoryWriteError);
  });

  test("succeeds when primary write lands, even if the fallback fails", async () => {
    const adapter = new AbelMemBunAdapter(makeSeededDbPath(), brokenFallback(), "abel");

    const result = await adapter.remember(makeEntry({ content: "primary is durable" }));

    expect(result.id).toBeTruthy();
    expect(result.content).toBe("primary is durable");
  });

  test("succeeds via fallback id when abel-mem primary write fails", async () => {
    const fallbackEntry: AgentMemoryEntry = {
      id: "fallback-id-123",
      content: "written to fallback",
      scope: "observation",
      tags: [],
      confidence: 0.8,
      source: "abel",
      createdAt: new Date().toISOString(),
    };
    const workingFallback = {
      initialize: async () => {},
      remember: async () => fallbackEntry,
      recall: async () => [],
      forget: async () => {},
      bootstrap: async () => [],
    } as unknown as AnimaEntityStore;

    const adapter = new AbelMemBunAdapter(":memory:", workingFallback, "abel");

    const result = await adapter.remember(makeEntry({ content: "written to fallback" }));

    expect(result.id).toBe("fallback-id-123");
  });
});

describe("AbelMemBunAdapter.findByTag (M2 idempotent remember)", () => {
  test("finds a previously written entry carrying the exact tag", async () => {
    const adapter = new AbelMemBunAdapter(makeSeededDbPath(), brokenFallback(), "abel");
    const written = await adapter.remember(makeEntry({ content: "tagged entry", tags: ["idem:abc-123"] }));

    const found = await adapter.findByTag("idem:abc-123");

    expect(found?.id).toBe(written.id);
    expect(found?.content).toBe("tagged entry");
  });

  test("does not match a different tag, or a tag that is only a substring", async () => {
    const adapter = new AbelMemBunAdapter(makeSeededDbPath(), brokenFallback(), "abel");
    await adapter.remember(makeEntry({ content: "other entry", tags: ["idem:abc-123-extra"] }));

    const found = await adapter.findByTag("idem:abc-123");

    expect(found).toBeUndefined();
  });

  test("returns undefined when nothing carries the tag", async () => {
    const adapter = new AbelMemBunAdapter(makeSeededDbPath(), brokenFallback(), "abel");

    await expect(adapter.findByTag("idem:missing")).resolves.toBeUndefined();
  });
});
