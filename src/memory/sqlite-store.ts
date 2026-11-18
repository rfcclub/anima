import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { JsonlEvent, RecoveryInfo, Store } from "./jsonl-store";
import { configureMemoryWal } from "./sqlite-wal";

const DEFAULT_DB_PATH = process.env.ANIMA_SESSIONS_DB ?? join(homedir(), ".anima", "sessions.db");

export class SqliteStore implements Store {
  private readonly db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH, preparedDb?: Database) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = preparedDb ?? new Database(dbPath);
    if (!preparedDb) {
      this.db.run("PRAGMA busy_timeout=5000");
      this.db.run("PRAGMA journal_mode=WAL");
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT    NOT NULL,
        date  TEXT    NOT NULL,
        idx   INTEGER NOT NULL,
        data  TEXT    NOT NULL,
        ts    TEXT    NOT NULL,
        UNIQUE(agent, date, idx) ON CONFLICT IGNORE
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_date ON events(agent, date)");
  }

  static async open(dbPath: string = DEFAULT_DB_PATH): Promise<SqliteStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      await configureMemoryWal(db);
      return new SqliteStore(dbPath, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  append(agent: string, event: JsonlEvent): void {
    const date = event.timestamp.slice(0, 10);
    this.db.run(
      `INSERT INTO events (agent, date, idx, data, ts)
       VALUES (?, ?, (SELECT COALESCE(MAX(idx)+1, 0) FROM events WHERE agent=? AND date=?), ?, ?)`,
      [agent, date, agent, date, JSON.stringify(event), event.timestamp],
    );
  }

  readDate(agent: string, date: string): JsonlEvent[] {
    const rows = this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM events WHERE agent=? AND date=? ORDER BY idx ASC",
      )
      .all(agent, date);
    return rows.map((r) => JSON.parse(r.data) as JsonlEvent);
  }

  readRecent(agent: string, count: number): JsonlEvent[] {
    const rows = this.db
      .query<{ data: string }, [string, number]>(
        "SELECT data FROM events WHERE agent=? ORDER BY date DESC, idx DESC LIMIT ?",
      )
      .all(agent, count);
    return rows.map((r) => JSON.parse(r.data) as JsonlEvent);
  }

  // SQLite is ACID — no file corruption recovery needed.
  recover(_agent: string, _date: string): RecoveryInfo | null {
    return null;
  }
}
