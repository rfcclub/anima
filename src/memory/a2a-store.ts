// @deprecated — replaced by the standalone colony-mesh package (~/work/colony-mesh).
// Use `import { MeshBus } from "colony-mesh"` for all new code.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2AMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  thread_id: string | null;
  ts: string;
  read: number;
}

export interface A2AMessageInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  thread_id?: string;
}

// ---------------------------------------------------------------------------
// A2AStore
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = process.env.ANIMA_SESSIONS_DB ?? join(homedir(), ".anima", "sessions.db");

export class A2AStore {
  private readonly db: Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolved);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS a2a_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT    NOT NULL,
        to_agent   TEXT    NOT NULL,
        subject    TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        thread_id  TEXT,
        ts         TEXT    NOT NULL,
        read       INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_a2a_to ON a2a_messages(to_agent, read)",
    );
  }

  /** Insert a new message and return the full row. */
  send(input: A2AMessageInput): A2AMessage {
    const ts = new Date().toISOString();
    const threadId = input.thread_id ?? null;

    this.db.run(
      `INSERT INTO a2a_messages (from_agent, to_agent, subject, body, thread_id, ts, read)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [input.from, input.to, input.subject, input.body, threadId, ts],
    );

    const row = this.db.query<{ id: bigint }, []>(
      "SELECT last_insert_rowid() AS id",
    ).get()!;
    const id = Number(row.id);

    return {
      id,
      from_agent: input.from,
      to_agent: input.to,
      subject: input.subject,
      body: input.body,
      thread_id: threadId,
      ts,
      read: 0,
    };
  }

  /**
   * Read messages for a given agent inbox.
   * Optionally filter to unread only, or by thread_id.
   */
  readInbox(
    agent: string,
    unreadOnly?: boolean,
    threadId?: string,
  ): A2AMessage[] {
    let sql = "SELECT * FROM a2a_messages WHERE to_agent = ?";
    const params: SQLQueryBindings[] = [agent];

    if (unreadOnly) {
      sql += " AND read = 0";
    }
    if (threadId) {
      sql += " AND thread_id = ?";
      params.push(threadId);
    }

    sql += " ORDER BY id ASC";

    return this.db.query(sql).all(...params) as A2AMessage[];
  }

  /** Mark messages as read for a given agent. */
  markRead(agent: string, ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE a2a_messages SET read = 1 WHERE id IN (${placeholders}) AND to_agent = ?`,
      [...ids, agent],
    );
  }

  /** Count unread messages for an agent. */
  countUnread(agent: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM a2a_messages WHERE to_agent = ? AND read = 0",
      )
      .get(agent);
    return row?.count ?? 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
