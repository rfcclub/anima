import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type AttentionState = "open" | "claimed" | "acted" | "resolved" | "blocked" | "expired";
export type BudgetScope = "colony" | "agent";

export interface AttentionInput {
  id?: string;
  agentId: string;
  sourceKind: string;
  sourceRef: string;
  occurrenceKey: string;
  kind: string;
  urgency: number;
  summary: string;
  openedAt: number;
  dueAt: number;
  expiresAt?: number;
  lastEventId: string;
}

export interface AttentionItem extends AttentionInput {
  id: string;
  state: AttentionState;
  claimedAt: number | null;
  actedAt: number | null;
  resolvedAt: number | null;
  version: number;
}

export type AttentionTransition = { ok: true; item: AttentionItem } | { ok: false; reason: "version-conflict" | "illegal-transition" | "not-found" };
export type LeaseAcquisition = { ok: true; leaseId: string } | { ok: false; reason: "already-leased" };
export type BudgetReservation = { ok: true } | { ok: false; reason: "agent-budget" | "colony-budget" };

export interface LeaseInput {
  id: string;
  candidateKey: string;
  agentId: string;
  executor: string;
  costClass: "T0" | "T1" | "T2";
  now: number;
  expiresAt: number;
}

export interface ReserveBudgetInput {
  leaseId: string;
  day: string;
  agentId: string;
  units: number;
  colonyLimit: number;
  agentLimit: number;
  now: number;
}

/** The original mesh request, kept so a session runs on it and can reply. */
export interface MeshSource {
  agentId: string;
  sourceRef: string;
  fromId: string;
  fromPlatform: string | null;
  threadId: string | null;
  subject: string;
  content: string;
  role: string;
  createdAt: number;
  attempts: number;
  repliedAt: number | null;
}

export type MeshSourceInput = Omit<MeshSource, "attempts" | "repliedAt">;

export interface StoredCommitment {
  id: string; agentId: string; sourceRef: string; authorityRef: string; description: string;
  acceptedAt: number; nextReviewAt: number; dueAt?: number; expiresAt?: number;
}

export interface StoredStewardship {
  id: string; agentId: string; scopeRef: string; responsibility: string;
  cadenceMs: number; nextReviewAt: number; lastReviewAt?: number; enabled?: boolean;
}

const TERMINAL_STATES = new Set<AttentionState>(["resolved", "blocked", "expired"]);
const LEGAL_TRANSITIONS: Record<AttentionState, readonly AttentionState[]> = {
  open: ["claimed", "expired"],
  claimed: ["open", "acted"],
  acted: ["resolved", "blocked"],
  resolved: [],
  blocked: [],
  expired: [],
};

export class ActivationStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=3000");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  schemaObjects(): string[] {
    return (this.db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
  }

  projectAttention(input: AttentionInput): AttentionItem {
    return this.transaction(() => {
      const existing = this.db.query(`
        SELECT * FROM attention_items
        WHERE agent_id = ? AND source_kind = ? AND source_ref = ? AND occurrence_key = ?
      `).get(input.agentId, input.sourceKind, input.sourceRef, input.occurrenceKey) as Record<string, unknown> | null;
      if (existing) {
        this.db.run(`
          UPDATE attention_items
          SET kind = ?, urgency = ?, summary = ?, due_at = ?, expires_at = ?, last_event_id = ?, version = version + 1
          WHERE id = ?
        `, [input.kind, input.urgency, input.summary, input.dueAt, input.expiresAt ?? null, input.lastEventId, existing.id as string]);
        return this.requireAttention(existing.id as string);
      }

      const id = input.id ?? crypto.randomUUID();
      this.db.run(`
        INSERT INTO attention_items (
          id, agent_id, source_kind, source_ref, occurrence_key, kind, state, urgency, summary,
          opened_at, due_at, expires_at, last_event_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 1)
      `, [id, input.agentId, input.sourceKind, input.sourceRef, input.occurrenceKey, input.kind, input.urgency, input.summary,
        input.openedAt, input.dueAt, input.expiresAt ?? null, input.lastEventId]);
      return this.requireAttention(id);
    });
  }

  getAttention(id: string): AttentionItem | null {
    const row = this.db.query("SELECT * FROM attention_items WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapAttention(row) : null;
  }

  /** Stable occurrence lookup for event replay; callers never need a local row id. */
  getAttentionByOccurrence(agentId: string, sourceKind: string, sourceRef: string, occurrenceKey: string): AttentionItem | null {
    const row = this.db.query(`SELECT * FROM attention_items
      WHERE agent_id = ? AND source_kind = ? AND source_ref = ? AND occurrence_key = ?`)
      .get(agentId, sourceKind, sourceRef, occurrenceKey) as Record<string, unknown> | null;
    return row ? mapAttention(row) : null;
  }

  openAttention(agentId?: string): AttentionItem[] {
    const query = agentId
      ? this.db.query("SELECT * FROM attention_items WHERE state = 'open' AND agent_id = ? ORDER BY due_at, id")
      : this.db.query("SELECT * FROM attention_items WHERE state = 'open' ORDER BY due_at, id");
    const rows = (agentId ? query.all(agentId) : query.all()) as Array<Record<string, unknown>>;
    return rows.map(mapAttention);
  }

  transitionAttention(id: string, expectedVersion: number, nextState: AttentionState, at: number): AttentionTransition {
    return this.transaction(() => {
      const current = this.getAttention(id);
      if (!current) return { ok: false, reason: "not-found" };
      if (current.version !== expectedVersion) return { ok: false, reason: "version-conflict" };
      if (!LEGAL_TRANSITIONS[current.state].includes(nextState)) return { ok: false, reason: "illegal-transition" };

      const timestampColumn = nextState === "claimed" ? "claimed_at"
        : nextState === "acted" ? "acted_at"
          : TERMINAL_STATES.has(nextState) ? "resolved_at" : null;
      const result = timestampColumn
        ? this.db.run(`UPDATE attention_items SET state = ?, ${timestampColumn} = ?, version = version + 1 WHERE id = ? AND version = ?`, [nextState, at, id, expectedVersion])
        : this.db.run("UPDATE attention_items SET state = ?, version = version + 1 WHERE id = ? AND version = ?", [nextState, id, expectedVersion]);
      if (result.changes !== 1) return { ok: false, reason: "version-conflict" };
      return { ok: true, item: this.requireAttention(id) };
    });
  }

  acquireLease(input: LeaseInput): LeaseAcquisition {
    return this.transaction(() => {
      const active = this.db.query("SELECT id FROM activation_leases WHERE candidate_key = ? AND status = 'active'").get(input.candidateKey);
      if (active) return { ok: false, reason: "already-leased" };
      this.db.run(`
        INSERT INTO activation_leases (id, candidate_key, agent_id, executor, cost_class, status, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `, [input.id, input.candidateKey, input.agentId, input.executor, input.costClass, input.now, input.expiresAt]);
      return { ok: true, leaseId: input.id };
    });
  }

  releaseLease(leaseId: string, now: number): boolean {
    return this.transaction(() => {
      const result = this.db.run("UPDATE activation_leases SET status = 'released', completed_at = ? WHERE id = ? AND status = 'active'", [now, leaseId]);
      if (result.changes !== 1) return false;
      this.finishBudgetReservationInTransaction(leaseId, now, "released");
      return true;
    });
  }

  releaseExpiredLeases(now: number): string[] {
    return this.transaction(() => {
      const rows = this.db.query("SELECT id FROM activation_leases WHERE status = 'active' AND expires_at <= ?").all(now) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      this.db.run("UPDATE activation_leases SET status = 'released', completed_at = ? WHERE status = 'active' AND expires_at <= ?", [now, now]);
      for (const { id } of rows) this.finishBudgetReservationInTransaction(id, now, "released");
      return rows.map((row) => row.id);
    });
  }

  upsertCommitment(input: StoredCommitment): void {
    this.db.run(`INSERT INTO commitments (id, agent_id, source_ref, authority_ref, description, status, accepted_at, due_at, next_review_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)
      ON CONFLICT(agent_id, source_ref) DO UPDATE SET authority_ref = excluded.authority_ref, description = excluded.description, due_at = excluded.due_at, next_review_at = excluded.next_review_at, expires_at = excluded.expires_at`,
    [input.id, input.agentId, input.sourceRef, input.authorityRef, input.description, input.acceptedAt, input.dueAt ?? null, input.nextReviewAt, input.expiresAt ?? null]);
  }

  dueCommitments(now: number): StoredCommitment[] {
    return (this.db.query(`SELECT * FROM commitments WHERE status = 'accepted' AND next_review_at <= ? AND (expires_at IS NULL OR expires_at > ?)`)
      .all(now, now) as Array<Record<string, unknown>>).map((row) => ({ id: row.id as string, agentId: row.agent_id as string, sourceRef: row.source_ref as string, authorityRef: row.authority_ref as string, description: row.description as string, acceptedAt: row.accepted_at as number, dueAt: row.due_at as number | undefined, nextReviewAt: row.next_review_at as number, expiresAt: row.expires_at as number | undefined }));
  }

  upsertStewardship(input: StoredStewardship): void {
    this.db.run(`INSERT INTO stewardships (id, agent_id, scope_ref, responsibility, cadence_ms, next_review_at, last_review_at, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, scope_ref) DO UPDATE SET responsibility = excluded.responsibility, cadence_ms = excluded.cadence_ms, next_review_at = excluded.next_review_at, last_review_at = excluded.last_review_at, enabled = excluded.enabled`,
    [input.id, input.agentId, input.scopeRef, input.responsibility, input.cadenceMs, input.nextReviewAt, input.lastReviewAt ?? null, input.enabled === false ? 0 : 1]);
  }

  dueStewardships(now: number): StoredStewardship[] {
    return (this.db.query("SELECT * FROM stewardships WHERE enabled = 1 AND next_review_at <= ?").all(now) as Array<Record<string, unknown>>)
      .map((row) => ({ id: row.id as string, agentId: row.agent_id as string, scopeRef: row.scope_ref as string, responsibility: row.responsibility as string, cadenceMs: row.cadence_ms as number, nextReviewAt: row.next_review_at as number, lastReviewAt: row.last_review_at as number | undefined, enabled: Boolean(row.enabled) }));
  }

  recordStewardshipReview(agentId: string, scopeRef: string, expectedReviewAt: number, reviewedAt: number): boolean {
    const result = this.db.run(`UPDATE stewardships
      SET last_review_at = ?, next_review_at = next_review_at + cadence_ms
      WHERE agent_id = ? AND scope_ref = ? AND enabled = 1 AND next_review_at = ?`,
    [reviewedAt, agentId, scopeRef, expectedReviewAt]);
    return result.changes === 1;
  }

  getActivationEffect(leaseId: string, candidateKey: string): string | null {
    const row = this.db.query("SELECT effect_ref FROM activation_effects WHERE lease_id = ? AND candidate_key = ?")
      .get(leaseId, candidateKey) as { effect_ref: string } | null;
    return row?.effect_ref ?? null;
  }

  recordActivationEffect(leaseId: string, candidateKey: string, effectRef: string): void {
    this.db.run("INSERT OR IGNORE INTO activation_effects (lease_id, candidate_key, effect_ref) VALUES (?, ?, ?)", [leaseId, candidateKey, effectRef]);
  }

  reserveBudget(input: ReserveBudgetInput): BudgetReservation {
    if (input.units === 0) return { ok: true };
    return this.transaction(() => {
      const colony = this.getBudget(input.day, "colony", "all");
      const agent = this.getBudget(input.day, "agent", input.agentId);
      if (colony.spentUnits + colony.reservedUnits + input.units > input.colonyLimit) return { ok: false, reason: "colony-budget" };
      if (agent.spentUnits + agent.reservedUnits + input.units > input.agentLimit) return { ok: false, reason: "agent-budget" };
      this.ensureBudget(input.day, "colony", "all", input.now);
      this.ensureBudget(input.day, "agent", input.agentId, input.now);
      this.db.run("UPDATE activation_budgets SET reserved_units = reserved_units + ?, updated_at = ? WHERE day = ? AND scope = 'colony' AND scope_id = 'all'", [input.units, input.now, input.day]);
      this.db.run("UPDATE activation_budgets SET reserved_units = reserved_units + ?, updated_at = ? WHERE day = ? AND scope = 'agent' AND scope_id = ?", [input.units, input.now, input.day, input.agentId]);
      this.db.run(`INSERT INTO activation_budget_reservations (lease_id, day, agent_id, units, status) VALUES (?, ?, ?, ?, 'reserved')`, [input.leaseId, input.day, input.agentId, input.units]);
      return { ok: true };
    });
  }

  settleBudget(leaseId: string, now: number): boolean {
    return this.finishBudgetReservation(leaseId, now, "settled");
  }

  releaseBudget(leaseId: string, now: number): boolean {
    return this.finishBudgetReservation(leaseId, now, "released");
  }

  getBudget(day: string, scope: BudgetScope, scopeId: string): { spentUnits: number; reservedUnits: number } {
    const row = this.db.query("SELECT spent_units, reserved_units FROM activation_budgets WHERE day = ? AND scope = ? AND scope_id = ?")
      .get(day, scope, scopeId) as { spent_units: number; reserved_units: number } | null;
    return { spentUnits: row?.spent_units ?? 0, reservedUnits: row?.reserved_units ?? 0 };
  }

  budgetRowCount(): number {
    return (this.db.query("SELECT COUNT(*) AS count FROM activation_budgets").get() as { count: number }).count;
  }

  /** Read-only operational counters safe for reports; never include attention summaries. */
  operationalStatus(now: number): {
    activeLeases: number;
    dueAttention: number;
    nextLeaseExpiry: number | null;
    budgets: Array<{ day: string; scope: BudgetScope; scopeId: string; spentUnits: number; reservedUnits: number }>;
    serviceAges: Array<{ agentId: string; serviceCount: number; ageMs: number }>;
  } {
    const activeLeases = (this.db.query("SELECT COUNT(*) AS count FROM activation_leases WHERE status = 'active'").get() as { count: number }).count;
    const dueAttention = (this.db.query("SELECT COUNT(*) AS count FROM attention_items WHERE state = 'open' AND due_at <= ?").get(now) as { count: number }).count;
    const next = this.db.query("SELECT MIN(expires_at) AS expires_at FROM activation_leases WHERE status = 'active'").get() as { expires_at: number | null };
    const budgets = (this.db.query("SELECT day, scope, scope_id, spent_units, reserved_units FROM activation_budgets ORDER BY day, scope, scope_id").all() as Array<Record<string, unknown>>)
      .map((row) => ({ day: row.day as string, scope: row.scope as BudgetScope, scopeId: row.scope_id as string, spentUnits: row.spent_units as number, reservedUnits: row.reserved_units as number }));
    const serviceAges = (this.db.query("SELECT agent_id, service_count, updated_at FROM activation_service ORDER BY agent_id").all() as Array<Record<string, unknown>>)
      .map((row) => ({ agentId: row.agent_id as string, serviceCount: row.service_count as number, ageMs: Math.max(0, now - (row.updated_at as number)) }));
    return { activeLeases, dueAttention, nextLeaseExpiry: next.expires_at, budgets, serviceAges };
  }

  setBrokerStatus(input: { mode: string; nextDueAt: number | null; pendingCount: number; dueCount: number; suppressedByReason: Record<string, number>; now: number }): void {
    this.db.run(`INSERT INTO activation_broker_status (id, mode, next_due_at, pending_count, due_count, suppressed_json, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, next_due_at = excluded.next_due_at, pending_count = excluded.pending_count, due_count = excluded.due_count, suppressed_json = excluded.suppressed_json, updated_at = excluded.updated_at`,
    [input.mode, input.nextDueAt, input.pendingCount, input.dueCount, JSON.stringify(input.suppressedByReason), input.now]);
  }

  getBrokerStatus(): { mode: string; nextDueAt: number | null; pendingCount: number; dueCount: number; suppressedByReason: Record<string, number> } | null {
    const row = this.db.query("SELECT mode, next_due_at, pending_count, due_count, suppressed_json FROM activation_broker_status WHERE id = 1").get() as Record<string, unknown> | null;
    if (!row) return null;
    return { mode: row.mode as string, nextDueAt: row.next_due_at as number | null, pendingCount: row.pending_count as number, dueCount: row.due_count as number, suppressedByReason: JSON.parse(row.suppressed_json as string) as Record<string, number> };
  }

  getCooldown(agentId: string, cooldownKey: string): number | null {
    const row = this.db.query("SELECT next_eligible_at FROM activation_cooldowns WHERE agent_id = ? AND cooldown_key = ?")
      .get(agentId, cooldownKey) as { next_eligible_at: number } | null;
    return row?.next_eligible_at ?? null;
  }

  setCooldown(agentId: string, cooldownKey: string, nextEligibleAt: number): void {
    this.db.run(`
      INSERT INTO activation_cooldowns (agent_id, cooldown_key, next_eligible_at) VALUES (?, ?, ?)
      ON CONFLICT(agent_id, cooldown_key) DO UPDATE SET next_eligible_at = excluded.next_eligible_at
    `, [agentId, cooldownKey, nextEligibleAt]);
  }

  getServiceCount(agentId: string): number {
    const row = this.db.query("SELECT service_count FROM activation_service WHERE agent_id = ?").get(agentId) as { service_count: number } | null;
    return row?.service_count ?? 0;
  }

  recordService(agentId: string, now: number): number {
    this.db.run(`INSERT INTO activation_service (agent_id, service_count, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(agent_id) DO UPDATE SET service_count = service_count + 1, updated_at = excluded.updated_at`, [agentId, now]);
    return this.getServiceCount(agentId);
  }

  expireOpenAttention(now: number): string[] {
    return this.transaction(() => {
      const rows = this.db.query(`
        SELECT id FROM attention_items
        WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(now) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      this.db.run(`
        UPDATE attention_items
        SET state = 'expired', resolved_at = ?, version = version + 1
        WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
      `, [now, now]);
      return rows.map((row) => row.id);
    });
  }

  /** Repairs a crashed activation without re-running an already durable effect. */
  recoverClaimedAttention(now: number): string[] {
    const claimed = this.db.query("SELECT * FROM attention_items WHERE state = 'claimed'").all() as Array<Record<string, unknown>>;
    const recovered: string[] = [];
    for (const row of claimed) {
      const item = mapAttention(row);
      const candidateKey = `${item.agentId}:${item.sourceKind}:${item.sourceRef}:${item.occurrenceKey}`;
      const lease = this.db.query(`
        SELECT id, status, expires_at FROM activation_leases
        WHERE candidate_key = ? ORDER BY acquired_at DESC LIMIT 1
      `).get(candidateKey) as { id: string; status: string; expires_at: number } | null;
      if (lease?.status === "active" && lease.expires_at > now) continue;

      const hasEffect = Boolean(lease && this.getActivationEffect(lease.id, candidateKey));
      if (hasEffect) {
        if (lease?.status === "active") this.completeLease(lease.id, now);
        const acted = this.transitionAttention(item.id, item.version, "acted", now);
        if (acted.ok) this.transitionAttention(item.id, acted.item.version, "resolved", now);
      } else {
        if (lease?.status === "active") this.releaseLease(lease.id, now);
        this.transitionAttention(item.id, item.version, "open", now);
      }
      recovered.push(item.id);
    }
    return recovered;
  }

  private finishBudgetReservation(leaseId: string, now: number, finalStatus: "settled" | "released"): boolean {
    return this.transaction(() => this.finishBudgetReservationInTransaction(leaseId, now, finalStatus));
  }

  /** Atomically closes a completed lease and converts its reservation to spend. */
  /** Releases every active lease of one executor; at boot they belong to a dead process. */
  releaseActiveLeases(executor: string, now: number): string[] {
    return this.transaction(() => {
      const rows = this.db.query("SELECT id FROM activation_leases WHERE status = 'active' AND executor = ?").all(executor) as Array<{ id: string }>;
      for (const { id } of rows) {
        this.db.run("UPDATE activation_leases SET status = 'released', completed_at = ? WHERE id = ? AND status = 'active'", [now, id]);
        this.finishBudgetReservationInTransaction(id, now, "released");
      }
      return rows.map((row) => row.id);
    });
  }

  retainMeshSource(input: MeshSourceInput): void {
    this.db.run(`INSERT INTO mesh_sources (agent_id, source_ref, from_id, from_platform, thread_id, subject, content, role, created_at, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(agent_id, source_ref) DO NOTHING`,
    [input.agentId, input.sourceRef, input.fromId, input.fromPlatform, input.threadId, input.subject, input.content, input.role, input.createdAt]);
  }

  getMeshSource(agentId: string, sourceRef: string): MeshSource | null {
    const row = this.db.query("SELECT * FROM mesh_sources WHERE agent_id = ? AND source_ref = ?").get(agentId, sourceRef) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      agentId: row.agent_id as string, sourceRef: row.source_ref as string, fromId: row.from_id as string,
      fromPlatform: (row.from_platform as string | null) ?? null, threadId: (row.thread_id as string | null) ?? null,
      subject: row.subject as string, content: row.content as string, role: row.role as string,
      createdAt: row.created_at as number, attempts: row.attempts as number, repliedAt: (row.replied_at as number | null) ?? null,
    };
  }

  /** Counts one more attempt and returns the new total (0 when no source is kept). */
  recordMeshAttempt(agentId: string, sourceRef: string): number {
    const row = this.db.query("UPDATE mesh_sources SET attempts = attempts + 1 WHERE agent_id = ? AND source_ref = ? RETURNING attempts").get(agentId, sourceRef) as { attempts: number } | null;
    return row?.attempts ?? 0;
  }

  markMeshReplied(agentId: string, sourceRef: string, now: number): void {
    this.db.run("UPDATE mesh_sources SET replied_at = ? WHERE agent_id = ? AND source_ref = ? AND replied_at IS NULL", [now, agentId, sourceRef]);
  }

  completeLease(leaseId: string, now: number): boolean {
    return this.transaction(() => {
      const result = this.db.run("UPDATE activation_leases SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'active'", [now, leaseId]);
      if (result.changes !== 1) return false;
      this.finishBudgetReservationInTransaction(leaseId, now, "settled");
      return true;
    });
  }

  private finishBudgetReservationInTransaction(leaseId: string, now: number, finalStatus: "settled" | "released"): boolean {
    const reservation = this.db.query("SELECT * FROM activation_budget_reservations WHERE lease_id = ?").get(leaseId) as Record<string, unknown> | null;
    if (!reservation || reservation.status !== "reserved") return false;
    const spentDelta = finalStatus === "settled" ? reservation.units as number : 0;
    for (const [scope, scopeId] of [["colony", "all"], ["agent", reservation.agent_id as string]] as const) {
      this.db.run(`
        UPDATE activation_budgets
        SET reserved_units = reserved_units - ?, spent_units = spent_units + ?, updated_at = ?
        WHERE day = ? AND scope = ? AND scope_id = ?
      `, [reservation.units as number, spentDelta, now, reservation.day as string, scope, scopeId]);
    }
    this.db.run("UPDATE activation_budget_reservations SET status = ? WHERE lease_id = ?", [finalStatus, leaseId]);
    return true;
  }

  private ensureBudget(day: string, scope: BudgetScope, scopeId: string, now: number): { spentUnits: number; reservedUnits: number } {
    this.db.run(`
      INSERT OR IGNORE INTO activation_budgets (day, scope, scope_id, spent_units, reserved_units, updated_at)
      VALUES (?, ?, ?, 0, 0, ?)
    `, [day, scope, scopeId, now]);
    return this.getBudget(day, scope, scopeId);
  }

  private requireAttention(id: string): AttentionItem {
    const item = this.getAttention(id);
    if (!item) throw new Error(`attention item disappeared: ${id}`);
    return item;
  }

  private transaction<T>(callback: () => T): T {
    return this.db.transaction(callback)();
  }

  private ensureSchema(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS attention_items (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL,
      occurrence_key TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, urgency INTEGER NOT NULL,
      summary TEXT NOT NULL, opened_at INTEGER NOT NULL, due_at INTEGER NOT NULL, claimed_at INTEGER,
      acted_at INTEGER, resolved_at INTEGER, expires_at INTEGER, last_event_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, UNIQUE(agent_id, source_kind, source_ref, occurrence_key)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_attention_agent_state_due ON attention_items(agent_id, state, due_at)");
    this.db.run(`CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_ref TEXT NOT NULL, authority_ref TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL, accepted_at INTEGER NOT NULL, due_at INTEGER,
      next_review_at INTEGER NOT NULL, expires_at INTEGER, UNIQUE(agent_id, source_ref)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_commitments_review ON commitments(next_review_at)");
    this.db.run(`CREATE TABLE IF NOT EXISTS stewardships (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope_ref TEXT NOT NULL, responsibility TEXT NOT NULL,
      cadence_ms INTEGER NOT NULL, next_review_at INTEGER NOT NULL, last_review_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(agent_id, scope_ref)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_stewardships_review ON stewardships(next_review_at)");
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_leases (
      id TEXT PRIMARY KEY, candidate_key TEXT NOT NULL, agent_id TEXT NOT NULL, executor TEXT NOT NULL,
      cost_class TEXT NOT NULL, status TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      completed_at INTEGER
    )`);
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_active_lease_candidate ON activation_leases(candidate_key) WHERE status = 'active'");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_leases_expiry ON activation_leases(expires_at)");
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_budgets (
      day TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, spent_units INTEGER NOT NULL DEFAULT 0,
      reserved_units INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(day, scope, scope_id)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_budget_reservations (
      lease_id TEXT PRIMARY KEY, day TEXT NOT NULL, agent_id TEXT NOT NULL, units INTEGER NOT NULL, status TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_cooldowns (
      agent_id TEXT NOT NULL, cooldown_key TEXT NOT NULL, next_eligible_at INTEGER NOT NULL,
      PRIMARY KEY(agent_id, cooldown_key)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_service (
      agent_id TEXT PRIMARY KEY, service_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_effects (
      lease_id TEXT NOT NULL, candidate_key TEXT NOT NULL, effect_ref TEXT NOT NULL,
      PRIMARY KEY(lease_id, candidate_key)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS mesh_sources (
      agent_id TEXT NOT NULL, source_ref TEXT NOT NULL, from_id TEXT NOT NULL, from_platform TEXT, thread_id TEXT,
      subject TEXT NOT NULL, content TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, replied_at INTEGER,
      PRIMARY KEY(agent_id, source_ref)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS activation_broker_status (
      id INTEGER PRIMARY KEY CHECK(id = 1), mode TEXT NOT NULL, next_due_at INTEGER,
      pending_count INTEGER NOT NULL, due_count INTEGER NOT NULL, suppressed_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }
}

function mapAttention(row: Record<string, unknown>): AttentionItem {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sourceKind: row.source_kind as string,
    sourceRef: row.source_ref as string,
    occurrenceKey: row.occurrence_key as string,
    kind: row.kind as string,
    state: row.state as AttentionState,
    urgency: row.urgency as number,
    summary: row.summary as string,
    openedAt: row.opened_at as number,
    dueAt: row.due_at as number,
    claimedAt: row.claimed_at as number | null,
    actedAt: row.acted_at as number | null,
    resolvedAt: row.resolved_at as number | null,
    expiresAt: row.expires_at as number | undefined,
    lastEventId: row.last_event_id as string,
    version: row.version as number,
  };
}
