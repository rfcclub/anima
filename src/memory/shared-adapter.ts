import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { MemoryAdapter, MemoryEntry, RecallOptions } from "./adapter";
import { configureMemoryWal } from "./sqlite-wal";

/* ------------------------------------------------------------------ */
/*  SharedMemoryAdapter — bun:sqlite backed                             */
/* ------------------------------------------------------------------ */

/** Upper bound on LIKE terms per recall statement. */
const MAX_RECALL_WORDS = 32;

export class SharedMemoryAdapter implements MemoryAdapter {
  private db!: Database;
  private stmtCache = new Map<string, Statement>();

  constructor(dbPath?: string, preparedDb?: Database) {
    const path = dbPath ?? join(homedir(), ".anima", "memory.db");
    if (preparedDb) {
      this.db = preparedDb;
      this.createSchema();
      return;
    }
    this.init(path);
  }

  /** Used by agent startup so WAL recovery can wait without blocking the event loop. */
  static async open(dbPath: string): Promise<SharedMemoryAdapter> {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    try {
      await configureMemoryWal(db);
      return new SharedMemoryAdapter(dbPath, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private init(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id        INTEGER PRIMARY KEY,
        namespace TEXT NOT NULL,
        content   TEXT NOT NULL,
        type      TEXT NOT NULL DEFAULT 'observation',
        timestamp TEXT NOT NULL,
        metadata  TEXT
      )
    `);

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_namespace ON memories(namespace)",
    );
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------------ */
  /*  MemoryAdapter interface                                            */
  /* ------------------------------------------------------------------ */

  async store(entry: MemoryEntry): Promise<void> {
    const metaJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
    this.stmt(
      "INSERT INTO memories (namespace, content, type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)",
    ).run(entry.namespace, entry.content, entry.type, entry.timestamp, metaJson);
  }

  async recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]> {
    const namespace = opts?.namespace;
    const topK = opts?.topK ?? 5;
    // SQLite caps a compound SELECT at 500 terms, so a long query (a mesh prompt) used to throw.
    // Match on the first MAX_RECALL_WORDS distinct words, in one statement.
    const seen = new Set<string>();
    const words: string[] = [];
    for (const w of query.trim().split(/\s+/).filter(Boolean)) {
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(w);
      if (words.length === MAX_RECALL_WORDS) break;
    }

    if (words.length === 0) return [];

    const nsFilter = namespace ? " AND namespace = ?" : "";
    const sql = `SELECT * FROM memories WHERE (${words.map(() => "content LIKE ?").join(" OR ")})${nsFilter} LIMIT ?`;
    const params: unknown[] = words.map((w) => `%${w}%`);
    if (namespace) params.push(namespace);
    params.push(topK);

    const rows = this.stmt(sql).all(...params) as Row[];
    return rows.map((r) => this.mapEntry(r));
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  private stmt(sql: string): Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private mapEntry(row: Row): MemoryEntry {
    return {
      id: String(row.id),
      namespace: row.namespace as string,
      content: row.content as string,
      type: row.type as MemoryEntry["type"],
      timestamp: row.timestamp as string,
      metadata: row.metadata
        ? JSON.parse(row.metadata as string)
        : undefined,
    };
  }
}

type Row = Record<string, unknown>;
