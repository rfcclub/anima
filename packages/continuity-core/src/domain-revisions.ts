/**
 * Plain append-only per-scope revision counter, owned entirely by
 * continuity-core. Never reads from any memory adapter's bootstrap()/recall().
 * A plain counter is used instead of hashing adapter bootstrap output, so
 * revisions never depend on adapter state.
 */

import { Database } from "bun:sqlite";
import type { LockedScope } from "./types.js";

const SENTINEL = "0";

export class DomainRevisions {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    // Must be set before journal_mode: competing writers (e.g. two
    // constructors racing to switch mode / CREATE TABLE IF NOT EXISTS on a
    // brand-new file, or two promote()s racing to increment) can hit
    // SQLITE_BUSY instead of waiting for the lock. busy_timeout makes SQLite
    // retry internally for up to 5s before throwing, rather than failing
    // immediately — and it only protects statements issued after it's set.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS domain_revisions (
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, scope)
      )
    `);
  }

  /** Returns the "0" sentinel when no row exists for (agentId, scope). */
  getRevision(agentId: string, scope: LockedScope): string {
    const row = this.db
      .query("SELECT revision FROM domain_revisions WHERE agent_id = ? AND scope = ?")
      .get(agentId, scope) as { revision: number } | null;
    return row ? String(row.revision) : SENTINEL;
  }

  /**
   * Atomic increment via a single UPSERT statement (no read-then-write race:
   * SQLite serializes the INSERT/UPDATE itself, so concurrent callers cannot
   * lose an increment the way a SELECT-then-computed-write would). Returns
   * the new value as a string.
   */
  incrementRevision(agentId: string, scope: LockedScope, now: number = Date.now()): string {
    const row = this.db
      .query(
        `INSERT INTO domain_revisions (agent_id, scope, revision, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(agent_id, scope) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at
         RETURNING revision`,
      )
      .get(agentId, scope, now) as { revision: number };
    return String(row.revision);
  }

  close(): void {
    this.db.close();
  }
}
