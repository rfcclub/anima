/**
 * TokenLedger — Cost tracking SQLite schema and log.
 *
 * `provider_calls` holds one parent row per actual leaf provider query;
 * `token_usage` holds the per-model usage detail (usage_version 2, referencing
 * the parent by call_id) and the legacy per-request rows (usage_version 1, no
 * parent). Token columns are nullable: NULL is "not reported", 0 is a measured
 * zero.
 */

import type { Database } from "bun:sqlite";
import type { WorkCallLink } from "../providers/interface";

export interface TokenLogEntry {
  sessionId: string;
  agentId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type CallStatus = "ok" | "error" | "aborted";
export type CallCoverage = "complete" | "partial" | "unknown";

/** One model's usage inside a call; a null count was not reported. */
export interface CallDetail {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface CallRecord {
  callId: string;
  agentId: string;
  /** The conversation, when the request carried one. */
  sessionId?: string | null;
  /** Explicit identifier of a non-session path (for example "compactor"). */
  pathId?: string | null;
  /** The leaf provider's name. */
  backend: string;
  /** ISO-8601 UTC instant the query started. */
  startedAt: string;
  latencyMs: number;
  status: CallStatus;
  coverage: CallCoverage;
  details: CallDetail[];
  /** The castle work this call was made for, when it was made for one (anima #135). */
  work?: WorkCallLink;
}

const TOKEN_USAGE_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  call_id TEXT,
  usage_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(call_id, model)
`;

export class TokenLedger {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS provider_calls (
        call_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        path_id TEXT,
        backend TEXT NOT NULL,
        started_at TEXT NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'aborted')),
        coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unknown')),
        work_id TEXT,
        job_id TEXT,
        claim_id TEXT,
        session_no INTEGER
      )
    `);
    // anima #135: a database written before the work links existed gains the nullable columns; no row changes.
    const callColumns = (this.db.query("PRAGMA table_info(provider_calls)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ["work_id TEXT", "job_id TEXT", "claim_id TEXT", "session_no INTEGER"]) {
      if (!callColumns.includes(column.split(" ")[0]!)) this.db.run(`ALTER TABLE provider_calls ADD COLUMN ${column}`);
    }
    this.db.run("CREATE INDEX IF NOT EXISTS idx_provider_calls_work ON provider_calls(work_id, started_at)");

    const info = this.db.query("PRAGMA table_info(token_usage)").all() as Array<{ name: string; notnull: number }>;
    if (info.length === 0) {
      this.db.run(`CREATE TABLE token_usage (${TOKEN_USAGE_COLUMNS})`);
    } else if (!info.some((c) => c.name === "call_id") || info.find((c) => c.name === "input_tokens")?.notnull === 1) {
      this.rebuildTokenUsage();
    }

    // The _v2 names differ from the old indexes, which stay attached to token_usage_v1_backup
    // after a migration (an index name cannot be reused while that table exists).
    this.db.run("CREATE INDEX IF NOT EXISTS idx_token_usage_agent_v2 ON token_usage(agent_id, created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_token_usage_model_v2 ON token_usage(model, created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_token_usage_session_v2 ON token_usage(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_token_usage_call ON token_usage(call_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_provider_calls_started ON provider_calls(started_at)");
  }

  /** One transaction: copy every legacy row (id, values, timestamp) into the
   *  nullable v2 shape as usage_version 1, check the copy is complete, then swap
   *  the tables by renaming. Nothing is deleted: the original table stays as
   *  `token_usage_v1_backup` until an operator removes it. Any error rolls back
   *  and leaves the original table in place. */
  private rebuildTokenUsage(): void {
    this.db.transaction(() => {
      const seq = this.db.query("SELECT seq FROM sqlite_sequence WHERE name = 'token_usage'").get() as { seq: number } | null;
      this.db.run(`CREATE TABLE token_usage_v2 (${TOKEN_USAGE_COLUMNS})`);
      this.db.run(`
        INSERT INTO token_usage_v2
          (id, session_id, agent_id, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, created_at, call_id, usage_version)
        SELECT id, session_id, agent_id, provider, model, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, created_at, NULL, 1
        FROM token_usage
      `);
      const before = (this.db.query("SELECT COUNT(*) AS n FROM token_usage").get() as { n: number }).n;
      const after = (this.db.query("SELECT COUNT(*) AS n FROM token_usage_v2").get() as { n: number }).n;
      if (before !== after) throw new Error(`token_usage migration copied ${after} of ${before} rows`);
      this.db.run("ALTER TABLE token_usage RENAME TO token_usage_v1_backup");
      this.db.run("ALTER TABLE token_usage_v2 RENAME TO token_usage");
      if (seq) this.db.run("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'token_usage'", [seq.seq]);
    })();
  }

  log(entry: TokenLogEntry): number {
    const result = this.db.run(
      `INSERT INTO token_usage
         (session_id, agent_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.sessionId,
        entry.agentId,
        entry.provider,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens ?? 0,
        entry.cacheWriteTokens ?? 0,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  /** Writes or updates a call and its model details in one transaction, keyed
   *  by call_id: a later settlement of the same call replaces the parent's
   *  outcome and the detail set, never adds a second record. */
  recordCall(call: CallRecord): void {
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      throw new RangeError(`latencyMs must be a non-negative number, got ${call.latencyMs}`);
    }
    const sessionKey = call.sessionId ?? call.pathId ?? "unknown";
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO provider_calls
           (call_id, agent_id, session_id, path_id, backend, started_at, latency_ms, status, coverage, work_id, job_id, claim_id, session_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET
           agent_id = excluded.agent_id, session_id = excluded.session_id, path_id = excluded.path_id,
           backend = excluded.backend, started_at = excluded.started_at, latency_ms = excluded.latency_ms,
           status = excluded.status, coverage = excluded.coverage,
           work_id = excluded.work_id, job_id = excluded.job_id, claim_id = excluded.claim_id, session_no = excluded.session_no`,
        [call.callId, call.agentId, call.sessionId ?? null, call.pathId ?? null, call.backend, call.startedAt, call.latencyMs, call.status, call.coverage,
          call.work?.workId ?? null, call.work?.jobId ?? null, call.work?.claimId ?? null, call.work?.sessionNo ?? null],
      );
      const models = call.details.map((d) => d.model);
      const keep = models.map(() => "?").join(", ");
      // Detail rows of this one call that a later settlement no longer lists. The WHERE is
      // scoped to call_id; a reviewer must confirm it stays scoped (never a bulk removal).
      this.db.run(
        `DELETE FROM token_usage WHERE call_id = ?${models.length > 0 ? ` AND model NOT IN (${keep})` : ""}`,
        [call.callId, ...models],
      );
      for (const d of call.details) {
        this.db.run(
          `INSERT INTO token_usage
             (session_id, agent_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, call_id, usage_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2)
           ON CONFLICT(call_id, model) DO UPDATE SET
             session_id = excluded.session_id, agent_id = excluded.agent_id, provider = excluded.provider,
             input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
             cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens`,
          [sessionKey, call.agentId, call.backend, d.model, d.inputTokens, d.outputTokens, d.cacheReadTokens, d.cacheWriteTokens, call.callId],
        );
      }
    })();
  }
}
