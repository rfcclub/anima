/**
 * Continuity ledger (anima #1, Phase B).
 *
 * The canonical, durable record of captured continuity signals, plus the
 * outbound delivery work needed to reach the semantic backend. Where the
 * versioned envelope (`continuity-envelope.ts`) is pure shape validation, this
 * module owns transactions: a committed record and its delivery work land
 * together or not at all, and a retry of the same event can never create a
 * second canonical record.
 *
 * Deliberately not part of the memory store hierarchy: `AnimaEntityStore`
 * remains the durable local memory, and Hindsight remains a supplementary
 * semantic backend. This ledger is the authority for continuity records and for
 * what still needs delivery, so neither of those can silently become the source
 * of truth for identity.
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import {
  CONTINUITY_ENVELOPE_VERSION,
  collidedRecordKey,
  recordSignature,
  type CoalescedContinuityRecord,
  type ContinuityEnvelopeV1,
  type ContinuityVisibility,
} from "./continuity-envelope";

export type ContinuityOrigin = "native" | "hindsight-import";

export interface ContinuityRecord extends CoalescedContinuityRecord {
  origin: ContinuityOrigin;
  /** Canonical record that replaced this one, once supersession is explicit. */
  supersededBy?: string;
}

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface DeliveryWork {
  outboxId: string;
  recordKey: string;
  /** Stable document id sent to the backend; the same value on every retry. */
  documentId: string;
  attempts: number;
}

export interface DeliveryState {
  documentId: string;
  recordKey: string;
  status: DeliveryStatus;
  backendId?: string;
  version?: string;
  attempts: number;
  lastError?: string;
}

export interface CommitResult {
  created: boolean;
  record: ContinuityRecord;
  /** Present only for records that still need to reach the backend. */
  delivery?: DeliveryState;
}

export interface SubjectQuery {
  /** The identity whose continuity is being read. Required: there is no global read. */
  identity: string;
  /**
   * Visibility values the caller may read. Required, and empty means none:
   * an omitted or empty allowlist must never widen into "every visibility".
   */
  visibility: readonly ContinuityVisibility[];
  /** Evaluate expiry at this instant. Defaults to now. */
  at?: string;
}

export interface SubjectConflict {
  subject: string;
  recordKeys: string[];
  /** Unresolved contradictions stay explicit; this ledger never picks a winner. */
  unresolved: true;
}

const COLUMNS = `record_key, idempotency_key, identity, actor, visibility, source_kind, source_id,
  source_version, session_id, run_id, parent_run_id, event_time, ingested_at, kind, epistemic,
  parents_json, scope, content, subject, expires_at, origin, superseded_by`;

interface RecordRow {
  record_key: string;
  idempotency_key: string;
  identity: string;
  actor: string;
  visibility: string;
  source_kind: string;
  source_id: string;
  source_version: string;
  session_id: string | null;
  run_id: string | null;
  parent_run_id: string | null;
  event_time: string;
  ingested_at: string;
  kind: string;
  epistemic: string;
  parents_json: string;
  scope: string;
  content: string;
  subject: string | null;
  expires_at: string | null;
  origin: string;
  superseded_by: string | null;
}

interface DeliveryRow {
  outbox_id: string;
  record_key: string;
  document_id: string;
  status: string;
  backend_id: string | null;
  version: string | null;
  attempts: number;
  last_error: string | null;
  retry_at: number;
}

/** A record whose source came from a one-way Hindsight import must never flow back out. */
function originOf(envelope: ContinuityEnvelopeV1): ContinuityOrigin {
  return envelope.source.kind.startsWith("hindsight") ? "hindsight-import" : "native";
}

function toRecord(row: RecordRow): ContinuityRecord {
  return {
    version: CONTINUITY_ENVELOPE_VERSION,
    identity: row.identity,
    actor: row.actor,
    visibility: row.visibility as ContinuityVisibility,
    source: { kind: row.source_kind, id: row.source_id, version: row.source_version },
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    parentRunId: row.parent_run_id ?? undefined,
    eventTime: row.event_time,
    ingestedAt: row.ingested_at,
    kind: row.kind as ContinuityEnvelopeV1["kind"],
    epistemic: row.epistemic as ContinuityEnvelopeV1["epistemic"],
    parents: JSON.parse(row.parents_json) as string[],
    scope: row.scope as ContinuityEnvelopeV1["scope"],
    content: row.content,
    subject: row.subject ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    idempotencyKey: row.idempotency_key,
    recordKey: row.record_key,
    origin: row.origin as ContinuityOrigin,
    supersededBy: row.superseded_by ?? undefined,
  };
}

function toDelivery(row: DeliveryRow): DeliveryState {
  return {
    documentId: row.document_id,
    recordKey: row.record_key,
    status: row.status as DeliveryStatus,
    backendId: row.backend_id ?? undefined,
    version: row.version ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
  };
}

export class ContinuityLedger {
  private readonly db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_records (
        record_key     TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        identity       TEXT NOT NULL,
        actor          TEXT NOT NULL,
        visibility     TEXT NOT NULL,
        source_kind    TEXT NOT NULL,
        source_id      TEXT NOT NULL,
        source_version TEXT NOT NULL,
        session_id     TEXT,
        run_id         TEXT,
        parent_run_id  TEXT,
        event_time     TEXT NOT NULL,
        ingested_at    TEXT NOT NULL,
        kind           TEXT NOT NULL,
        epistemic      TEXT NOT NULL,
        parents_json   TEXT NOT NULL,
        scope          TEXT NOT NULL,
        content        TEXT NOT NULL,
        subject        TEXT,
        expires_at     TEXT,
        origin         TEXT NOT NULL,
        superseded_by  TEXT,
        created_at     TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_continuity_subject ON continuity_records(identity, subject, event_time)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_continuity_idempotency ON continuity_records(idempotency_key)",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_deliveries (
        outbox_id   TEXT PRIMARY KEY,
        record_key  TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL,
        status      TEXT NOT NULL,
        backend_id  TEXT,
        version     TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        retry_at    INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_continuity_deliveries_status ON continuity_deliveries(status, retry_at)",
    );
  }

  /**
   * Writes the canonical record and, for native records, its delivery work in
   * one immediate transaction.
   *
   * Identity is decided from the derived key *and* the observable signature of
   * the record, so a retry of the same event returns the existing record, while
   * a reused key with different content (changed number, date, negation or
   * outcome) is stored as a second event under a derived key instead of being
   * silently swallowed. A changed source version is simply a new key.
   */
  commit(envelope: ContinuityEnvelopeV1): CommitResult {
    const origin = originOf(envelope);
    const signature = recordSignature(envelope);

    return this.db.transaction((): CommitResult => {
      const sameKey = this.recordsByIdempotencyKey(envelope.idempotencyKey);
      const duplicate = sameKey.find((row) => recordSignature(toRecord(row)) === signature);
      if (duplicate) {
        const record = toRecord(duplicate);
        return { created: false, record, delivery: this.delivery(record.recordKey) };
      }

      const recordKey =
        sameKey.length === 0 ? envelope.idempotencyKey : collidedRecordKey(envelope.idempotencyKey, signature);
      const stored = this.recordByKey(recordKey);
      if (stored) {
        return { created: false, record: stored, delivery: this.delivery(stored.recordKey) };
      }

      this.db
        .query(
          `INSERT INTO continuity_records (${COLUMNS}, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recordKey,
          envelope.idempotencyKey,
          envelope.identity,
          envelope.actor,
          envelope.visibility,
          envelope.source.kind,
          envelope.source.id,
          envelope.source.version,
          envelope.sessionId ?? null,
          envelope.runId ?? null,
          envelope.parentRunId ?? null,
          envelope.eventTime,
          envelope.ingestedAt,
          envelope.kind,
          envelope.epistemic,
          JSON.stringify(envelope.parents),
          envelope.scope,
          envelope.content,
          envelope.subject ?? null,
          envelope.expiresAt ?? null,
          origin,
          null,
          new Date().toISOString(),
        );

      const record = this.recordByKey(recordKey)!;
      if (origin === "hindsight-import") {
        return { created: true, record };
      }

      // The backend document id is the canonical record key: stable across every
      // retry of this event, but distinct for a second event that reuses the
      // caller's idempotency key.
      const outboxId = `dp:${recordKey}`;
      this.db
        .query(
          `INSERT INTO continuity_deliveries (outbox_id, record_key, document_id, status, attempts, retry_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, 0, ?)`,
        )
        .run(outboxId, recordKey, recordKey, new Date().toISOString());

      return { created: true, record, delivery: this.delivery(recordKey) };
    }).immediate();
  }

  private recordsByIdempotencyKey(idempotencyKey: string): RecordRow[] {
    return this.db
      .query(`SELECT ${COLUMNS} FROM continuity_records WHERE idempotency_key = ? ORDER BY created_at, record_key`)
      .all(idempotencyKey) as RecordRow[];
  }

  /** Delivery work that is pending and past its backoff. Stable document ids, oldest first. */
  dueDeliveries(nowMs: number = Date.now()): DeliveryWork[] {
    const rows = this.db
      .query(
        `SELECT outbox_id, record_key, document_id, attempts FROM continuity_deliveries
         WHERE status IN ('pending', 'failed') AND retry_at <= ?
         ORDER BY updated_at, outbox_id`,
      )
      .all(nowMs) as Array<Pick<DeliveryRow, "outbox_id" | "record_key" | "document_id" | "attempts">>;
    return rows.map((row) => ({
      outboxId: row.outbox_id,
      recordKey: row.record_key,
      documentId: row.document_id,
      attempts: row.attempts,
    }));
  }

  /** The backend outcome is unknown: keep the same document id for the next attempt. */
  deliverUnknown(outboxId: string, error: string, retryAtMs: number = 0): void {
    this.db
      .query(
        `UPDATE continuity_deliveries
         SET status = 'failed', attempts = attempts + 1, last_error = ?, retry_at = ?, updated_at = ?
         WHERE outbox_id = ?`,
      )
      .run(error.slice(0, 300), retryAtMs, new Date().toISOString(), outboxId);
  }

  /** The backend confirmed the document; record its own id and version for reconciliation. */
  delivered(outboxId: string, result: { backendId: string; version?: string }): void {
    this.db
      .query(
        `UPDATE continuity_deliveries
         SET status = 'delivered', backend_id = ?, version = ?, last_error = NULL, updated_at = ?
         WHERE outbox_id = ?`,
      )
      .run(result.backendId, result.version ?? null, new Date().toISOString(), outboxId);
  }

  delivery(recordKey: string): DeliveryState | undefined {
    const row = this.db
      .query("SELECT * FROM continuity_deliveries WHERE record_key = ?")
      .get(recordKey) as DeliveryRow | undefined;
    return row ? toDelivery(row) : undefined;
  }

  recordByKey(recordKey: string): ContinuityRecord | undefined {
    const row = this.db
      .query(`SELECT ${COLUMNS} FROM continuity_records WHERE record_key = ?`)
      .get(recordKey) as RecordRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  records(): ContinuityRecord[] {
    return (this.db
      .query(`SELECT ${COLUMNS} FROM continuity_records ORDER BY ingested_at, record_key`)
      .all() as RecordRow[]).map(toRecord);
  }

  /**
   * Replaces an older record with a newer one. Only an explicit call does this:
   * a newer ingestion timestamp alone never establishes a newer real-world fact.
   *
   * The supersession itself is recorded as an audit decision whose parents are
   * both records. It carries no subject and no content of its own, so it can
   * never surface as current advice for a subject, and replaying the same
   * supersession (after a restart or a retry) is a no-op rather than a crash.
   */
  supersede(oldRecordKey: string, newRecordKey: string, reason: string): void {
    const auditKey = `${newRecordKey}:supersedes:${oldRecordKey}`;
    this.db.transaction(() => {
      if (this.recordByKey(auditKey)) return;
      if (!this.recordByKey(oldRecordKey) || !this.recordByKey(newRecordKey)) {
        throw new Error(`cannot supersede unknown record: ${oldRecordKey} -> ${newRecordKey}`);
      }

      this.db
        .query("UPDATE continuity_records SET superseded_by = ? WHERE record_key = ?")
        .run(newRecordKey, oldRecordKey);

      const now = new Date().toISOString();
      this.db
        .query(
          `INSERT INTO continuity_records (${COLUMNS}, created_at)
           SELECT ?, ?, identity, actor, visibility, source_kind, source_id, source_version,
                  session_id, run_id, parent_run_id, event_time, ?, 'decision', 'verified', ?,
                  scope, ?, NULL, expires_at, origin, NULL, ?
           FROM continuity_records WHERE record_key = ?`,
        )
        .run(
          auditKey,
          auditKey,
          now,
          JSON.stringify([oldRecordKey, newRecordKey]),
          `superseded by ${newRecordKey}: ${reason}`,
          now,
          oldRecordKey,
        );
    }).immediate();
  }

  /**
   * Records that still belong in current context for a subject: not superseded,
   * not expired at `at`, visible to the caller, and not older than the newest
   * event time for that subject.
   */
  currentForSubject(subject: string, options: SubjectQuery): ContinuityRecord[] {
    const at = options.at ?? new Date().toISOString();
    const rows = this.subjectRows(subject, options);
    const live = rows.filter(
      (row) => row.superseded_by === null && (row.expires_at === null || Date.parse(row.expires_at) > Date.parse(at)),
    );
    if (live.length === 0) return [];
    const newest = Math.max(...live.map((row) => Date.parse(row.event_time)));
    return live.filter((row) => Date.parse(row.event_time) === newest).map(toRecord);
  }

  /** Every record ever stored for a subject, including superseded and expired ones. */
  history(subject: string, options: SubjectQuery): ContinuityRecord[] {
    return this.subjectRows(subject, options)
      .sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time))
      .map(toRecord);
  }

  /**
   * Live records for a subject that disagree. Kept explicit: conflicting advice
   * is surfaced for review, never averaged into one confident answer.
   */
  conflicts(subject: string, options: SubjectQuery): SubjectConflict[] {
    const at = options.at ?? new Date().toISOString();
    const live = this.subjectRows(subject, options).filter(
      (row) => row.superseded_by === null && (row.expires_at === null || Date.parse(row.expires_at) > Date.parse(at)),
    );
    if (live.length < 2) return [];
    const byContent = new Map<string, string[]>();
    for (const row of live) {
      const keys = byContent.get(row.content) ?? [];
      keys.push(row.record_key);
      byContent.set(row.content, keys);
    }
    if (byContent.size < 2) return [];
    return [{ subject, recordKeys: live.map((row) => row.record_key), unresolved: true }];
  }

  private subjectRows(subject: string, options: SubjectQuery): RecordRow[] {
    if (options.visibility.length === 0) return [];
    const params: string[] = [subject, options.identity, ...options.visibility];
    const sql = `SELECT ${COLUMNS} FROM continuity_records
      WHERE subject = ? AND identity = ? AND visibility IN (${options.visibility.map(() => "?").join(", ")})`;
    return this.db.query(sql).all(...params) as RecordRow[];
  }

  close(): void {
    this.db.close();
  }
}
