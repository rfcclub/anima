/**
 * Shared Narrative Store — cross-agent state propagation
 *
 * One shared DB at rooms/_shared/memory.db for narrative flags, counters,
 * and thread references visible across agents.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { automationMarkTtlMs, isAutomationMark, markTimestampMs } from "./automation-marks";

export interface SharedNarrativeFlag {
  key: string;
  value: string;
  setBy: string;
  setAt: string;
}

export interface AutomationMark extends SharedNarrativeFlag {
  expiresAt: number | null;
}

export interface SharedNarrativeThread {
  id: string;
  fromAgent: string;
  toAgent: string;
  label: string;
  value: string;
  timestamp: string;
}

// ── Places & Presence (Castle Step 1) ──────────────────────────────────────────

export type PlaceKind =
  | "chamber"
  | "hall"
  | "garden"
  | "workshop"
  | "gate_machine"
  | "gate_world";

export type PlaceId = string;

export interface Place {
  id: string;
  kind: PlaceKind;
  label: string;
  meta?: Record<string, unknown>;
}

export interface Presence {
  agentId: string;
  placeId: string;
  since: number;
  mood?: string;
  activity?: string;
}

// ── Meetings (castle-social-meetings, Step 3) ───────────────────────────

export type MeetingStakes = "normal" | "decision";
export type MeetingStatus = "open" | "closed";
export type MeetingVisibility = "members" | "colony";

export interface Meeting {
  id: string;
  topic: string;
  convener: string;
  placeId: string;
  agenda: string;
  stakes: MeetingStakes;
  status: MeetingStatus;
  turns: number;
  createdAt: number;
  closedAt: number | null;
  /** v2 shared-conversation binding. Legacy meetings have null values until
   * their first shared speech; they are never inferred from topic/day files. */
  visibility: MeetingVisibility | null;
  conversationId: string | null;
  readerIds: string[] | null;
}

export type MeetingResult =
  | { ok: true; meeting: Meeting }
  | { ok: false; reason: "cap-open" | "cap-attendees" | "closed" | "unknown" | "not-convener" | "not-attending" | "exhausted" };

export const MEETING_MAX_OPEN = 2;
export const MEETING_MAX_ATTENDEES = 4;
export const MEETING_MAX_ROUNDS = 3;
export const MEETING_TTL_MS = 24 * 60 * 60 * 1000;

// ── Expeditions (castle-social-expeditions, Step 5) ──────────────────────

export type ExpeditionTarget = "machine" | "world";
export type ExpeditionStatus = "claimed" | "running" | "ended";

export interface Expedition {
  id: string;
  agentId: string;
  target: ExpeditionTarget;
  status: ExpeditionStatus;
  startedAt: number | null;
  endedAt: number | null;
  discoveryRef: string | null;
}

export type ExpeditionResult =
  | { ok: true; expedition: Expedition }
  | { ok: false; reason: "ladder" | "unknown" | "not-claimed" | "not-running" };

const VALID_PLACE_KINDS: readonly PlaceKind[] = [
  "chamber",
  "hall",
  "garden",
  "workshop",
  "gate_machine",
  "gate_world",
];

function isPlaceKind(value: string): value is PlaceKind {
  return (VALID_PLACE_KINDS as readonly string[]).includes(value);
}

export class SharedNarrativeStore {
  private db: Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = join(dbPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=3000");
    this.ensureSchema();
    this.migrateAutomationMarks();
    this.pruneExpiredMarks();
  }

  private ensureSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS shared_flags (
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        set_by      TEXT NOT NULL,
        set_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (key)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS automation_marks (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        set_by TEXT NOT NULL,
        set_at TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_automation_marks_expiry ON automation_marks(expires_at)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS shared_counters (
        key         TEXT NOT NULL,
        value       INTEGER NOT NULL DEFAULT 0,
        set_by      TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (key)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS narrative_threads (
        id           TEXT NOT NULL PRIMARY KEY,
        from_agent   TEXT NOT NULL,
        to_agent     TEXT NOT NULL,
        label        TEXT NOT NULL,
        value        TEXT,
        choice_index INTEGER,
        session_id   TEXT,
        timestamp    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS places (
        id    TEXT PRIMARY KEY,
        kind  TEXT NOT NULL,
        label TEXT NOT NULL,
        meta  TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS presence (
        agent_id  TEXT PRIMARY KEY,
        place_id  TEXT NOT NULL REFERENCES places(id),
        since     INTEGER NOT NULL,
        mood      TEXT,
        activity  TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_presence_place ON presence(place_id)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS meetings (
        id         TEXT PRIMARY KEY,
        topic      TEXT NOT NULL,
        convener   TEXT NOT NULL,
        place_id   TEXT NOT NULL REFERENCES places(id),
        agenda     TEXT NOT NULL,
        stakes     TEXT NOT NULL DEFAULT 'normal',
        status     TEXT NOT NULL DEFAULT 'open',
        turns      INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at  INTEGER
      )
    `);
    // Additive migrations keep existing meeting rows readable. We deliberately
    // leave them unbound rather than guessing an audience from a topic file.
    for (const migration of [
      "ALTER TABLE meetings ADD COLUMN visibility TEXT",
      "ALTER TABLE meetings ADD COLUMN conversation_id TEXT",
      "ALTER TABLE meetings ADD COLUMN reader_ids TEXT",
    ]) {
      try { this.db.run(migration); } catch { /* column already present */ }
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meeting_attendance (
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        agent_id   TEXT NOT NULL,
        joined_at  INTEGER NOT NULL,
        left_at    INTEGER,
        PRIMARY KEY (meeting_id, agent_id)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_attendance_agent ON meeting_attendance(agent_id)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meeting_invitations (
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        invitee    TEXT NOT NULL,
        invited_at INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, invitee)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_invitations_invitee ON meeting_invitations(invitee)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meeting_applied_turns (
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        canonical_turn_ref TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, canonical_turn_ref)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS expeditions (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        target        TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'claimed',
        started_at    INTEGER,
        ended_at      INTEGER,
        discovery_ref TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_expeditions_status ON expeditions(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_expeditions_agent ON expeditions(agent_id)");

    this.db.run("CREATE INDEX IF NOT EXISTS idx_nt_from ON narrative_threads(from_agent)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_nt_to ON narrative_threads(to_agent)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_nt_ts ON narrative_threads(timestamp)");

    // Auto-seed default (non-agent) places on construction so the world exists
    // even before a roster is known. Chambers are added via seedPlacesFromRoster.
    this.seedPlaces([]);
  }

  // ── Places ─────────────────────────────────────────────────────────────

  /** Seed default places from a roster of agent ids. Idempotent. */
  seedPlacesFromRoster(agentIds: string[]): void {
    this.seedPlaces(agentIds);
  }

  private seedPlaces(agentIds: string[]): void {
    const defaults: Array<{ id: string; kind: PlaceKind; label: string }> = [];
    for (const id of agentIds) {
      defaults.push({ id: `chamber_${id}`, kind: "chamber", label: `${id}'s chamber` });
    }
    defaults.push({ id: "hall_main", kind: "hall", label: "Main Hall" });
    defaults.push({ id: "garden", kind: "garden", label: "Garden" });
    defaults.push({ id: "workshop", kind: "workshop", label: "Workshop" });
    defaults.push({ id: "gate_machine", kind: "gate_machine", label: "Machine Gate" });
    defaults.push({ id: "gate_world", kind: "gate_world", label: "World Gate" });
    defaults.push({ id: "library", kind: "hall", label: "Library" });
    defaults.push({ id: "observatory", kind: "hall", label: "Observatory" });

    // INSERT OR IGNORE makes this idempotent per-place: re-seeding never
    // duplicates and never overwrites existing rows.
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO places (id, kind, label, meta) VALUES (?, ?, ?, ?)",
    );
    for (const p of defaults) {
      insert.run(p.id, p.kind, p.label, null);
    }
  }

  getPlace(id: string): Place | null {
    const row = this.db.query("SELECT * FROM places WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      kind: row.kind as PlaceKind,
      label: row.label as string,
      meta: parseMeta(row.meta as string | null),
    };
  }

  listPlaces(): Place[] {
    const rows = this.db.query("SELECT * FROM places ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      kind: row.kind as PlaceKind,
      label: row.label as string,
      meta: parseMeta(row.meta as string | null),
    }));
  }

  /** Update a place's meta. Merges with existing meta. */
  updatePlaceMeta(id: string, meta: Record<string, unknown>): void {
    const existing = this.getPlace(id);
    if (!existing) {
      throw new Error(`place not found: ${id}`);
    }
    const merged = { ...(existing.meta ?? {}), ...meta };
    this.db.run("UPDATE places SET meta = ? WHERE id = ?", [
      JSON.stringify(merged),
      id,
    ]);
  }

  // ── Presence ────────────────────────────────────────────────────────────

  setPresence(p: Presence): void {
    // Validate place exists (FK enforced at DB level too, but this gives a clean error)
    const place = this.getPlace(p.placeId);
    if (!place) {
      throw new Error(`unknown place_id: ${p.placeId}`);
    }
    this.db.run(
      `INSERT INTO presence (agent_id, place_id, since, mood, activity)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         place_id = excluded.place_id,
         since     = excluded.since,
         mood      = excluded.mood,
         activity  = excluded.activity`,
      [p.agentId, p.placeId, p.since, p.mood ?? null, p.activity ?? null],
    );
  }

  getPresence(agentId: string): Presence | null {
    const row = this.db.query("SELECT * FROM presence WHERE agent_id = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id as string,
      placeId: row.place_id as string,
      since: row.since as number,
      mood: (row.mood as string | null) ?? undefined,
      activity: (row.activity as string | null) ?? undefined,
    };
  }

  listPresence(): Presence[] {
    const rows = this.db.query("SELECT * FROM presence ORDER BY agent_id").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      agentId: row.agent_id as string,
      placeId: row.place_id as string,
      since: row.since as number,
      mood: (row.mood as string | null) ?? undefined,
      activity: (row.activity as string | null) ?? undefined,
    }));
  }

  /** Remove an agent's presence row (e.g. the user leaving a room). */
  removePresence(agentId: string): void {
    this.db.run("DELETE FROM presence WHERE agent_id = ?", [agentId]);
  }

  // ── Meetings (castle-social-meetings, Step 3) ──────────────────────

  /** Test helper: does a table exist (schema introspection). */
  tableExists(name: string): boolean {
    const row = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { name: string } | null;
    return row !== null;
  }

  conveneMeeting(input: {
    id: string;
    topic: string;
    convener: string;
    placeId: string;
    agenda: string;
    stakes?: MeetingStakes;
    now: number;
    /** Agents invited (not yet joined). Recorded in meeting_invitations. */
    invite?: string[];
    /** Absent means the safe v2 default: frozen participants only. */
    visibility?: MeetingVisibility;
  }): MeetingResult {
    const stakes: MeetingStakes = input.stakes === "decision" ? "decision" : "normal";
    const openCount = (
      this.db.query("SELECT COUNT(*) AS c FROM meetings WHERE status='open'").get() as { c: number }
    ).c;
    if (openCount >= MEETING_MAX_OPEN) return { ok: false, reason: "cap-open" };
    this.db.run(
      "INSERT INTO meetings (id, topic, convener, place_id, agenda, stakes, status, turns, created_at, updated_at, visibility) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)",
      [input.id, input.topic, input.convener, input.placeId, input.agenda, stakes, input.now, input.now, input.visibility ?? null],
    );
    this.db.run(
      "INSERT INTO meeting_attendance (meeting_id, agent_id, joined_at) VALUES (?, ?, ?)",
      [input.id, input.convener, input.now],
    );
    // Record invitations so invitees see the meeting in ORIENT before joining.
    // The convener is already attending, so exclude her from the invite list.
    const invitees = (input.invite ?? []).filter((a) => a !== input.convener);
    for (const invitee of invitees) {
      this.db.run(
        "INSERT OR IGNORE INTO meeting_invitations (meeting_id, invitee, invited_at) VALUES (?, ?, ?)",
        [input.id, invitee, input.now],
      );
    }
    return {
      ok: true,
      meeting: {
        id: input.id,
        topic: input.topic,
        convener: input.convener,
        placeId: input.placeId,
        agenda: input.agenda,
        stakes,
        status: "open",
        turns: 0,
        createdAt: input.now,
        closedAt: null,
        visibility: input.visibility ?? null,
        conversationId: null,
        readerIds: null,
      },
    };
  }

  /** Close meetings whose created_at is older than the TTL, then return open ones. */
  openMeetings(now: number): Meeting[] {
    this.db.run(
      "UPDATE meetings SET status='closed', closed_at=? WHERE status='open' AND created_at < ?",
      [now, now - MEETING_TTL_MS],
    );
    const rows = this.db.query("SELECT * FROM meetings WHERE status='open' ORDER BY created_at").all() as Record<string, unknown>[];
    return rows.map((r) => mapMeeting(r));
  }

  joinMeeting(meetingId: string, agentId: string, now: number): MeetingResult {
    const open = this.openMeetings(now).find((m) => m.id === meetingId);
    if (!open) return { ok: false, reason: "unknown" };
    const attending = (
      this.db.query("SELECT COUNT(*) AS c FROM meeting_attendance WHERE meeting_id=? AND left_at IS NULL").get(meetingId) as { c: number }
    ).c;
    if (attending >= MEETING_MAX_ATTENDEES) return { ok: false, reason: "cap-attendees" };
    this.db.run(
      "INSERT OR IGNORE INTO meeting_attendance (meeting_id, agent_id, joined_at) VALUES (?, ?, ?)",
      [meetingId, agentId, now],
    );
    return { ok: true, meeting: open };
  }

  isAttending(meetingId: string, agentId: string): boolean {
    // bun:sqlite .get() returns null (not undefined) when no row matches.
    const row = this.db
      .query("SELECT 1 FROM meeting_attendance WHERE meeting_id=? AND agent_id=? AND left_at IS NULL")
      .get(meetingId, agentId) as { 1: number } | null;
    return row !== null;
  }

  /** Whether `agentId` was invited to `meetingId` and the meeting is still open. */
  isInvited(meetingId: string, agentId: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM meeting_invitations WHERE meeting_id=? AND invitee=?")
      .get(meetingId, agentId) as { 1: number } | null;
    return row !== null;
  }

  /** The frozen reader set is created from this list exactly once, when the
   * meeting first binds a shared conversation. Later attendance never widens
   * prior history. */
  initialMeetingReaders(meetingId: string): string[] {
    const rows = this.db.query(`
      SELECT agent_id AS id FROM meeting_attendance WHERE meeting_id = ?
      UNION
      SELECT invitee AS id FROM meeting_invitations WHERE meeting_id = ?
      ORDER BY id
    `).all(meetingId, meetingId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getMeetingConversation(meetingId: string): Pick<Meeting, "conversationId" | "visibility" | "readerIds"> | null {
    const row = this.db.query("SELECT conversation_id, visibility, reader_ids FROM meetings WHERE id = ?").get(meetingId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      conversationId: (row.conversation_id as string | null) ?? null,
      visibility: (row.visibility as MeetingVisibility | null) ?? null,
      readerIds: row.reader_ids ? JSON.parse(row.reader_ids as string) as string[] : null,
    };
  }

  bindMeetingConversation(meetingId: string, binding: { conversationId: string; visibility: MeetingVisibility; readerIds: string[] }): void {
    const readers = [...new Set(binding.readerIds)].sort();
    if (readers.length === 0 || readers.some((id) => !id || id.startsWith("@"))) throw new Error("meeting reader set is invalid");
    const result = this.db.run(
      "UPDATE meetings SET conversation_id = ?, visibility = ?, reader_ids = ? WHERE id = ? AND conversation_id IS NULL",
      [binding.conversationId, binding.visibility, JSON.stringify(readers), meetingId],
    );
    if (result.changes === 0) {
      const existing = this.getMeetingConversation(meetingId);
      if (!existing || existing.conversationId !== binding.conversationId) throw new Error("meeting already bound to a different conversation");
    }
  }

  /** Record one turn. Returns exhausted:true when the round cap is reached
   *  (attendees × MEETING_MAX_ROUNDS), which closes the meeting. */
  recordMeetingTurn(
    meetingId: string,
    agentId: string,
    now: number,
    canonicalTurnRef?: string,
  ): MeetingResult & { exhausted?: boolean } {
    const open = this.openMeetings(now).find((m) => m.id === meetingId);
    if (!open) return { ok: false, reason: "closed" };
    if (!this.isAttending(meetingId, agentId)) return { ok: false, reason: "not-attending" };
    if (canonicalTurnRef) {
      const existing = this.db.query("SELECT 1 FROM meeting_applied_turns WHERE meeting_id = ? AND canonical_turn_ref = ?").get(meetingId, canonicalTurnRef);
      if (existing) return { ok: true, meeting: open, exhausted: false };
      this.db.run("INSERT INTO meeting_applied_turns (meeting_id, canonical_turn_ref, applied_at) VALUES (?, ?, ?)", [meetingId, canonicalTurnRef, now]);
    }
    const turns = open.turns + 1;
    const attendeeCount = (
      this.db.query("SELECT COUNT(*) AS c FROM meeting_attendance WHERE meeting_id=? AND left_at IS NULL").get(meetingId) as { c: number }
    ).c;
    const cap = attendeeCount * MEETING_MAX_ROUNDS;
    const exhausted = turns >= cap;
    this.db.run(
      "UPDATE meetings SET turns=?, updated_at=? WHERE id=?",
      [turns, now, meetingId],
    );
    if (exhausted) {
      this.db.run("UPDATE meetings SET status='closed', closed_at=? WHERE id=?", [now, meetingId]);
    }
    const meeting: Meeting = { ...open, turns, status: exhausted ? "closed" : "open", closedAt: exhausted ? now : null };
    return { ok: true, meeting, exhausted };
  }

  closeMeeting(meetingId: string, agentId: string, now: number): MeetingResult {
    const open = this.openMeetings(now).find((m) => m.id === meetingId);
    if (!open) return { ok: false, reason: "closed" };
    if (open.convener !== agentId) return { ok: false, reason: "not-convener" };
    this.db.run("UPDATE meetings SET status='closed', closed_at=?, updated_at=? WHERE id=?", [now, now, meetingId]);
    return { ok: true, meeting: { ...open, status: "closed", closedAt: now } };
  }

  /** Open meetings an agent is invited to / attending (convener or attendee). */
  meetingsForAgent(agentId: string, now: number): Meeting[] {
    return this.openMeetings(now).filter((m) => {
      if (m.convener === agentId) return true;
      if (this.isAttending(m.id, agentId)) return true;
      if (this.isInvited(m.id, agentId)) return true;
      return false;
    });
  }

  /** Rebuild meetings + attendance from a MEETING_* event stream (payload-only). */
  rebuildMeetingsFromEvents(events: Array<{ type: string; payload: Record<string, unknown>; timestamp: string; agentId?: string }>): void {
    for (const e of events) {
      const p = e.payload;
      const ts = Date.parse(e.timestamp);
      if (e.type === "MEETING_CONVENED") {
        const id = p.meetingId as string;
        const exists = this.db.query("SELECT 1 FROM meetings WHERE id=?").get(id);
        if (!exists) {
          const convener = (p.convener as string) ?? e.agentId ?? "";
          this.db.run(
            "INSERT INTO meetings (id, topic, convener, place_id, agenda, stakes, status, turns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)",
            [id, (p.topic as string) ?? "", convener, (p.placeId as string) ?? "hall_main", (p.agenda as string) ?? "", (p.stakes as string) ?? "normal", ts, ts],
          );
          this.db.run(
            "INSERT OR IGNORE INTO meeting_attendance (meeting_id, agent_id, joined_at) VALUES (?, ?, ?)",
            [id, convener, ts],
          );
        }
      } else if (e.type === "MEETING_JOINED") {
        const id = p.meetingId as string;
        this.db.run(
          "INSERT OR IGNORE INTO meeting_attendance (meeting_id, agent_id, joined_at) VALUES (?, ?, ?)",
          [id, e.agentId ?? "", ts],
        );
      } else if (e.type === "MEETING_TURN") {
        const id = p.meetingId as string;
        this.db.run("UPDATE meetings SET turns=turns+1, updated_at=? WHERE id=?", [ts, id]);
      } else if (e.type === "MEETING_CLOSED") {
        const id = p.meetingId as string;
        this.db.run("UPDATE meetings SET status='closed', closed_at=?, updated_at=? WHERE id=?", [ts, ts, id]);
      }
    }
  }

  // ── Expeditions (castle-social-expeditions, Step 5) ────────────────

  claimExpedition(input: {
    id: string;
    agentId: string;
    target: ExpeditionTarget;
    now: number;
  }): ExpeditionResult {
    // Daily ladder: one expedition per agent per day (flag = today's date).
    const today = new Date(input.now).toISOString().slice(0, 10);
    const ladder = this.getMark(`expedition:${input.agentId}`);
    if (ladder?.value === today) return { ok: false, reason: "ladder" };
    this.db.run(
      "INSERT INTO expeditions (id, agent_id, target, status, started_at, ended_at, discovery_ref) VALUES (?, ?, ?, 'claimed', NULL, NULL, NULL)",
      [input.id, input.agentId, input.target],
    );
    this.setMark(`expedition:${input.agentId}`, today, input.agentId);
    return {
      ok: true,
      expedition: {
        id: input.id,
        agentId: input.agentId,
        target: input.target,
        status: "claimed",
        startedAt: null,
        endedAt: null,
        discoveryRef: null,
      },
    };
  }

  startExpedition(id: string, now: number): ExpeditionResult {
    const row = this.db.query("SELECT * FROM expeditions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: "unknown" };
    if (row.status !== "claimed") return { ok: false, reason: "not-claimed" };
    this.db.run("UPDATE expeditions SET status='running', started_at=? WHERE id=?", [now, id]);
    return { ok: true, expedition: { ...mapExpedition(row), status: "running", startedAt: now } };
  }

  endExpedition(id: string, discoveryRef: string | null, now: number): ExpeditionResult {
    const row = this.db.query("SELECT * FROM expeditions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: "unknown" };
    if (row.status !== "running") return { ok: false, reason: "not-running" };
    this.db.run("UPDATE expeditions SET status='ended', ended_at=?, discovery_ref=? WHERE id=?", [now, discoveryRef, id]);
    return { ok: true, expedition: { ...mapExpedition(row), status: "ended", endedAt: now, discoveryRef } };
  }

  claimedExpeditions(): Expedition[] {
    const rows = this.db.query("SELECT * FROM expeditions WHERE status='claimed' ORDER BY started_at, rowid").all() as Record<string, unknown>[];
    return rows.map(mapExpedition);
  }

  getExpedition(id: string): Expedition | null {
    const row = this.db.query("SELECT * FROM expeditions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapExpedition(row) : null;
  }

  rebuildExpeditionsFromEvents(events: Array<{ type: string; payload: Record<string, unknown>; timestamp: string }>): void {
    for (const e of events) {
      const p = e.payload;
      if (e.type === "EXPEDITION_CLAIMED") {
        const id = p.expeditionId as string;
        const exists = this.db.query("SELECT 1 FROM expeditions WHERE id=?").get(id);
        if (!exists) {
          this.db.run(
            "INSERT INTO expeditions (id, agent_id, target, status, started_at, ended_at, discovery_ref) VALUES (?, ?, ?, 'claimed', NULL, NULL, NULL)",
            [id, (p.agentId as string) ?? "", (p.target as string) ?? "machine"],
          );
        }
      } else if (e.type === "EXPEDITION_ENDED") {
        const id = p.expeditionId as string;
        this.db.run("UPDATE expeditions SET status='ended', ended_at=? WHERE id=?", [Date.parse(e.timestamp), id]);
      }
    }
  }

  // ── Automation marks (never part of the narrative prompt) ──────────

  private migrateAutomationMarks(): void {
    this.db.transaction(() => {
      const rows = this.db.query("SELECT * FROM shared_flags").all() as Array<{ key: string; value: string; set_by: string; set_at: string }>;
      const insert = this.db.query("INSERT INTO automation_marks (key,value,set_by,set_at,expires_at) VALUES (?,?,?,?,?)");
      // Production migration requires human approval and a verified backup (see change rollback plan).
      const remove = this.db.query("DELETE FROM shared_flags WHERE key=?");
      for (const row of rows) {
        if (!isAutomationMark(row.key)) continue;
        const ttl = automationMarkTtlMs(row.key);
        const timestamp = markTimestampMs(row.set_at);
        if (ttl !== undefined && !Number.isFinite(timestamp)) throw new Error(`Invalid automation mark timestamp: ${row.key}`);
        // A collision aborts the whole migration. Never silently overwrite either writer's state.
        insert.run(row.key, row.value, row.set_by, row.set_at, ttl === undefined ? null : timestamp + ttl);
        remove.run(row.key);
      }
    })();
  }

  pruneExpiredMarks(now = Date.now()): void {
    this.db.run("DELETE FROM automation_marks WHERE expires_at IS NOT NULL AND expires_at <= ?", [now]);
  }

  setMark(key: string, value: string, setBy: string, ttlMs = automationMarkTtlMs(key)): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) throw new Error("Mark TTL must be finite and positive");
    const now = Date.now();
    this.db.run("INSERT OR REPLACE INTO automation_marks (key,value,set_by,set_at,expires_at) VALUES (?,?,?,?,?)",
      [key, value, setBy, new Date(now).toISOString(), ttlMs === undefined ? null : now + ttlMs]);
  }

  getMark(key: string): AutomationMark | null {
    this.pruneExpiredMarks();
    const row = this.db.query("SELECT * FROM automation_marks WHERE key=?").get(key) as Record<string, unknown> | undefined;
    return row ? mapAutomationMark(row) : null;
  }

  listMarks(prefix: string): AutomationMark[] {
    this.pruneExpiredMarks();
    const rows = this.db.query("SELECT * FROM automation_marks WHERE substr(key,1,length(?))=? ORDER BY julianday(set_at) DESC, rowid DESC")
      .all(prefix, prefix) as Record<string, unknown>[];
    return rows.map(mapAutomationMark);
  }

  // ── Flags ───────────────────────────────────────────────────────────

  setFlag(key: string, value: string, agentId: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO shared_flags (key, value, set_by, set_at) VALUES (?, ?, ?, datetime('now'))",
      [key, value, agentId],
    );
  }

  getFlag(key: string): SharedNarrativeFlag | null {
    const row = this.db.query("SELECT * FROM shared_flags WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      key: row.key as string,
      value: row.value as string,
      setBy: row.set_by as string,
      setAt: row.set_at as string,
    };
  }

  getAllFlags(): SharedNarrativeFlag[] {
    const rows = this.db.query("SELECT * FROM shared_flags ORDER BY julianday(set_at) DESC, rowid DESC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      key: r.key as string,
      value: r.value as string,
      setBy: r.set_by as string,
      setAt: r.set_at as string,
    }));
  }

  // ── Counters ────────────────────────────────────────────────────────

  incrementCounter(key: string, agentId: string, delta = 1): number {
    this.db.run(
      "INSERT INTO shared_counters (key, value, set_by, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = value + ?, set_by = ?, updated_at = datetime('now')",
      [key, delta, agentId, delta, agentId],
    );
    const row = this.db.query("SELECT value FROM shared_counters WHERE key = ?").get(key) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  getAllCounters(): Record<string, { value: number; setBy: string }> {
    const rows = this.db.query("SELECT * FROM shared_counters ORDER BY updated_at DESC").all() as Record<string, unknown>[];
    const result: Record<string, { value: number; setBy: string }> = {};
    for (const r of rows) {
      result[r.key as string] = { value: r.value as number, setBy: r.set_by as string };
    }
    return result;
  }

  // ── Narrative Threads ───────────────────────────────────────────────

  recordThread(thread: {
    id: string;
    fromAgent: string;
    toAgent: string;
    label: string;
    value?: string;
    choiceIndex?: number;
    sessionId?: string;
  }): void {
    this.db.run(
      "INSERT OR REPLACE INTO narrative_threads (id, from_agent, to_agent, label, value, choice_index, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [thread.id, thread.fromAgent, thread.toAgent, thread.label, thread.value ?? null, thread.choiceIndex ?? null, thread.sessionId ?? null],
    );
  }

  getThreadsForAgent(agentId: string): SharedNarrativeThread[] {
    const rows = this.db.query(
      "SELECT * FROM narrative_threads WHERE from_agent = ? OR to_agent = ? ORDER BY timestamp DESC LIMIT 50",
    ).all(agentId, agentId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      fromAgent: r.from_agent as string,
      toAgent: r.to_agent as string,
      label: r.label as string,
      value: r.value as string,
      timestamp: r.timestamp as string,
    }));
  }

  getAllThreads(): SharedNarrativeThread[] {
    const rows = this.db.query("SELECT * FROM narrative_threads ORDER BY timestamp DESC LIMIT 100").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      fromAgent: r.from_agent as string,
      toAgent: r.to_agent as string,
      label: r.label as string,
      value: r.value as string,
      timestamp: r.timestamp as string,
    }));
  }

  /** Build bootstrap block for an agent's system prompt */
  buildBootstrap(agentId: string): string {
    const parts: string[] = [];

    // Shared flags
    const flags = this.getAllFlags().filter(f => !isAutomationMark(f.key)).slice(0, 40);
    if (flags.length > 0) {
      parts.push("## Shared Narrative State");
      parts.push("The colony has established these shared facts:");
      let remaining = 4000 - parts.join("\n").length;
      for (const f of flags) {
        if (remaining <= 1) break;
        const line = `- ${f.key}: ${f.value} (set by ${f.setBy})`;
        parts.push(line.slice(0, remaining - 1));
        remaining -= Math.min(line.length, remaining - 1) + 1;
      }
    }

    // Shared counters
    const counters = this.getAllCounters();
    const counterEntries = Object.entries(counters);
    if (counterEntries.length > 0) {
      if (parts.length === 0) parts.push("## Shared Narrative State");
      parts.push("Narrative counters:");
      for (const [key, data] of counterEntries) {
        parts.push(`- ${key}: ${data.value} (last touched by ${data.setBy})`);
      }
    }

    // Cross-agent threads mentioning this agent
    const threads = this.getThreadsForAgent(agentId);
    const incoming = threads.filter(t => t.toAgent === agentId && t.fromAgent !== agentId);
    if (incoming.length > 0) {
      if (parts.length === 0) parts.push("## Shared Narrative State");
      parts.push("Other agents have referenced you:");
      const latest = incoming.slice(0, 5);
      for (const t of latest) {
        parts.push(`- ${t.fromAgent}: "${t.label}"`);
      }
    }

    return parts.length > 0 ? parts.join("\n") : "";
  }
}

/** Singleton — one shared DB per filesystem, lazy init */
let _store: SharedNarrativeStore | null = null;

export function getSharedNarrativeStore(dbPath?: string): SharedNarrativeStore {
  if (!_store) {
    const path = dbPath || "rooms/_shared/memory.db";
    _store = new SharedNarrativeStore(path);
  }
  return _store;
}

/** Reset the singleton — for tests that need a fresh store on a new path. */
export function __resetSharedNarrativeStore(): void {
  _store = null;
}

function mapMeeting(r: Record<string, unknown>): Meeting {
  return {
    id: r.id as string,
    topic: r.topic as string,
    convener: r.convener as string,
    placeId: r.place_id as string,
    agenda: r.agenda as string,
    stakes: r.stakes as MeetingStakes,
    status: r.status as MeetingStatus,
    turns: r.turns as number,
    createdAt: r.created_at as number,
    closedAt: (r.closed_at as number | null) ?? null,
    visibility: (r.visibility as MeetingVisibility | null) ?? null,
    conversationId: (r.conversation_id as string | null) ?? null,
    readerIds: r.reader_ids ? JSON.parse(r.reader_ids as string) as string[] : null,
  };
}

function mapExpedition(r: Record<string, unknown>): Expedition {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    target: r.target as ExpeditionTarget,
    status: r.status as ExpeditionStatus,
    startedAt: (r.started_at as number | null) ?? null,
    endedAt: (r.ended_at as number | null) ?? null,
    discoveryRef: (r.discovery_ref as string | null) ?? null,
  };
}

function parseMeta(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function mapAutomationMark(row: Record<string, unknown>): AutomationMark {
  return { key: row.key as string, value: row.value as string, setBy: row.set_by as string,
    setAt: row.set_at as string, expiresAt: row.expires_at as number | null };
}
