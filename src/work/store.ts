/**
 * Durable work store for the castle work loop (anima #135).
 *
 * One row per work, one row per execution session, an append-only event log.
 * The caps live here and survive restart and reclaim: a session is reserved (and
 * counted) before it starts, and a session found open after a crash is charged its
 * whole deadline, so a restart can never give a work more time than it had.
 *
 * Only the work's own state is kept. Mesh claim/report state stays in Mesh.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadWorkConfig, parseStoredCaps, type WorkCaps, type WorkConfig } from "./config";

export type WorkState = "queued" | "running" | "checkpointed" | "in-review" | "revising" | "accepted" | "blocked";

export interface WorkRecord {
  workId: string;
  repo: string;
  issue: number;
  approvedDigest: string;
  author: string;
  provider: string;
  model: string;
  state: WorkState;
  generation: number;
  branch: string;
  root: string;
  caps: WorkCaps;
  sessionsUsed: number;
  iterationsUsed: number;
  execMsUsed: number;
  blockedReason: string | null;
  /** The pull request this work opened, recorded once the host has verified it. */
  prNumber: number | null;
  prHead: string | null;
  prUrl: string | null;
  /** The Mesh start-work job, for the enqueuer's confirmation after acceptance. */
  startJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEntry {
  key: string;
  workId: string;
  purpose: "review" | "revise" | "confirm";
  payload: unknown;
  status: "pending" | "done" | "superseded";
  attempts: number;
  retryAt: number;
  lastError: string | null;
}

export interface SessionRecord {
  sessionId: string;
  workId: string;
  no: number;
  jobId: string;
  claimId: string;
  generation: number;
  deadlineMs: number;
  startedAt: string;
  endedAt: string | null;
  stopCause: string | null;
  iterations: number;
  execMs: number;
  endedUnknown: boolean;
}

/** What the host knows about a session's end (rfcclub/anima#238 AC-8): each tree field is a value or a marker. */
export interface StopRecord {
  sessionId: string;
  workId: string;
  adapter: string;
  stopCause: string;
  cessation: "proven" | "unproven";
  /** The check that failed when cessation is unproven. */
  cessationCheck: string | null;
  head: string;
  status: string;
  evidence: string;
  /** A trusted checkpoint (AC-9). */
  trusted: boolean;
  /** Written by recovery after a host crash, not observed. */
  interrupted: boolean;
  recordedAt: string;
}

export interface WorkEvent {
  seq: number;
  workId: string;
  at: string;
  kind: string;
  detail: unknown;
}

export type StepKind = "provider" | "compaction" | "tool";
export type StepOutcome = "in-progress" | "completed" | "unknown" | "verified";

export interface StepRecord {
  id: string;
  workId: string;
  sessionId: string;
  seq: number;
  kind: StepKind;
  outcome: StepOutcome;
}

export interface CreateWorkInput {
  repo: string;
  issue: number;
  /** Content digest of the approved issue (hex), carried in the job's work reference. */
  approvedDigest: string;
  config: WorkConfig;
  /** The id from the job's work reference; generated when absent. */
  workId?: string;
}

export interface CreateWorkResult {
  created: boolean;
  work: WorkRecord;
  /** Set when a work for this issue is active under a different approved digest. */
  refused?: "approval changed";
}

export type ReserveResult =
  | { ok: true; session: SessionRecord; maxIterations: number; deadlineMs: number }
  | { ok: false; reason: "no-work" | "state" | "sessions" | "time" };

export interface StoreOptions {
  /** Base of the per-work roots; defaults to `ANIMA_WORK_ROOT` or `~/.anima/work`. */
  rootBase?: string;
  now?: () => number;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST = /^[0-9a-f]{12,64}$/i;
const WORK_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_KEY = /token|secret|password|authorization|capability|transcript|credential|api[-_]?key/i;

/** `ANIMA_WORK_DB` wins; under `NODE_ENV=test` the default is memory, never the live file. */
export function resolveWorkDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.ANIMA_WORK_DB) return env.ANIMA_WORK_DB;
  if (env.NODE_ENV === "test") return ":memory:";
  return join(env.HOME ?? homedir(), ".anima", "work.db");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v);
    return out;
  }
  return value;
}

const id = (prefix: string) => prefix + randomBytes(5).toString("hex");

type Row = Record<string, unknown>;

function toWork(r: Row): WorkRecord {
  return {
    workId: r.work_id as string,
    repo: r.repo as string,
    issue: r.issue as number,
    approvedDigest: r.approved_digest as string,
    author: r.author as string,
    provider: r.provider as string,
    model: r.model as string,
    state: r.state as WorkState,
    generation: r.generation as number,
    branch: r.branch as string,
    root: r.root as string,
    caps: parseStoredCaps(r.caps_json as string),
    sessionsUsed: r.sessions_used as number,
    iterationsUsed: r.iterations_used as number,
    execMsUsed: r.exec_ms_used as number,
    blockedReason: (r.blocked_reason as string | null) ?? null,
    prNumber: (r.pr_number as number | null) ?? null,
    prHead: (r.pr_head as string | null) ?? null,
    prUrl: (r.pr_url as string | null) ?? null,
    startJobId: (r.start_job_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toSession(r: Row): SessionRecord {
  return {
    sessionId: r.session_id as string,
    workId: r.work_id as string,
    no: r.no as number,
    jobId: r.job_id as string,
    claimId: r.claim_id as string,
    generation: r.generation as number,
    deadlineMs: r.deadline_ms as number,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
    stopCause: (r.stop_cause as string | null) ?? null,
    iterations: r.iterations as number,
    execMs: r.exec_ms as number,
    endedUnknown: (r.ended_unknown as number) === 1,
  };
}

function toStop(r: Row): StopRecord {
  return {
    sessionId: r.session_id as string,
    workId: r.work_id as string,
    adapter: r.adapter as string,
    stopCause: r.stop_cause as string,
    cessation: r.cessation as StopRecord["cessation"],
    cessationCheck: (r.cessation_check as string | null) ?? null,
    head: r.head as string,
    status: r.status as string,
    evidence: r.evidence as string,
    trusted: (r.trusted as number) === 1,
    interrupted: (r.interrupted as number) === 1,
    recordedAt: r.recorded_at as string,
  };
}

function toOutbox(r: Row): OutboxEntry {
  return {
    key: r.key as string, workId: r.work_id as string, purpose: r.purpose as OutboxEntry["purpose"],
    payload: JSON.parse(r.payload_json as string), status: r.status as OutboxEntry["status"],
    attempts: r.attempts as number, retryAt: r.retry_at as number, lastError: (r.last_error as string | null) ?? null,
  };
}

const RESERVABLE: ReadonlySet<WorkState> = new Set(["queued", "checkpointed", "revising"]);

export class WorkStore {
  private readonly now: () => number;
  private readonly rootBase: string;

  private constructor(private readonly db: Database, options: StoreOptions) {
    this.now = options.now ?? Date.now;
    this.rootBase = options.rootBase ?? process.env.ANIMA_WORK_ROOT ?? join(homedir(), ".anima", "work");
    this.migrate();
  }

  static open(path: string = resolveWorkDbPath(), options: StoreOptions = {}): WorkStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("PRAGMA busy_timeout = 500");
    if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
    return new WorkStore(db, options);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS works (
        work_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        approved_digest TEXT NOT NULL,
        author TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        branch TEXT NOT NULL,
        root TEXT NOT NULL,
        caps_json TEXT NOT NULL,
        sessions_used INTEGER NOT NULL DEFAULT 0,
        iterations_used INTEGER NOT NULL DEFAULT 0,
        exec_ms_used INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // One active work per repository, issue and approved revision; an accepted work frees the slot.
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_works_active ON works(repo, issue, approved_digest) WHERE state != 'accepted'",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS work_sessions (
        session_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(work_id),
        no INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        deadline_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        stop_cause TEXT,
        iterations INTEGER NOT NULL DEFAULT 0,
        exec_ms INTEGER NOT NULL DEFAULT 0,
        ended_unknown INTEGER NOT NULL DEFAULT 0,
        UNIQUE (work_id, no)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS work_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL REFERENCES works(work_id),
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail_json TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_work_events_work ON work_events(work_id, seq)");
    // Columns added after the first schema: nullable, added on open when missing.
    const workColumns = (this.db.query("PRAGMA table_info(works)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ["pr_number INTEGER", "pr_head TEXT", "pr_url TEXT", "start_job_id TEXT"]) {
      if (!workColumns.includes(column.split(" ")[0]!)) this.db.run(`ALTER TABLE works ADD COLUMN ${column}`);
    }
    // Operations that reach outside (enqueue a review, enqueue a revise, confirm a job). The key makes each one
    // idempotent: the same work, pull request and head never queue the same operation twice.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS work_outbox (
        key TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(work_id),
        purpose TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        done_at TEXT
      )
    `);
    // A marker written before each provider call and closed after it. One still open after a restart is a
    // step whose effects are unknown and must be checked before anything is repeated.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS work_steps (
        step_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(work_id),
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_work_steps_work ON work_steps(work_id, outcome, started_at)");
    // One stop record per session end (rfcclub/anima#238 AC-8): each tree field a value or unknown/unavailable/untrusted.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS work_stops (
        session_id TEXT PRIMARY KEY REFERENCES work_sessions(session_id),
        work_id TEXT NOT NULL REFERENCES works(work_id),
        adapter TEXT NOT NULL,
        stop_cause TEXT NOT NULL,
        cessation TEXT NOT NULL,
        cessation_check TEXT,
        head TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT NOT NULL,
        trusted INTEGER NOT NULL DEFAULT 0,
        interrupted INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL
      )
    `);
    const sessionColumns = (this.db.query("PRAGMA table_info(work_sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!sessionColumns.includes("adapter")) this.db.run("ALTER TABLE work_sessions ADD COLUMN adapter TEXT");
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  // ---- works -------------------------------------------------------------------

  createWork(input: CreateWorkInput): CreateWorkResult {
    if (!REPO.test(input.repo)) throw new RangeError(`invalid repository ${input.repo}`);
    if (!Number.isInteger(input.issue) || input.issue <= 0) throw new RangeError(`invalid issue number ${input.issue}`);
    if (!DIGEST.test(input.approvedDigest)) throw new RangeError("approved digest must be 12 to 64 hex characters");
    if (input.workId !== undefined && !WORK_ID.test(input.workId)) throw new RangeError(`invalid work id ${input.workId}`);

    return this.db.transaction((): CreateWorkResult => {
      // An open work (queued, running, checkpointed, in review, revising) decides first: the same digest is the same
      // work, another digest blocks it and is refused so a second writer never starts.
      const open = this.db
        .query("SELECT * FROM works WHERE repo = ? AND issue = ? AND state NOT IN ('accepted', 'blocked') ORDER BY created_at DESC LIMIT 1")
        .get(input.repo, input.issue) as Row | null;
      if (open) {
        if ((open.approved_digest as string).toLowerCase() === input.approvedDigest.toLowerCase()) {
          return { created: false, work: toWork(open) };
        }
        // A second revision must never start a second writer: block the one that exists.
        this.blockIfOpen(open.work_id as string, "approval changed");
        return { created: false, work: this.mustGet(open.work_id as string), refused: "approval changed" };
      }
      // A blocked work is final for its own digest (an edited issue is the only way to ask for a new attempt), but it
      // must never stop a new work for a new digest of the same issue.
      const blockedSame = this.db
        .query("SELECT * FROM works WHERE repo = ? AND issue = ? AND state = 'blocked' AND approved_digest = ? ORDER BY created_at DESC LIMIT 1")
        .get(input.repo, input.issue, input.approvedDigest.toLowerCase()) as Row | null;
      if (blockedSame) return { created: false, work: toWork(blockedSame) };

      const workId = input.workId ?? id("w");
      if (this.db.query("SELECT 1 FROM works WHERE work_id = ?").get(workId)) {
        throw new RangeError(`work id ${workId} already exists`);
      }
      const at = this.stamp();
      this.db.run(
        `INSERT INTO works (work_id, repo, issue, approved_digest, author, provider, model, state, branch, root, caps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        [
          workId, input.repo, input.issue, input.approvedDigest.toLowerCase(),
          input.config.author, input.config.provider, input.config.model,
          `work/${input.issue}-${workId}`, join(this.rootBase, input.repo, workId),
          JSON.stringify(input.config.caps), at, at,
        ],
      );
      this.writeEvent(workId, "created", { repo: input.repo, issue: input.issue, author: input.config.author });
      return { created: true, work: this.mustGet(workId) };
    })();
  }

  getWork(workId: string): WorkRecord | null {
    const r = this.db.query("SELECT * FROM works WHERE work_id = ?").get(workId) as Row | null;
    return r ? toWork(r) : null;
  }

  private mustGet(workId: string): WorkRecord {
    const w = this.getWork(workId);
    if (!w) throw new Error(`work ${workId} not found`);
    return w;
  }

  listWorks(): WorkRecord[] {
    return (this.db.query("SELECT * FROM works ORDER BY created_at, work_id").all() as Row[]).map(toWork);
  }

  setState(workId: string, state: WorkState, blockedReason?: string): void {
    const reason = state === "blocked" ? (blockedReason ?? "blocked") : null;
    this.db.run("UPDATE works SET state = ?, blocked_reason = ?, updated_at = ? WHERE work_id = ?", [state, reason, this.stamp(), workId]);
    this.writeEvent(workId, "state", { state, reason });
  }

  /** Blocks a work that is not already finished or blocked; keeps an earlier blocked reason. */
  private blockIfOpen(workId: string, reason: string): void {
    const w = this.getWork(workId);
    if (!w || w.state === "accepted" || w.state === "blocked") return;
    this.setState(workId, "blocked", reason);
  }

  /** The issue's current approved digest, read again from GitHub. A change blocks the work. */
  observeApproval(workId: string, currentDigest: string): WorkState | null {
    const w = this.getWork(workId);
    if (!w) return null;
    if (w.approvedDigest.toLowerCase() !== currentDigest.toLowerCase()) this.blockIfOpen(workId, "approval changed");
    return this.mustGet(workId).state;
  }

  // ---- sessions and caps -------------------------------------------------------

  /**
   * The running work wall is spent. It never applies once a pull request is recorded (see reserveSession), and
   * recovery and retry use the same rule so the three gates cannot disagree.
   */
  private wallSpent(work: WorkRecord, wallMs: number): boolean {
    return work.prNumber === null && wallMs <= work.execMsUsed;
  }

  /** Reserves and counts a session before it starts. Refuses, and blocks the work, when a cap is spent. */
  reserveSession(workId: string, claim: { jobId: string; claimId: string }, adapter?: string): ReserveResult {
    return this.db.transaction((): ReserveResult => {
      const w = this.getWork(workId);
      if (!w) return { ok: false, reason: "no-work" };
      if (!RESERVABLE.has(w.state)) return { ok: false, reason: "state" };
      if (w.sessionsUsed >= w.caps.maxSessions) {
        this.blockIfOpen(workId, `sessions exhausted (${w.caps.maxSessions} of ${w.caps.maxSessions} used)`);
        return { ok: false, reason: "sessions" };
      }
      // A work that has recorded a pull request is in review or revising. Its revise sessions are bounded by
      // sessionWallMs and maxSessions, not by the running total workWallMs, which bounds the start-work sessions
      // before the first publish. (#379: the wall was spent by review rounds and stranded the PR.)
      const remaining = w.prNumber !== null ? w.caps.sessionWallMs : w.caps.workWallMs - w.execMsUsed;
      if (remaining <= 0) {
        this.blockIfOpen(workId, "execution time limit reached");
        return { ok: false, reason: "time" };
      }
      const deadlineMs = Math.min(w.caps.sessionWallMs, remaining);
      const no = w.sessionsUsed + 1;
      const sessionId = id("s");
      this.db.run(
        `INSERT INTO work_sessions (session_id, work_id, no, job_id, claim_id, generation, deadline_ms, started_at, adapter)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, workId, no, claim.jobId, claim.claimId, w.generation + 1, deadlineMs, this.stamp(), adapter ?? null],
      );
      this.db.run(
        "UPDATE works SET sessions_used = ?, generation = ?, state = 'running', blocked_reason = NULL, updated_at = ? WHERE work_id = ?",
        [no, w.generation + 1, this.stamp(), workId],
      );
      this.writeEvent(workId, "session-reserved", { no, jobId: claim.jobId, claimId: claim.claimId, deadlineMs });
      return { ok: true, session: this.mustSession(sessionId), maxIterations: w.caps.maxIterationsPerSession, deadlineMs };
    })();
  }

  closeSession(sessionId: string, result: { iterations: number; execMs: number; stopCause: string }): void {
    this.db.transaction(() => {
      const s = this.getSession(sessionId);
      if (!s || s.endedAt) return;
      this.db.run(
        "UPDATE work_sessions SET ended_at = ?, stop_cause = ?, iterations = ?, exec_ms = ? WHERE session_id = ?",
        [this.stamp(), result.stopCause, result.iterations, result.execMs, sessionId],
      );
      this.charge(s.workId, result.iterations, result.execMs);
      this.demoteRunning(s.workId);
      this.writeEvent(s.workId, "session-closed", { no: s.no, stopCause: result.stopCause, iterations: result.iterations, execMs: result.execMs });
    })();
  }

  /**
   * After a restart: every session still open ended without a record. Charge each its whole
   * deadline and its whole iteration allowance (the outcome is unknown, so the safe charge is
   * the maximum) and flag it. Returns the sessions it closed.
   */
  recoverOpenSessions(): SessionRecord[] {
    return this.db.transaction(() => {
      const open = (this.db.query("SELECT * FROM work_sessions WHERE ended_at IS NULL ORDER BY started_at").all() as Row[]).map(toSession);
      for (const s of open) {
        const w = this.mustGet(s.workId);
        this.db.run(
          "UPDATE work_sessions SET ended_at = ?, stop_cause = 'unknown', iterations = ?, exec_ms = ?, ended_unknown = 1 WHERE session_id = ?",
          [this.stamp(), w.caps.maxIterationsPerSession, s.deadlineMs, s.sessionId],
        );
        this.charge(s.workId, w.caps.maxIterationsPerSession, s.deadlineMs);
        this.demoteRunning(s.workId);
        this.writeEvent(s.workId, "session-recovered", { no: s.no, chargedMs: s.deadlineMs, outcome: "unknown" });
      }
      return open.map((s) => this.mustSession(s.sessionId));
    })();
  }

  private charge(workId: string, iterations: number, execMs: number): void {
    this.db.run(
      "UPDATE works SET iterations_used = iterations_used + ?, exec_ms_used = exec_ms_used + ?, updated_at = ? WHERE work_id = ?",
      [iterations, execMs, this.stamp(), workId],
    );
  }

  private demoteRunning(workId: string): void {
    this.db.run("UPDATE works SET state = 'checkpointed', updated_at = ? WHERE work_id = ? AND state = 'running'", [this.stamp(), workId]);
  }

  // ---- stop records (rfcclub/anima#238 slice 5) -------------------------------------------

  /** Records which adapter runs a session, right after it is reserved, so recovery after a crash knows it. */
  setSessionAdapter(sessionId: string, adapter: string): void {
    this.db.run("UPDATE work_sessions SET adapter = ? WHERE session_id = ?", [adapter, sessionId]);
  }

  sessionAdapter(sessionId: string): string | null {
    const r = this.db.query("SELECT adapter FROM work_sessions WHERE session_id = ?").get(sessionId) as { adapter: string | null } | null;
    return r?.adapter ?? null;
  }

  /** Writes a session's stop record once; the first record wins. Returns the stored record. */
  recordStop(stop: Omit<StopRecord, "recordedAt">): StopRecord {
    this.db.run(
      `INSERT OR IGNORE INTO work_stops (session_id, work_id, adapter, stop_cause, cessation, cessation_check, head, status, evidence, trusted, interrupted, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [stop.sessionId, stop.workId, stop.adapter, stop.stopCause, stop.cessation, stop.cessationCheck, stop.head, stop.status, stop.evidence,
        stop.trusted ? 1 : 0, stop.interrupted ? 1 : 0, this.stamp()],
    );
    return this.getStop(stop.sessionId)!;
  }

  getStop(sessionId: string): StopRecord | null {
    const r = this.db.query("SELECT * FROM work_stops WHERE session_id = ?").get(sessionId) as Row | null;
    return r ? toStop(r) : null;
  }

  /** The work's latest ended session, whether or not it has a stop record. */
  latestEndedSession(workId: string): SessionRecord | null {
    const r = this.db.query("SELECT * FROM work_sessions WHERE work_id = ? AND ended_at IS NOT NULL ORDER BY no DESC LIMIT 1").get(workId) as Row | null;
    return r ? toSession(r) : null;
  }

  /**
   * Ended sessions that have no stop record: closed by crash recovery, or closed just before a crash that came
   * before their record was written. Run at startup, before any session starts.
   */
  unrecordedEndedSessions(): SessionRecord[] {
    return (this.db.query(
      `SELECT se.* FROM work_sessions se LEFT JOIN work_stops st ON st.session_id = se.session_id
       WHERE se.ended_at IS NOT NULL AND st.session_id IS NULL ORDER BY se.started_at`,
    ).all() as Row[]).map(toSession);
  }

  /** Writes an interrupted stop record and, when given, blocks the work, in one transaction. */
  recordInterruptedStop(stop: Omit<StopRecord, "recordedAt">, blockReason: string | null): StopRecord {
    return this.db.transaction(() => {
      const written = this.recordStop(stop);
      if (blockReason) this.setState(stop.workId, "blocked", blockReason);
      return written;
    })();
  }

  getSession(sessionId: string): SessionRecord | null {
    const r = this.db.query("SELECT * FROM work_sessions WHERE session_id = ?").get(sessionId) as Row | null;
    return r ? toSession(r) : null;
  }

  private mustSession(sessionId: string): SessionRecord {
    const s = this.getSession(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    return s;
  }

  listSessions(workId: string): SessionRecord[] {
    return (this.db.query("SELECT * FROM work_sessions WHERE work_id = ? ORDER BY no").all(workId) as Row[]).map(toSession);
  }

  /**
   * Explicit operator recovery. The caller holds the per-work supervisor lock and supplies the tree check.
   * The write transaction also fences the session/state checks and audit event against another DB writer.
   */
  recoverBlockedWork(input: {
    workId: string; root: string; caps: Partial<WorkCaps>; base: string;
    check: (work: WorkRecord) => { ok: true } | { ok: false; reason: string };
  }): WorkRecord {
    return this.db.transaction(() => {
      const work = this.mustGet(input.workId);
      if (work.state !== "blocked") throw new Error(`work ${work.workId} is ${work.state}, not blocked`);
      if (work.root !== input.root) throw new Error("work root changed while acquiring the supervisor lock");

      const sessions = this.listSessions(work.workId);
      if (sessions.some((session) => session.endedAt === null)) throw new Error("recovery refused: an open session remains");
      if (sessions.length !== work.sessionsUsed || sessions.some((session, i) => session.no !== i + 1)) {
        throw new Error("recovery refused: session ledger does not match the usage counter");
      }
      const latest = sessions.at(-1);
      if (latest) {
        if (latest.endedUnknown) throw new Error("recovery refused: latest session ended with unknown outcome");
        if (latest.generation !== work.generation) throw new Error("recovery refused: session generation does not match the work");
        const stop = this.getStop(latest.sessionId);
        if (!stop || stop.workId !== work.workId) throw new Error("recovery refused: latest session has no stop record");
        if (!latest.stopCause || latest.stopCause === "unknown" || stop.stopCause === "unknown" ||
            stop.stopCause !== latest.stopCause) {
          throw new Error("recovery refused: session and stop causes are unknown or disagree");
        }
        if (!stop.trusted || stop.cessation !== "proven" || stop.interrupted ||
            stop.stopCause === "interrupted" || latest.stopCause === "interrupted") {
          throw new Error("recovery refused: latest stop is interrupted, untrusted, or cessation is unproven");
        }
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(stop.head)) {
          throw new Error("recovery refused: checkpoint head is unavailable");
        }
        if (stop.status.trim() !== "") {
          throw new Error("recovery refused: dirty checkpoint contents cannot be verified from Git status");
        }
        const checked = input.check(work);
        if (!checked.ok) throw new Error(checked.reason);
      } else {
        throw new Error("recovery refused: no session checkpoint is available to compare with the base");
      }

      const caps = loadWorkConfig({ caps: { ...work.caps, ...input.caps } }).caps;
      if (caps.maxSessions <= work.sessionsUsed) throw new Error("recovery refused: session limit is already exhausted");
      if (this.wallSpent(work, caps.workWallMs)) throw new Error("recovery refused: execution time limit is already exhausted");
      this.db.run(
        "UPDATE works SET state = 'checkpointed', blocked_reason = NULL, caps_json = ?, updated_at = ? WHERE work_id = ?",
        [JSON.stringify(caps), this.stamp(), work.workId],
      );
      this.writeEvent(work.workId, "operator-recovery", { previousReason: work.blockedReason, previousCaps: work.caps, caps, base: input.base });
      return this.mustGet(work.workId);
    }).immediate();
  }

  /**
   * Add one explicit retry per recovery. The caller holds the work lock and has checked the tree and GitHub.
   * The transaction binds the request and audit event to the same unchanged checkpoint.
   */
  enqueueRecoveredRevision(input: {
    workId: string; root: string; generation: number; head: string; number: number;
    recoverySeq: number; failedJobId: string; reviewers: string[];
  }): { key: string; inserted: boolean } {
    return this.db.transaction(() => {
      const work = this.mustGet(input.workId);
      if (work.state !== "checkpointed" || work.root !== input.root || work.generation !== input.generation ||
          work.prNumber !== input.number || work.prHead?.toLowerCase() !== input.head) {
        throw new Error("retry refused: work or recorded PR head changed");
      }
      const sessions = this.listSessions(work.workId);
      const latest = sessions.at(-1);
      const stop = latest && this.getStop(latest.sessionId);
      if (!latest || sessions.length !== work.sessionsUsed ||
          sessions.some((s, index) => s.endedAt === null || s.no !== index + 1) ||
          latest.generation !== work.generation || latest.endedUnknown || !latest.stopCause ||
          !stop || stop.workId !== work.workId || !stop.trusted || stop.cessation !== "proven" || stop.interrupted ||
          stop.stopCause === "unknown" || stop.stopCause === "interrupted" || stop.stopCause !== latest.stopCause ||
          stop.head.toLowerCase() !== input.head || stop.status.trim() !== "") {
        throw new Error("retry refused: there is no matching trusted, stopped checkpoint");
      }
      if (work.caps.maxSessions <= work.sessionsUsed || this.wallSpent(work, work.caps.workWallMs)) {
        throw new Error("retry refused: work budget is exhausted");
      }
      const events = this.listEvents(work.workId);
      const recovery = events.filter((event) => event.kind === "operator-recovery").at(-1);
      if (!recovery || recovery.seq !== input.recoverySeq ||
          events.some((event) => event.kind === "session-reserved" && event.seq > recovery.seq)) {
        throw new Error("retry refused: work has no unused operator recovery");
      }
      const key = `revise-retry:${work.workId}@${input.head}:recovery:${recovery.seq}`;
      const previous = events.find((event) => event.kind === "operator-revise-retry" &&
        (event.detail as { recoverySeq?: unknown }).recoverySeq === recovery.seq);
      if (previous) {
        const detail = previous.detail as { key?: unknown; failedJobId?: unknown; reviewers?: unknown };
        if (detail.key !== key || detail.failedJobId !== input.failedJobId ||
            JSON.stringify(detail.reviewers) !== JSON.stringify(input.reviewers)) {
          throw new Error("retry refused: a different retry was already requested for this recovery");
        }
        return { key, inserted: false };
      }
      if (!this.enqueueOutbox({
        key, workId: work.workId, purpose: "revise",
        payload: { repo: work.repo, number: input.number, head: input.head, failedJobId: input.failedJobId,
          recoverySeq: recovery.seq, reviewers: input.reviewers },
      })) {
        throw new Error("retry refused: outbox key already exists without the audit event");
      }
      this.writeEvent(work.workId, "operator-revise-retry", {
        key, recoverySeq: recovery.seq, head: input.head, failedJobId: input.failedJobId, reviewers: input.reviewers,
      });
      return { key, inserted: true };
    }).immediate();
  }

  // ---- pull request and outbox -------------------------------------------------

  recordPullRequest(workId: string, pr: { number: number; head: string; url: string }): void {
    this.db.run("UPDATE works SET pr_number = ?, pr_head = ?, pr_url = ?, updated_at = ? WHERE work_id = ?", [pr.number, pr.head, pr.url, this.stamp(), workId]);
    this.writeEvent(workId, "pull-request", { number: pr.number, head: pr.head });
  }

  /** Commit the verified head and its review intent together, retiring superseded pending dispatches. */
  recordReviewHead(work: WorkRecord, pr: { number: number; head: string; url: string }, reopen: boolean): boolean {
    return this.db.transaction(() => {
      const current = this.getWork(work.workId);
      if (!current || current.generation !== work.generation || current.state !== work.state ||
          current.prNumber !== work.prNumber || current.prHead !== work.prHead) return false;

      const head = pr.head.toLowerCase();
      if (current.prNumber !== pr.number || current.prHead !== head || current.prUrl !== pr.url) {
        this.recordPullRequest(work.workId, { ...pr, head });
      }
      if (reopen) this.setState(work.workId, "in-review");
      const retired: string[] = [];
      for (const entry of this.listOutbox(work.workId)) {
        if (entry.status !== "pending" || entry.purpose === "confirm") continue;
        const target = entry.payload as { number?: number; head?: string } | null;
        if (target?.number !== pr.number || typeof target.head !== "string" || target.head.toLowerCase() === head) continue;
        this.completeOutbox(entry.key, "superseded");
        retired.push(entry.key);
      }
      if (retired.length) this.writeEvent(work.workId, "head-jobs-retired", { head, keys: retired });
      this.enqueueOutbox({
        key: `review:${work.workId}:${pr.number}@${head}`, workId: work.workId, purpose: "review",
        payload: { repo: work.repo, number: pr.number, head },
      });
      return true;
    }).immediate();
  }

  setStartJob(workId: string, jobId: string): void {
    this.db.run("UPDATE works SET start_job_id = COALESCE(start_job_id, ?), updated_at = ? WHERE work_id = ?", [jobId, this.stamp(), workId]);
  }

  /** A superseded, unsent operation may become current again if the pull request returns to its head. */
  enqueueOutbox(entry: { key: string; workId: string; purpose: OutboxEntry["purpose"]; payload: unknown }): boolean {
    const r = this.db.run(
      `INSERT INTO work_outbox (key, work_id, purpose, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(key) DO UPDATE SET status = 'pending', attempts = 0, retry_at = 0, last_error = NULL, done_at = NULL,
         payload_json = excluded.payload_json
       WHERE work_outbox.status = 'superseded'`,
      [entry.key, entry.workId, entry.purpose, JSON.stringify(redact(entry.payload)), this.stamp()],
    );
    return r.changes > 0;
  }

  dueOutbox(nowMs: number): OutboxEntry[] {
    return (this.db.query("SELECT * FROM work_outbox WHERE status = 'pending' AND retry_at <= ? ORDER BY created_at, rowid").all(nowMs) as Row[]).map(toOutbox);
  }

  listOutbox(workId: string): OutboxEntry[] {
    return (this.db.query("SELECT * FROM work_outbox WHERE work_id = ? ORDER BY created_at, rowid").all(workId) as Row[]).map(toOutbox);
  }

  completeOutbox(key: string, status: "done" | "superseded" = "done"): void {
    this.db.run("UPDATE work_outbox SET status = ?, done_at = ?, last_error = NULL WHERE key = ? AND status = 'pending'", [status, this.stamp(), key]);
  }

  retryOutbox(key: string, retryAtMs: number, error: string): void {
    this.db.run("UPDATE work_outbox SET attempts = attempts + 1, retry_at = ?, last_error = ? WHERE key = ? AND status = 'pending'", [retryAtMs, error.slice(0, 300), key]);
  }

  // ---- step markers ------------------------------------------------------------

  beginStep(step: {
    workId: string; sessionId: string; seq: number; kind: StepKind;
    toolName?: string; workSessionId?: string;
  }): string {
    const stepId = id("p");
    const insert = () => this.db.run(
      "INSERT INTO work_steps (step_id, work_id, session_id, seq, kind, outcome, started_at) VALUES (?, ?, ?, ?, ?, 'in-progress', ?)",
      [stepId, step.workId, step.sessionId, step.seq, step.kind, this.stamp()],
    );
    if (step.kind === "tool") {
      // Never persist a provider-supplied tool name unless it is one of the host's known tools.
      const tool = step.toolName === "bash" || step.toolName === "read" || step.toolName === "write" ||
        step.toolName === "edit" || step.toolName === "publish" ? step.toolName : "unknown";
      this.db.transaction(() => {
        insert();
        this.writeEvent(step.workId, "tool-started", {
          stepId, conversationSessionId: step.sessionId, workSessionId: step.workSessionId ?? null,
          iteration: step.seq, tool,
        });
      })();
    } else {
      insert();
    }
    return stepId;
  }

  /** `completed` closes the step for good; `unknown` keeps it open until `resolveSteps`. A finished step never reopens. */
  endStep(stepId: string, outcome: "completed" | "unknown"): void {
    this.db.run(
      "UPDATE work_steps SET outcome = ?, ended_at = ? WHERE step_id = ? AND outcome IN ('in-progress', 'unknown')",
      [outcome, this.stamp(), stepId],
    );
  }

  /** Steps still open (in progress or ended unknown), oldest first. */
  openSteps(workId: string): StepRecord[] {
    return (this.db
      .query("SELECT * FROM work_steps WHERE work_id = ? AND outcome IN ('in-progress', 'unknown') ORDER BY started_at, rowid")
      .all(workId) as Row[]).map((r) => ({
      id: r.step_id as string, workId: r.work_id as string, sessionId: r.session_id as string,
      seq: r.seq as number, kind: r.kind as StepKind, outcome: r.outcome as StepOutcome,
    }));
  }

  /** Marks steps as checked against the workspace and GitHub. Called only after reconciliation. */
  resolveSteps(stepIds: string[]): void {
    for (const stepId of stepIds) {
      this.db.run("UPDATE work_steps SET outcome = 'verified', ended_at = COALESCE(ended_at, ?) WHERE step_id = ? AND outcome IN ('in-progress', 'unknown')", [this.stamp(), stepId]);
    }
  }

  // ---- events ------------------------------------------------------------------

  appendEvent(workId: string, kind: string, detail: unknown = {}): void {
    this.writeEvent(workId, kind, detail);
  }

  private writeEvent(workId: string, kind: string, detail: unknown): void {
    this.db.run("INSERT INTO work_events (work_id, at, kind, detail_json) VALUES (?, ?, ?, ?)", [
      workId, this.stamp(), kind, JSON.stringify(redact(detail)),
    ]);
  }

  /** Events of `kind` for a work recorded after the latest event of `resetKind` (or all of them when there is none). */
  countEventsSince(workId: string, kind: string, resetKind: string): number {
    const row = this.db.query(
      `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = ?
         AND seq > COALESCE((SELECT MAX(seq) FROM work_events WHERE work_id = ? AND kind = ?), 0)`,
    ).get(workId, kind, workId, resetKind) as { n: number };
    return row.n;
  }

  listEvents(workId: string): WorkEvent[] {
    return (this.db.query("SELECT * FROM work_events WHERE work_id = ? ORDER BY seq").all(workId) as Row[]).map((r) => ({
      seq: r.seq as number,
      workId: r.work_id as string,
      at: r.at as string,
      kind: r.kind as string,
      detail: JSON.parse(r.detail_json as string),
    }));
  }
}
