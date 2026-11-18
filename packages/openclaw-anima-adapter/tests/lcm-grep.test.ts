import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const isBun = typeof process !== "undefined" && !!(process.versions as Record<string, string>).bun;

if (isBun) {
  const { test } = await import("bun:test");
  test("lcm-grep tests require Node.js runtime (skipped under Bun)", () => {});
} else {
  const { describe, test, expect, beforeAll, afterAll } = await import("vitest");
  const { DatabaseSync } = await import("node:sqlite");
  const { createLcmGrepTool } = await import("../src/tools/lcm-grep");

  let testDir: string;
  let db: DatabaseSync;

  function setupDb(): DatabaseSync {
    testDir = join(tmpdir(), `lcm-grep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    const path = join(testDir, "context.db");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL");

    // Create tables matching @anima/context-engine schema
    database.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        seq INTEGER,
        role TEXT,
        content TEXT,
        token_count INTEGER,
        created_at TEXT
      )
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        kind TEXT,
        depth INTEGER,
        content TEXT,
        token_count INTEGER,
        created_at TEXT
      )
    `);
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='rowid'
      )
    `);
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
        content, content='summaries', content_rowid='rowid'
      )
    `);

    // Triggers for FTS sync
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
        INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `);

    // Insert test data
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg1", "conv1", 1, "user", "Authentication middleware for Express", 10, now);
    database.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg2", "conv1", 2, "assistant", "Here is the auth middleware implementation", 15, now);
    database.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg3", "conv1", 3, "user", "Deploy script for production", 8, now);

    return database;
  }

  function cleanup() {
    if (testDir && existsSync(testDir)) {
      try { unlinkSync(join(testDir, "context.db")); } catch {}
      try { unlinkSync(join(testDir, "context.db-wal")); } catch {}
      try { unlinkSync(join(testDir, "context.db-shm")); } catch {}
    }
  }

  describe("lcm-grep", () => {
    beforeAll(() => {
      db = setupDb();
    });

    afterAll(() => {
      db.close();
      cleanup();
    });

    test("searches messages via FTS5", async () => {
      const tool = createLcmGrepTool(() => db);
      const result = await tool.execute("test-id", { pattern: "auth", mode: "full_text" });
      expect(result.content[0].text).toContain("auth");
      expect(result.content[0].text).not.toContain("deploy");
    });

    test("returns 'No matches' for nonexistent query", async () => {
      const tool = createLcmGrepTool(() => db);
      const result = await tool.execute("test-id", { pattern: "xyznonexistent999", mode: "full_text" });
      expect(result.content[0].text).toBe("No matches found.");
    });

    test("hybrid sort produces no duplicate entries", async () => {
      // Insert enough entries to trigger the hybrid sort path
      const now = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        db.prepare(
          "INSERT INTO messages (id, conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(`dup${i}`, "conv2", i, "user", `Test message about deployment and auth ${i}`, 5, now);
      }
      const tool = createLcmGrepTool(() => db);
      const result = await tool.execute("test-id", { pattern: "deployment auth", mode: "full_text", sort: "hybrid" });

      // Parse results and check for duplicates
      const text = result.content[0].text;
      if (text !== "No matches found.") {
        const lines = text.split("\n").filter((l: string) => l.match(/^\d+\./));
        const ids = lines.map((l: string) => l.split(" ")[1]).filter(Boolean);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length); // No duplicates!
      }
    });

    test("since filter excludes older entries", async () => {
      const future = new Date(Date.now() + 86400000).toISOString(); // tomorrow
      const tool = createLcmGrepTool(() => db);
      const result = await tool.execute("test-id", { pattern: "deployment", mode: "full_text", since: future });
      expect(result.content[0].text).toBe("No matches found.");
    });
  });
}
