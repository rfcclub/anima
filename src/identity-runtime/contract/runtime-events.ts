import { Database } from "bun:sqlite";

export type RuntimeEventKind =
  | "join"
  | "scope_rejected"
  | "mutation_rejected"
  | "proposal_held"
  | "promotion";

export interface IdentityRuntimeEvent {
  id: string;
  kind: RuntimeEventKind;
  agentId: string;
  surfaceId: string;
  leaseId: string;
  projectionId: string;
  stateHash: string;
  sourceClient: string;
  outcome: string;
  createdAt: number;
}

export class RuntimeEventStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS identity_runtime_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        source_client TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_identity_runtime_events ON identity_runtime_events(agent_id, created_at DESC)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS identity_runtime_state (
        agent_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS identity_runtime_mutations (
        agent_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        PRIMARY KEY (agent_id, lease_id, operation, idempotency_key)
      )
    `);
    this.migrateMutationsCreatedAt();
  }

  /** identity_runtime_mutations predates created_at; add it for DBs made before M2. */
  private migrateMutationsCreatedAt(): void {
    const columns = this.db.query("PRAGMA table_info(identity_runtime_mutations)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "created_at")) {
      this.db.run("ALTER TABLE identity_runtime_mutations ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    }
  }

  append(event: IdentityRuntimeEvent): void {
    this.db.run(
      `INSERT INTO identity_runtime_events
        (id, kind, agent_id, surface_id, lease_id, projection_id, state_hash, source_client, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.kind, event.agentId, event.surfaceId, event.leaseId, event.projectionId,
        event.stateHash, event.sourceClient, event.outcome, event.createdAt],
    );
  }

  list(agentId: string, limit: number): IdentityRuntimeEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    return this.db.query(
      `SELECT id, kind, agent_id, surface_id, lease_id, projection_id, state_hash, source_client, outcome, created_at
       FROM identity_runtime_events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(agentId, boundedLimit).map((row) => rowToEvent(row as RuntimeEventRow));
  }

  listForLease(agentId: string, leaseId: string, limit: number): IdentityRuntimeEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    return this.db.query(
      `SELECT id, kind, agent_id, surface_id, lease_id, projection_id, state_hash, source_client, outcome, created_at
       FROM identity_runtime_events WHERE agent_id = ? AND lease_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(agentId, leaseId, boundedLimit).map((row) => rowToEvent(row as RuntimeEventRow));
  }

  revision(agentId: string): number {
    this.db.run("INSERT OR IGNORE INTO identity_runtime_state (agent_id, revision) VALUES (?, 0)", [agentId]);
    const row = this.db.query("SELECT revision FROM identity_runtime_state WHERE agent_id = ?").get(agentId) as { revision: number };
    return row.revision;
  }

  /** Atomically reserves the next state revision; false means another client won. */
  advanceRevision(agentId: string, expectedRevision: number): boolean {
    this.db.run("INSERT OR IGNORE INTO identity_runtime_state (agent_id, revision) VALUES (?, 0)", [agentId]);
    const result = this.db.run(
      "UPDATE identity_runtime_state SET revision = revision + 1 WHERE agent_id = ? AND revision = ?",
      [agentId, expectedRevision],
    );
    return result.changes === 1;
  }

  rollbackRevision(agentId: string, expectedRevision: number): boolean {
    const result = this.db.run(
      "UPDATE identity_runtime_state SET revision = revision - 1 WHERE agent_id = ? AND revision = ? AND revision > 0",
      [agentId, expectedRevision + 1],
    );
    return result.changes === 1;
  }

  claimMutation(
    agentId: string,
    leaseId: string,
    operation: string,
    idempotencyKey: string,
    now: number = Date.now(),
  ): "claimed" | "pending" | { result: Record<string, unknown> } {
    const existing = this.db.query(
      "SELECT status, result_json FROM identity_runtime_mutations WHERE agent_id = ? AND lease_id = ? AND operation = ? AND idempotency_key = ?",
    ).get(agentId, leaseId, operation, idempotencyKey) as { status: string; result_json: string | null } | null;
    if (existing?.status === "completed" && existing.result_json) return { result: JSON.parse(existing.result_json) as Record<string, unknown> };
    if (existing) return "pending";
    const pending = this.db.query(
      "SELECT 1 FROM identity_runtime_mutations WHERE agent_id = ? AND status = 'pending' LIMIT 1",
    ).get(agentId);
    if (pending) return "pending";
    this.db.run(
      "INSERT INTO identity_runtime_mutations (agent_id, lease_id, operation, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      [agentId, leaseId, operation, idempotencyKey, now],
    );
    return "claimed";
  }

  /** Pending rows for this agent, oldest first is not guaranteed; callers sort by createdAt if needed. */
  pendingMutations(agentId: string): Array<{ leaseId: string; operation: string; idempotencyKey: string; createdAt: number }> {
    return this.db.query(
      "SELECT lease_id, operation, idempotency_key, created_at FROM identity_runtime_mutations WHERE agent_id = ? AND status = 'pending'",
    ).all(agentId).map((row) => {
      const typed = row as { lease_id: string; operation: string; idempotency_key: string; created_at: number };
      return {
        leaseId: typed.lease_id,
        operation: typed.operation,
        idempotencyKey: typed.idempotency_key,
        createdAt: typed.created_at,
      };
    });
  }

  completeMutation(agentId: string, leaseId: string, operation: string, idempotencyKey: string, result: Record<string, unknown>): void {
    this.db.run(
      "UPDATE identity_runtime_mutations SET status = 'completed', result_json = ? WHERE agent_id = ? AND lease_id = ? AND operation = ? AND idempotency_key = ?",
      [JSON.stringify(result), agentId, leaseId, operation, idempotencyKey],
    );
  }

  abandonMutation(agentId: string, leaseId: string, operation: string, idempotencyKey: string): void {
    this.db.run(
      "DELETE FROM identity_runtime_mutations WHERE agent_id = ? AND lease_id = ? AND operation = ? AND idempotency_key = ? AND status = 'pending'",
      [agentId, leaseId, operation, idempotencyKey],
    );
  }

  hasPendingMutation(agentId: string): boolean {
    return Boolean(this.db.query(
      "SELECT 1 FROM identity_runtime_mutations WHERE agent_id = ? AND status = 'pending' LIMIT 1",
    ).get(agentId));
  }

  close(): void { this.db.close(); }
}

interface RuntimeEventRow {
  id: string;
  kind: RuntimeEventKind;
  agent_id: string;
  surface_id: string;
  lease_id: string;
  projection_id: string;
  state_hash: string;
  source_client: string;
  outcome: string;
  created_at: number;
}

function rowToEvent(row: RuntimeEventRow): IdentityRuntimeEvent {
  return {
    id: row.id,
    kind: row.kind,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    leaseId: row.lease_id,
    projectionId: row.projection_id,
    stateHash: row.state_hash,
    sourceClient: row.source_client,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}
