import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AppendSharedUtteranceInput,
  CreateSharedConversationInput,
  SharedConversationRecord,
  SharedRequestRecord,
  SharedUtteranceRecord,
} from "../conversation/types";
import { randomUUID } from "node:crypto";
import type { NewRunCheckpoint, RunCheckpoint, RunCheckpointStatus } from "../agents/run-checkpoint";
import { configureMemoryWal } from "./sqlite-wal";

const DEFAULT_DB_PATH = process.env.ANIMA_SESSIONS_DB ?? join(homedir(), ".anima", "sessions.db");

export interface SessionRecord {
  id: string;
  agent: string;
  channel: string;
  started: string;
  ended: string | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnRecord {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export interface SessionSummary {
  summary: string;
  coversThroughTurn: number;
  version: number;
}

export interface BranchRecord {
  id: number;
  sessionId: string;
  name: string;
  parentBranchId: number | null;
  forkFromTurnId: number | null;
  createdAt: string;
}

export class SessionStore {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH, preparedDb?: Database) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = preparedDb ?? new Database(dbPath);
    if (!preparedDb) {
      this.db.run("PRAGMA busy_timeout=5000");
      this.db.run("PRAGMA journal_mode=WAL");
    }
    this.db.run("PRAGMA foreign_keys=ON");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id      TEXT PRIMARY KEY,
        agent   TEXT NOT NULL,
        channel TEXT NOT NULL,
        started TEXT NOT NULL,
        ended   TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content    TEXT NOT NULL,
        ts         TEXT NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS branches (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        parent_branch_id  INTEGER REFERENCES branches(id),
        fork_from_turn_id INTEGER REFERENCES turns(id),
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, name)
      )
    `);
    try {
      this.db.run("ALTER TABLE turns ADD COLUMN branch_id INTEGER REFERENCES branches(id)");
    } catch {
      // Column already exists on upgraded databases.
    }
    try {
      this.db.run("ALTER TABLE sessions ADD COLUMN active_branch_id INTEGER REFERENCES branches(id)");
    } catch {
      // Column already exists on upgraded databases.
    }
    try {
      this.db.run("ALTER TABLE turns ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists on upgraded databases.
    }
    try {
      this.db.run("ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists on upgraded databases.
    }
    try {
      this.db.run("ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists on upgraded databases.
    }

    // One durable summary per castle session (rfcclub/anima#127): the earlier conversation that compaction
    // folded away. `version` lets a compaction publish only if no other one published since its snapshot.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        summary             TEXT NOT NULL,
        covers_through_turn INTEGER NOT NULL,
        version             INTEGER NOT NULL,
        updated_at          TEXT NOT NULL
      )
    `);

    // Narrative choices table — records user choices for branching narrative
    this.db.run(`
      CREATE TABLE IF NOT EXISTS narrative_choices (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        branch_id        INTEGER REFERENCES branches(id),
        parent_branch_id INTEGER REFERENCES branches(id),
        turn_id          INTEGER NOT NULL REFERENCES turns(id),
        label            TEXT NOT NULL,
        value            TEXT NOT NULL,
        agent_response   TEXT,
        choice_index     INTEGER NOT NULL,
        timestamp        TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_nc_branch ON narrative_choices(branch_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_nc_session ON narrative_choices(session_id)");

    this.db.run("CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent, started DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_branches_parent ON branches(parent_branch_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_turns_branch ON turns(branch_id)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS shared_conversations (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id),
        kind TEXT NOT NULL CHECK(kind IN ('ambient','meeting')),
        place_id TEXT NOT NULL,
        meeting_id TEXT UNIQUE,
        visibility TEXT NOT NULL CHECK(visibility IN ('members','colony')),
        reader_ids TEXT NOT NULL,
        inherited_from_conversation_id TEXT REFERENCES shared_conversations(session_id),
        closed_at TEXT,
        vacancy_version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, place_id)
      )
    `);
    try {
      this.db.run("ALTER TABLE shared_conversations ADD COLUMN inherited_from_conversation_id TEXT REFERENCES shared_conversations(session_id)");
    } catch {
      // Column already exists on upgraded databases.
    }
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS shared_one_open_ambient
      ON shared_conversations(place_id)
      WHERE kind = 'ambient' AND closed_at IS NULL
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS shared_utterances (
        turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
        conversation_id TEXT NOT NULL REFERENCES shared_conversations(session_id),
        utterance_key TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('ui','encounter','meeting')),
        source_id TEXT,
        meeting_id TEXT,
        public_payload TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS shared_requests (
        request_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES shared_conversations(session_id),
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','complete','failed','interrupted')),
        completed_speakers TEXT NOT NULL,
        error_code TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_shared_utterances_conversation_turn ON shared_utterances(conversation_id, turn_id)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS place_vacancy (
        place_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Loop runs that stopped before `done` (rfcclub/anima#71). Fields only — no prompts, memory or tool output.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        id             TEXT PRIMARY KEY,
        agent          TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        goal           TEXT NOT NULL,
        goal_hash      TEXT NOT NULL,
        stop_reason    TEXT NOT NULL,
        iteration      INTEGER NOT NULL,
        max_iterations INTEGER NOT NULL,
        last_outcome   TEXT NOT NULL,
        remaining      TEXT NOT NULL,
        status         TEXT NOT NULL,
        created_at     TEXT NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_run_checkpoints_lookup ON run_checkpoints(agent, goal_hash, status, created_at)");
    // anima #135: a checkpoint can belong to a castle work. Nullable, so older rows and callers are unaffected.
    const checkpointColumns = this.db.query("PRAGMA table_info(run_checkpoints)").all() as Array<{ name: string }>;
    if (!checkpointColumns.some((column) => column.name === "work_id")) this.db.run("ALTER TABLE run_checkpoints ADD COLUMN work_id TEXT");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_run_checkpoints_work ON run_checkpoints(work_id, created_at)");
  }

  static async open(dbPath: string = DEFAULT_DB_PATH): Promise<SessionStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      await configureMemoryWal(db);
      return new SessionStore(dbPath, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  saveRunCheckpoint(input: NewRunCheckpoint): RunCheckpoint {
    const checkpoint: RunCheckpoint = { ...input, id: randomUUID(), status: "open" };
    this.db.run(
      `INSERT INTO run_checkpoints (id, agent, session_id, goal, goal_hash, stop_reason, iteration, max_iterations, last_outcome, remaining, status, created_at, work_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [checkpoint.id, checkpoint.agent, checkpoint.sessionId, checkpoint.goal, checkpoint.goalHash, checkpoint.stopReason,
        checkpoint.iteration, checkpoint.maxIterations, checkpoint.lastOutcome, checkpoint.remaining, checkpoint.status, checkpoint.createdAt,
        checkpoint.workId ?? null],
    );
    return checkpoint;
  }

  getRunCheckpoint(id: string): RunCheckpoint | null {
    const row = this.db.query("SELECT * FROM run_checkpoints WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? this.mapRunCheckpoint(row) : null;
  }

  getLatestOpenRunCheckpoint(agent: string, goalHash: string): RunCheckpoint | null {
    const row = this.db.query(
      "SELECT * FROM run_checkpoints WHERE agent = ? AND goal_hash = ? AND status = 'open' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(agent, goalHash) as Record<string, unknown> | null;
    return row ? this.mapRunCheckpoint(row) : null;
  }

  /** A resumed latest checkpoint remains recoverable, but an older one cannot outlive a completed successor. */
  getLatestRunCheckpointForWork(workId: string): RunCheckpoint | null {
    const row = this.db.query(
      "SELECT * FROM run_checkpoints WHERE work_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(workId) as Record<string, unknown> | null;
    return row && (row.status === "open" || row.status === "resumed") ? this.mapRunCheckpoint(row) : null;
  }

  setRunCheckpointStatus(id: string, status: RunCheckpointStatus): void {
    this.db.run("UPDATE run_checkpoints SET status = ? WHERE id = ?", [status, id]);
  }

  private mapRunCheckpoint(row: Record<string, unknown>): RunCheckpoint {
    return {
      id: row.id as string,
      agent: row.agent as string,
      sessionId: row.session_id as string,
      goal: row.goal as string,
      goalHash: row.goal_hash as string,
      stopReason: row.stop_reason as RunCheckpoint["stopReason"],
      iteration: row.iteration as number,
      maxIterations: row.max_iterations as number,
      lastOutcome: row.last_outcome as RunCheckpoint["lastOutcome"],
      remaining: row.remaining as string,
      status: row.status as RunCheckpointStatus,
      createdAt: row.created_at as string,
      ...(row.work_id ? { workId: row.work_id as string } : {}),
    };
  }

  /** Current vacancy generation for a place — bumped by `markPlaceVacant`
   *  whenever occupancy drops to zero. A shared conversation stamps this
   *  value at creation; comparing it at next speech detects "the room was
   *  fully empty in between" even when the returning occupant set is
   *  byte-identical to the epoch's original readers, which plain reader-set
   *  diffing cannot see. Persisted (not in-memory) so it survives restart. */
  getPlaceVacancyVersion(placeId: string): number {
    const row = this.db.query("SELECT version FROM place_vacancy WHERE place_id = ?").get(placeId) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  markPlaceVacant(placeId: string): void {
    this.db.run(
      `INSERT INTO place_vacancy (place_id, version) VALUES (?, 1)
       ON CONFLICT(place_id) DO UPDATE SET version = version + 1`,
      [placeId],
    );
  }

  createSession(agent: string, channel: string): SessionRecord {
    if (agent === "@shared") throw new Error("@shared is reserved for internal shared conversation storage");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run("INSERT INTO sessions (id, agent, channel, started) VALUES (?, ?, ?, ?)", [id, agent, channel, now]);
    return { id, agent, channel, started: now, ended: null, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSession(row);
  }

  getLatestSession(agent: string, channel: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE agent = ? AND channel = ? ORDER BY started DESC, rowid DESC LIMIT 1").get(agent, channel) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSession(row);
  }

  createSharedConversation(input: CreateSharedConversationInput): SharedConversationRecord {
    const readerIds = this.normalizeIds(input.readerIds, "readerIds");
    if (!input.placeId) throw new Error("shared conversation requires placeId");
    if (input.kind === "ambient" && input.meetingId) throw new Error("ambient conversation cannot have meetingId");
    if (input.kind === "meeting" && !input.meetingId) throw new Error("meeting conversation requires meetingId");

    return this.transaction(() => {
      if (input.kind === "ambient") {
        const existing = this.getOpenAmbientConversation(input.placeId);
        if (existing) return existing;
      }
      if (input.kind === "meeting") {
        const existing = this.getSharedConversationByMeetingId(input.meetingId!);
        if (existing) return existing;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const channel = input.kind === "ambient" ? `ambient:${input.placeId}` : `meeting:${input.meetingId}`;
      this.db.run("INSERT INTO sessions (id, agent, channel, started) VALUES (?, '@shared', ?, ?)", [id, channel, now]);
      this.db.run(
        `INSERT INTO shared_conversations (session_id, kind, place_id, meeting_id, visibility, reader_ids, inherited_from_conversation_id, vacancy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.kind, input.placeId, input.meetingId ?? null, input.visibility, JSON.stringify(readerIds), input.inheritedFromConversationId ?? null, input.vacancyVersion ?? 0],
      );
      const rootBranchId = this.ensureMainBranch(id);
      return {
        sessionId: id,
        rootBranchId,
        kind: input.kind,
        placeId: input.placeId,
        meetingId: input.meetingId ?? null,
        visibility: input.visibility,
        readerIds,
        inheritedFromConversationId: input.inheritedFromConversationId ?? null,
        closedAt: null,
        vacancyVersion: input.vacancyVersion ?? 0,
      };
    });
  }

  getSharedConversation(sessionId: string): SharedConversationRecord | null {
    const row = this.db.query(`
      SELECT sc.*, s.active_branch_id
      FROM shared_conversations sc JOIN sessions s ON s.id = sc.session_id
      WHERE sc.session_id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapSharedConversation(row) : null;
  }

  getOpenAmbientConversation(placeId: string): SharedConversationRecord | null {
    const row = this.db.query(`
      SELECT sc.*, s.active_branch_id
      FROM shared_conversations sc JOIN sessions s ON s.id = sc.session_id
      WHERE sc.kind = 'ambient' AND sc.place_id = ? AND sc.closed_at IS NULL
    `).get(placeId) as Record<string, unknown> | undefined;
    return row ? this.mapSharedConversation(row) : null;
  }

  appendSharedUtterance(input: AppendSharedUtteranceInput): SharedUtteranceRecord {
    if (!input.speakerId || !input.content || !input.utteranceKey || !input.requestId) throw new Error("shared utterance requires speaker, content, key and request");
    return this.transaction(() => {
      const duplicate = this.db.query(`
        SELECT su.*, t.role, t.content, t.ts FROM shared_utterances su JOIN turns t ON t.id = su.turn_id
        WHERE su.utterance_key = ?
      `).get(input.utteranceKey) as Record<string, unknown> | undefined;
      if (duplicate) {
        const existing = this.mapSharedUtterance(duplicate);
        if (existing.conversationId !== input.conversationId || existing.content !== input.content || existing.speakerId !== input.speakerId) {
          throw new Error("shared utterance key conflicts with existing content");
        }
        return existing;
      }
      const conversation = this.getSharedConversation(input.conversationId);
      if (!conversation || conversation.closedAt) throw new Error("shared conversation is unavailable");
      if (input.meetingId && conversation.kind !== "meeting" && input.source !== "meeting") throw new Error("meeting metadata requires meeting speech");
      const now = new Date().toISOString();
      const result = this.db.run(
        "INSERT INTO turns (session_id, role, content, ts, branch_id) VALUES (?, ?, ?, ?, ?)",
        [conversation.sessionId, input.role, input.content, now, conversation.rootBranchId],
      );
      const turnId = Number(result.lastInsertRowid);
      this.db.run(
        `INSERT INTO shared_utterances (turn_id, conversation_id, utterance_key, request_id, speaker_id, source, source_id, meeting_id, public_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [turnId, conversation.sessionId, input.utteranceKey, input.requestId, input.speakerId, input.source, input.sourceId ?? null, input.meetingId ?? null, input.publicPayload ?? null],
      );
      return {
        turnId, conversationId: conversation.sessionId, utteranceKey: input.utteranceKey, requestId: input.requestId,
        speakerId: input.speakerId, role: input.role, content: input.content, source: input.source,
        sourceId: input.sourceId ?? null, meetingId: input.meetingId ?? null, publicPayload: input.publicPayload ?? null, ts: now,
      };
    });
  }

  getSharedUtterances(conversationId: string, options: { afterTurnId?: number; limit?: number } = {}): SharedUtteranceRecord[] {
    const limit = Math.min(100, Math.max(1, options.limit ?? 100));
    const rows = this.db.query(`
      WITH RECURSIVE lineage(session_id, depth) AS (
        SELECT session_id, 0 FROM shared_conversations WHERE session_id = ?
        UNION ALL
        SELECT sc.inherited_from_conversation_id, lineage.depth + 1
        FROM shared_conversations sc JOIN lineage ON sc.session_id = lineage.session_id
        WHERE sc.inherited_from_conversation_id IS NOT NULL AND lineage.depth < 50
      )
      SELECT su.*, t.role, t.content, t.ts
      FROM shared_utterances su JOIN turns t ON t.id = su.turn_id
      WHERE su.conversation_id IN (SELECT session_id FROM lineage) AND su.turn_id > ? AND t.deleted = 0
      ORDER BY su.turn_id ASC LIMIT ?
    `).all(conversationId, options.afterTurnId ?? 0, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapSharedUtterance(row));
  }

  /** Exact durable receipt lookup; never use a bounded history window for replay. */
  getSharedUtterancesForRequest(conversationId: string, requestId: string): SharedUtteranceRecord[] {
    return (this.db.query(`
      SELECT su.*, t.role, t.content, t.ts
      FROM shared_utterances su JOIN turns t ON t.id = su.turn_id
      WHERE su.conversation_id = ? AND su.request_id = ? AND t.deleted = 0
      ORDER BY su.turn_id ASC
    `).all(conversationId, requestId) as Record<string, unknown>[]).map(row => this.mapSharedUtterance(row));
  }

  closeSharedConversation(sessionId: string): void {
    this.transaction(() => {
      const conversation = this.getSharedConversation(sessionId);
      if (!conversation) throw new Error("shared conversation not found");
      if (conversation.closedAt) return;
      const now = new Date().toISOString();
      this.db.run("UPDATE shared_conversations SET closed_at = ? WHERE session_id = ?", [now, sessionId]);
      this.db.run("UPDATE sessions SET ended = ? WHERE id = ?", [now, sessionId]);
    });
  }

  beginSharedRequest(input: { requestKey: string; conversationId: string; inputHash: string }): SharedRequestRecord {
    if (!input.requestKey || !input.inputHash) throw new Error("shared request requires key and input hash");
    return this.transaction(() => {
      const existing = this.getSharedRequest(input.requestKey);
      if (existing) {
        if (existing.conversationId !== input.conversationId || existing.inputHash !== input.inputHash) {
          throw new Error("shared request key conflicts with existing request");
        }
        return existing;
      }
      const conversation = this.getSharedConversation(input.conversationId);
      if (!conversation || conversation.closedAt) throw new Error("shared conversation is unavailable");
      this.db.run(
        `INSERT INTO shared_requests (request_key, conversation_id, input_hash, status, completed_speakers)
         VALUES (?, ?, ?, 'running', '[]')`,
        [input.requestKey, input.conversationId, input.inputHash],
      );
      return { requestKey: input.requestKey, conversationId: input.conversationId, inputHash: input.inputHash, status: "running", completedSpeakers: [], errorCode: null };
    });
  }

  getSharedRequest(requestKey: string): SharedRequestRecord | null {
    const row = this.db.query("SELECT * FROM shared_requests WHERE request_key = ?").get(requestKey) as Record<string, unknown> | undefined;
    return row ? this.mapSharedRequest(row) : null;
  }

  updateSharedRequest(requestKey: string, update: {
    status: SharedRequestRecord["status"];
    completedSpeakers: string[];
    errorCode?: string | null;
  }): SharedRequestRecord {
    const completedSpeakers = this.normalizeIdsOrEmpty(update.completedSpeakers, "completedSpeakers");
    return this.transaction(() => {
      const existing = this.getSharedRequest(requestKey);
      if (!existing) throw new Error("shared request not found");
      this.db.run(
        "UPDATE shared_requests SET status = ?, completed_speakers = ?, error_code = ? WHERE request_key = ?",
        [update.status, JSON.stringify(completedSpeakers), update.errorCode ?? null, requestKey],
      );
      return { ...existing, status: update.status, completedSpeakers, errorCode: update.errorCode ?? null };
    });
  }

  interruptRunningSharedRequests(): number {
    return this.transaction(() => {
      const result = this.db.run(
        "UPDATE shared_requests SET status = 'interrupted', error_code = 'writer_restarted' WHERE status = 'running'",
      );
      return Number(result.changes);
    });
  }

  addCacheTokens(sessionId: string, cacheRead: number, cacheWrite: number): void {
    this.db.run(
      "UPDATE sessions SET cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ? WHERE id = ?",
      [cacheRead, cacheWrite, sessionId],
    );
  }

  endSession(id: string): void {
    this.db.run("UPDATE sessions SET ended = ? WHERE id = ?", [new Date().toISOString(), id]);
  }

  appendTurn(sessionId: string, role: "user" | "assistant", content: string, branchId: number | null = null): TurnRecord {
    const now = new Date().toISOString();
    const result = this.db.run("INSERT INTO turns (session_id, role, content, ts, branch_id) VALUES (?, ?, ?, ?, ?)", [
      sessionId,
      role,
      content,
      now,
      branchId,
    ]);
    return { id: Number(result.lastInsertRowid), sessionId, role, content, ts: now };
  }

  createBranch(sessionId: string, name: string, parentBranchId: number | null = null, forkFromTurnId: number | null = null): BranchRecord {
    if (parentBranchId !== null) {
      const parent = this.db.query("SELECT session_id FROM branches WHERE id = ?").get(parentBranchId) as { session_id: string } | undefined;
      if (!parent || parent.session_id !== sessionId) {
        throw new Error("parent branch must belong to same session");
      }
    }

    const result = this.db.run(
      "INSERT INTO branches (session_id, name, parent_branch_id, fork_from_turn_id) VALUES (?, ?, ?, ?)",
      [sessionId, name, parentBranchId, forkFromTurnId],
    );
    const row = this.db.query("SELECT * FROM branches WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`failed to create branch: ${name}`);
    return this.mapBranch(row);
  }

  getBranches(sessionId: string): BranchRecord[] {
    const rows = this.db.query("SELECT * FROM branches WHERE session_id = ? ORDER BY id ASC").all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapBranch(row));
  }

  getActiveBranch(sessionId: string): BranchRecord | null {
    const row = this.db
      .query(
        `
        SELECT b.*
        FROM branches b
        JOIN sessions s ON s.active_branch_id = b.id
        WHERE s.id = ?
        `,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapBranch(row) : null;
  }

  setActiveBranch(sessionId: string, branchId: number): void {
    const branch = this.db.query("SELECT session_id FROM branches WHERE id = ?").get(branchId) as { session_id: string } | undefined;
    if (!branch || branch.session_id !== sessionId) {
      throw new Error("active branch must belong to same session");
    }
    this.db.run("UPDATE sessions SET active_branch_id = ? WHERE id = ?", [branchId, sessionId]);
  }

  deleteBranch(branchId: number): void {
    const descendants = this.getDescendantBranches(branchId);
    if (descendants.length > 0) {
      const names = descendants.map((branch) => branch.name).join(", ");
      throw new Error(`cannot delete branch with descendants: ${names}`);
    }

    this.db.run("UPDATE turns SET deleted = 1 WHERE branch_id = ?", [branchId]);
    this.db.run("UPDATE turns SET branch_id = NULL WHERE branch_id = ?", [branchId]);
    this.db.run("DELETE FROM branches WHERE id = ?", [branchId]);
  }

  getDescendantBranches(branchId: number): BranchRecord[] {
    const descendants: BranchRecord[] = [];
    const queue = [branchId];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const rows = this.db.query("SELECT * FROM branches WHERE parent_branch_id = ? ORDER BY id ASC").all(parentId) as Record<string, unknown>[];
      const children = rows.map((row) => this.mapBranch(row));
      descendants.push(...children);
      queue.push(...children.map((child) => child.id));
    }

    return descendants;
  }

  getTurnsForBranch(branchId: number): TurnRecord[] {
    const chain: BranchRecord[] = [];
    let currentBranchId: number | null = branchId;

    for (let depth = 0; currentBranchId !== null; depth++) {
      if (depth >= 50) throw new Error("branch lineage depth exceeded 50");
      const row = this.db.query("SELECT * FROM branches WHERE id = ?").get(currentBranchId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`branch not found: ${currentBranchId}`);
      const branch = this.mapBranch(row);
      chain.unshift(branch);
      currentBranchId = branch.parentBranchId;
    }

    const turns: TurnRecord[] = [];
    for (let index = 0; index < chain.length; index++) {
      const branch = chain[index];
      const child = chain[index + 1];
      const rows =
        child?.forkFromTurnId !== undefined && child.forkFromTurnId !== null
          ? (this.db
              .query("SELECT * FROM turns WHERE branch_id = ? AND deleted = 0 AND id <= ? ORDER BY id ASC")
              .all(branch.id, child.forkFromTurnId) as Record<string, unknown>[])
          : (this.db.query("SELECT * FROM turns WHERE branch_id = ? AND deleted = 0 ORDER BY id ASC").all(branch.id) as Record<string, unknown>[]);
      turns.push(...rows.map((row) => this.mapTurn(row)));
    }

    return turns;
  }

  softDeleteTurnsOnBranch(branchId: number, keepLast: number): number {
    const rows = this.db
      .query("SELECT id FROM turns WHERE branch_id = ? AND deleted = 0 ORDER BY id ASC")
      .all(branchId) as Array<{ id: number }>;
    const deleteCount = Math.max(0, rows.length - Math.max(0, keepLast));
    if (deleteCount === 0) return 0;

    const ids = rows.slice(0, deleteCount).map((row) => row.id);
    this.db.run(`UPDATE turns SET deleted = 1 WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
    return ids.length;
  }

  getTurns(sessionId: string): TurnRecord[] {
    const rows = this.db.query("SELECT * FROM turns WHERE session_id = ? AND deleted = 0 ORDER BY id ASC").all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapTurn(row));
  }

  getSummary(sessionId: string): SessionSummary | null {
    const row = this.db.query("SELECT summary, covers_through_turn, version FROM session_summaries WHERE session_id = ?").get(sessionId) as
      { summary: string; covers_through_turn: number; version: number } | null;
    return row ? { summary: row.summary, coversThroughTurn: row.covers_through_turn, version: row.version } : null;
  }

  /**
   * Replace the session's summary and soft-delete exactly `turnIds`, in one transaction, only if the stored
   * version is still `expectedVersion` (0 = no summary yet). Returns false, changing nothing, when another
   * compaction published first.
   */
  publishSummary(input: { sessionId: string; expectedVersion: number; summary: string; coversThroughTurn: number; turnIds: number[] }): boolean {
    return this.transaction(() => {
      const current = (this.db.query("SELECT version FROM session_summaries WHERE session_id = ?").get(input.sessionId) as { version: number } | null)?.version ?? 0;
      if (current !== input.expectedVersion) return false;
      this.db.run(
        `INSERT INTO session_summaries (session_id, summary, covers_through_turn, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, covers_through_turn = excluded.covers_through_turn,
           version = excluded.version, updated_at = excluded.updated_at`,
        [input.sessionId, input.summary, input.coversThroughTurn, current + 1, new Date().toISOString()],
      );
      this.db.run(
        "UPDATE turns SET deleted = 1 WHERE session_id = ? AND deleted = 0 AND id IN (SELECT value FROM json_each(?))",
        [input.sessionId, JSON.stringify(input.turnIds)],
      );
      return true;
    });
  }

  softDeleteTurns(sessionId: string, olderThanTurnId: number): number {
    const result = this.db.run("UPDATE turns SET deleted = 1 WHERE session_id = ? AND id < ? AND deleted = 0", [sessionId, olderThanTurnId]);
    return result.changes;
  }

  deleteAllTurns(sessionId: string): void {
    this.db.run("DELETE FROM turns WHERE session_id = ?", [sessionId]);
  }

  countTurns(sessionId: string): number {
    const row = this.db.query("SELECT COUNT(*) as c FROM turns WHERE session_id = ? AND deleted = 0").get(sessionId) as { c: number };
    return row.c;
  }

  ensureMainBranch(sessionId: string): number {
    const session = this.db.query("SELECT active_branch_id FROM sessions WHERE id = ?").get(sessionId) as { active_branch_id: number | null } | undefined;
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.active_branch_id !== null) return session.active_branch_id;

    this.db.run("INSERT OR IGNORE INTO branches (session_id, name) VALUES (?, 'main')", [sessionId]);
    const main = this.db.query("SELECT id FROM branches WHERE session_id = ? AND name = 'main'").get(sessionId) as { id: number } | undefined;
    if (!main) throw new Error(`failed to create main branch for session: ${sessionId}`);

    this.db.run("UPDATE sessions SET active_branch_id = ? WHERE id = ?", [main.id, sessionId]);
    this.db.run("UPDATE turns SET branch_id = ? WHERE session_id = ? AND branch_id IS NULL", [main.id, sessionId]);
    return main.id;
  }

  getProtectedTurns(sessionId: string, recentCount: number): TurnRecord[] {
    const rows = this.db.query("SELECT * FROM turns WHERE session_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?").all(sessionId, recentCount) as Record<string, unknown>[];
    return rows.reverse().map((row) => this.mapTurn(row));
  }

  getOlderTurns(sessionId: string, olderThanTurnId: number): TurnRecord[] {
    const rows = this.db.query("SELECT * FROM turns WHERE session_id = ? AND id < ? AND deleted = 0 ORDER BY id ASC").all(sessionId, olderThanTurnId) as Record<string, unknown>[];
    return rows.map((row) => this.mapTurn(row));
  }

  popLastTurn(sessionId: string): TurnRecord | null {
    const row = this.db.query("SELECT * FROM turns WHERE session_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.run("DELETE FROM turns WHERE id = ?", [row.id] as SQLQueryBindings[]);
    return this.mapTurn(row);
  }

  getLastUserMessage(sessionId: string): TurnRecord | null {
    const row = this.db.query("SELECT * FROM turns WHERE session_id = ? AND role = 'user' AND deleted = 0 ORDER BY id DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTurn(row);
  }

  getPaginatedTurns(sessionId: string, opts: { n: number; offset: number }): { turns: TurnRecord[]; total: number } {
    const total = this.countTurns(sessionId);
    const rows = this.db.query("SELECT * FROM turns WHERE session_id = ? AND deleted = 0 ORDER BY id ASC LIMIT ? OFFSET ?").all(sessionId, opts.n, opts.offset) as Record<string, unknown>[];
    const turns = rows.map((row) => this.mapTurn(row));
    return { turns, total };
  }

  close(): void {
    this.db.close();
  }

  private mapSession(row: Record<string, unknown>): SessionRecord {
    return {
      id: row.id as string,
      agent: row.agent as string,
      channel: row.channel as string,
      started: row.started as string,
      ended: row.ended as string | null,
      cacheReadTokens: (row.cache_read_tokens as number | null) ?? 0,
      cacheWriteTokens: (row.cache_write_tokens as number | null) ?? 0,
    };
  }

  private mapBranch(row: Record<string, unknown>): BranchRecord {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      name: row.name as string,
      parentBranchId: row.parent_branch_id as number | null,
      forkFromTurnId: row.fork_from_turn_id as number | null,
      createdAt: row.created_at as string,
    };
  }

  private mapTurn(row: Record<string, unknown>): TurnRecord {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as "user" | "assistant",
      content: row.content as string,
      ts: row.ts as string,
    };
  }

  private getSharedConversationByMeetingId(meetingId: string): SharedConversationRecord | null {
    const row = this.db.query(`
      SELECT sc.*, s.active_branch_id
      FROM shared_conversations sc JOIN sessions s ON s.id = sc.session_id
      WHERE sc.meeting_id = ?
    `).get(meetingId) as Record<string, unknown> | undefined;
    return row ? this.mapSharedConversation(row) : null;
  }

  private mapSharedConversation(row: Record<string, unknown>): SharedConversationRecord {
    const rootBranchId = row.active_branch_id as number | null;
    if (rootBranchId === null) throw new Error(`shared conversation has no root branch: ${row.session_id as string}`);
    return {
      sessionId: row.session_id as string,
      rootBranchId,
      kind: row.kind as SharedConversationRecord["kind"],
      placeId: row.place_id as string,
      meetingId: row.meeting_id as string | null,
      visibility: row.visibility as SharedConversationRecord["visibility"],
      readerIds: this.parseIds(row.reader_ids, "reader_ids"),
      inheritedFromConversationId: row.inherited_from_conversation_id as string | null,
      closedAt: row.closed_at as string | null,
      vacancyVersion: row.vacancy_version as number,
    };
  }

  private mapSharedUtterance(row: Record<string, unknown>): SharedUtteranceRecord {
    return {
      turnId: row.turn_id as number,
      conversationId: row.conversation_id as string,
      utteranceKey: row.utterance_key as string,
      requestId: row.request_id as string,
      speakerId: row.speaker_id as string,
      role: row.role as SharedUtteranceRecord["role"],
      content: row.content as string,
      source: row.source as SharedUtteranceRecord["source"],
      sourceId: row.source_id as string | null,
      meetingId: row.meeting_id as string | null,
      publicPayload: row.public_payload as string | null,
      ts: row.ts as string,
    };
  }

  private mapSharedRequest(row: Record<string, unknown>): SharedRequestRecord {
    return {
      requestKey: row.request_key as string,
      conversationId: row.conversation_id as string,
      inputHash: row.input_hash as string,
      status: row.status as SharedRequestRecord["status"],
      completedSpeakers: this.normalizeIdsOrEmpty(JSON.parse(row.completed_speakers as string), "completed_speakers"),
      errorCode: row.error_code as string | null,
    };
  }

  private normalizeIds(ids: string[], label: string): string[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !id || id.startsWith("@"))) {
      throw new Error(`${label} must be non-empty non-reserved IDs`);
    }
    const normalized = [...new Set(ids)].sort();
    if (normalized.length !== ids.length || normalized.some((id, index) => id !== ids[index])) {
      throw new Error(`${label} must be sorted and deduplicated`);
    }
    return normalized;
  }

  private parseIds(value: unknown, label: string): string[] {
    try {
      return this.normalizeIds(JSON.parse(String(value)), label);
    } catch (error) {
      throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private normalizeIdsOrEmpty(ids: string[], label: string): string[] {
    if (Array.isArray(ids) && ids.length === 0) return [];
    return this.normalizeIds(ids, label);
  }

  private transaction<T>(fn: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  // ── Narrative Choices ───────────────────────────────────────────────

  recordChoice(choice: {
    id: string;
    sessionId: string;
    branchId: number | null;
    parentBranchId: number | null;
    turnId: number;
    label: string;
    value: string;
    agentResponse?: string;
    choiceIndex: number;
  }): void {
    this.db.run(
      `INSERT INTO narrative_choices (id, session_id, branch_id, parent_branch_id, turn_id, label, value, agent_response, choice_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [choice.id, choice.sessionId, choice.branchId, choice.parentBranchId, choice.turnId, choice.label, choice.value, choice.agentResponse ?? null, choice.choiceIndex],
    );
  }

  getNarrativeChoices(sessionId: string): Array<{
    id: string; branchId: number | null; parentBranchId: number | null;
    turnId: number; label: string; value: string; choiceIndex: number;
    timestamp: string;
  }> {
    const rows = this.db.query(
      "SELECT id, branch_id, parent_branch_id, turn_id, label, value, choice_index, timestamp FROM narrative_choices WHERE session_id = ? ORDER BY turn_id ASC",
    ).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      branchId: (r.branch_id as number) ?? null,
      parentBranchId: (r.parent_branch_id as number) ?? null,
      turnId: r.turn_id as number,
      label: r.label as string,
      value: r.value as string,
      choiceIndex: r.choice_index as number,
      timestamp: r.timestamp as string,
    }));
  }

  getChoicesForBranch(branchId: number): Array<{
    id: string; label: string; value: string; turnId: number; timestamp: string;
  }> {
    const rows = this.db.query(
      "SELECT id, label, value, turn_id, timestamp FROM narrative_choices WHERE branch_id = ? ORDER BY turn_id ASC",
    ).all(branchId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      label: r.label as string,
      value: r.value as string,
      turnId: r.turn_id as number,
      timestamp: r.timestamp as string,
    }));
  }
}
