import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const isBun = typeof process !== "undefined" && !!(process.versions as Record<string, string>).bun;

if (isBun) {
  const { test } = await import("bun:test");
  test("AnimaMemoryStore tests require Node.js runtime (skipped under Bun)", () => {});
} else {
  const { describe, test, expect, beforeAll, afterAll } = await import("vitest");
  const { AnimaMemoryStore } = await import("../src/memory-store");

  let testDir: string;

  function testDbPath(name: string): string {
    testDir = join(tmpdir(), `anima-oc-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    return join(testDir, `${name}.db`);
  }

  function cleanup() {
    if (testDir && existsSync(testDir)) {
      try { unlinkSync(join(testDir, "test-memory.db")); } catch {}
      try { unlinkSync(join(testDir, "test-memory.db-wal")); } catch {}
      try { unlinkSync(join(testDir, "test-memory.db-shm")); } catch {}
    }
  }

  describe("AnimaMemoryStore", () => {
    let store: AnimaMemoryStore;
    const dbPath = testDbPath("test-memory");

    beforeAll(async () => {
      store = new AnimaMemoryStore(dbPath);
      await store.initialize();
    });

    afterAll(() => {
      store.close();
      cleanup();
    });

    test("remember() stores an entry and returns it with id + createdAt", async () => {
      const entry = await store.remember({
        content: "Deploy script is at ~/deploy.sh",
        scope: "fact",
        tags: ["deploy", "infra"],
        confidence: 0.9,
        source: "test",
      });
      expect(entry.id).toBeDefined();
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.createdAt).toBeDefined();
      expect(entry.content).toBe("Deploy script is at ~/deploy.sh");
      expect(entry.scope).toBe("fact");
      expect(entry.tags).toEqual(["deploy", "infra"]);
      expect(entry.confidence).toBe(0.9);
      expect(entry.source).toBe("test");
    });

    test("recall() finds stored entries via FTS5", async () => {
      await store.remember({
        content: "User prefers dark mode everywhere",
        scope: "preference",
        tags: ["ux"],
        confidence: 0.8,
        source: "test",
      });
      await store.remember({
        content: "Project uses Bun for all tooling",
        scope: "fact",
        tags: ["tooling"],
        confidence: 0.95,
        source: "test",
      });

      const results = await store.recall("dark mode", { topK: 5 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.includes("dark mode"))).toBe(true);
    });

    test("recall() returns empty array for nonsense query", async () => {
      const results = await store.recall("xyznonexistent123", { topK: 5 });
      expect(results.length).toBe(0);
    });

    test("recall() filters by scope", async () => {
      await store.remember({
        content: "A fact about deployment",
        scope: "fact",
        tags: [],
        confidence: 0.7,
        source: "test",
      });
      await store.remember({
        content: "A preference about colors",
        scope: "preference",
        tags: [],
        confidence: 0.7,
        source: "test",
      });

      const factResults = await store.recall("about", { scopes: ["fact" as any], topK: 10 });
      expect(factResults.every((r) => r.scope === "fact")).toBe(true);
    });

    test("recall() filters by minimum confidence", async () => {
      await store.remember({
        content: "High confidence fact",
        scope: "fact",
        tags: [],
        confidence: 0.9,
        source: "test",
      });
      await store.remember({
        content: "Low confidence fact",
        scope: "fact",
        tags: [],
        confidence: 0.3,
        source: "test",
      });

      const highOnly = await store.recall("confidence fact", { minConfidence: 0.5, topK: 10 });
      expect(highOnly.every((r) => r.confidence >= 0.5)).toBe(true);
      expect(highOnly.some((r) => r.content === "High confidence fact")).toBe(true);
      expect(highOnly.some((r) => r.content === "Low confidence fact")).toBe(false);
    });

    test("bootstrap() returns recent entries", async () => {
      for (let i = 0; i < 5; i++) {
        await store.remember({
          content: `Bootstrap entry ${i}`,
          scope: "fact",
          tags: [],
          confidence: 0.8,
          source: "test",
        });
      }
      const results = await store.bootstrap({ maxEntries: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
      expect(results.length).toBeGreaterThan(0);
    });

    test("forget() removes an entry", async () => {
      const entry = await store.remember({
        content: "This will be forgotten",
        scope: "fact",
        tags: [],
        confidence: 0.5,
        source: "test",
      });
      await store.forget(entry.id);
      const results = await store.recall("forgotten", { topK: 5 });
      expect(results.some((r) => r.id === entry.id)).toBe(false);
    });

    test("forget() does not throw for nonexistent id", async () => {
      await expect(store.forget("nonexistent-id-12345")).resolves.toBeUndefined();
    });

    test("initialize() is idempotent", async () => {
      await store.initialize(); // second call should not throw
      // If we get here without error, test passes
    });
  });
}
