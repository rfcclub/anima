import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnimaEntityStore } from "../../src/memory/anima-entity-store";
import { BunContextEngineImpl } from "../../src/memory/context-store";
import { SharedMemoryAdapter } from "../../src/memory/shared-adapter";
import { SessionStore } from "../../src/memory/session-store";
import { SqliteStore } from "../../src/memory/sqlite-store";

const cases = [
  { name: "entity", failAt: /CREATE TABLE IF NOT EXISTS neurons\s*\(/i, open: async (path: string) => new AnimaEntityStore(path).initialize() },
  { name: "context", failAt: /CREATE TABLE IF NOT EXISTS conversations\s*\(/i, open: async (path: string) => new BunContextEngineImpl(path).initialize("test", "anima") },
  { name: "shared", failAt: /CREATE TABLE IF NOT EXISTS memories\s*\(/i, open: async (path: string) => SharedMemoryAdapter.open(path) },
  { name: "session", failAt: /CREATE TABLE IF NOT EXISTS sessions\s*\(/i, open: async (path: string) => SessionStore.open(path) },
  { name: "event", failAt: /CREATE TABLE IF NOT EXISTS events\s*\(/i, open: async (path: string) => SqliteStore.open(path) },
];

async function checkCleanup(scenario: (typeof cases)[number]): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "anima-wal-cleanup-"));
    const dbPath = join(dir, "store.db");
    const originalExec = Database.prototype.exec;
    const originalRun = Database.prototype.run;
    let opened: Database | undefined;
    for (const method of ["exec", "run"] as const) {
      const original = Database.prototype[method];
      (Database.prototype as any)[method] = function(this: Database, sql: string, ...bindings: unknown[]) {
        if (this.filename === dbPath) {
          if (/^PRAGMA\s+journal_mode\s*=\s*WAL/i.test(sql)) opened = this;
          if (scenario.failAt.test(sql)) throw new Error(`injected ${scenario.name} initialization failure`);
        }
        return Reflect.apply(original, this, [sql, ...bindings]);
      };
    }
    try {
      await expect(scenario.open(dbPath)).rejects.toThrow(`injected ${scenario.name} initialization failure`);
      expect(opened).toBeDefined();
      expect(() => opened!.query("SELECT 1").get()).toThrow();
    } finally {
      Database.prototype.exec = originalExec;
      Database.prototype.run = originalRun;
      try { opened?.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
}

test("entity closes its SQLite connection after a post-WAL initialization error", () => checkCleanup(cases[0]!));
test("context closes its SQLite connection after a post-WAL initialization error", () => checkCleanup(cases[1]!));
test("shared closes its SQLite connection after a post-WAL initialization error", () => checkCleanup(cases[2]!));
test("session closes its SQLite connection after a post-WAL initialization error", () => checkCleanup(cases[3]!));
test("event closes its SQLite connection after a post-WAL initialization error", () => checkCleanup(cases[4]!));

test("context schema can be initialized twice on an existing database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anima-context-repeat-"));
  const dbPath = join(dir, "context.db");
  try {
    const first = new BunContextEngineImpl(dbPath);
    await first.initialize("test", "anima");
    first.dispose();
    const second = new BunContextEngineImpl(dbPath);
    await second.initialize("test", "anima");
    expect(second.getDb().query("SELECT count(*) AS n FROM conversations").get()).toEqual({ n: 0 });
    second.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
