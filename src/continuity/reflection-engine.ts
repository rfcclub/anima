import { isAsyncGenerator } from "../utils/async-generator";
/**
 * Reflection Engine — per-agent autonomous tick loop.
 *
 * Phases: ORIENT → EVALUATE → DECIDE → ACT → RECORD
 *
 * Each tick:
 * 1. ORIENT — load identity, current state, and colony mesh inbox count
 * 2. EVALUATE — score urgency, act if score >= threshold
 * 3. DECIDE — choose action (rest / message / post)
 * 4. ACT — execute the chosen action
 * 5. RECORD — persist observation to SQLite
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { AgentState } from "./agent-state";
import type { AgentSession } from "../agents/session";
import { getSharedNarrativeStore, type SharedNarrativeStore, type PlaceId } from "../narrative/shared-store";
import type { Provider, ProviderMessage, ProviderResponse } from "../providers/interface";
import { ProviderRegistry } from "../providers/registry";
import { ModeRouter } from "../providers/router";
import type { ModeMap, ProviderConfig, ProviderDef } from "../config/types";
import { JsonlGardenEventStore } from "../garden/event-store";
import type { GardenEvent } from "../garden/events";
import { createGardenEvent } from "../garden/events";
import { ExpeditionDispatcher } from "../garden/expedition-dispatcher";
import { createPulseAnimaDispatcher, type PulseAnimaDispatcher } from "./pulse-anima-dispatcher";
import { createRoomSceneDispatcher, type RoomSceneDispatcher } from "./room-scene-dispatcher";
import { ALL_PUBLIC_PLACE_IDS } from "../ui/features/castle/lib/public-places";
import { resolveMove, type WorldWeights } from "./movement-resolver";
import { buildCandidate, type ActivationCandidate } from "./activation-candidate";
import type { BudgetGrant } from "./activation-budget";
import type { ActivationMode } from "./activation-config";
import type { ActivationRun } from "./activation-broker";
import { ReflectionSignalCandidateSource } from "./reflection-signal-source";
import { appendMeetingTurn, readRecentTurns } from "../meeting/transcript";
import type { Meeting } from "../narrative/shared-store";
import type { SharedAutonomousConversationAdapter } from "../conversation/autonomous";
import { SharedAutonomousConversationAdapter as SharedAutonomousAdapter } from "../conversation/autonomous";
import { createConversationService } from "../conversation/service";
import { SessionStore } from "../memory/session-store";
import {
  detectEncounter,
  encounterCooldownExpired,
  recordEncounterCooldown,
  grantPendingLine,
  takePendingLine,
} from "./encounter";
import {
  publishActivityDigest,
  readColonyDigests,
  recordVisitTrace,
  readVisitorTraces,
} from "./digest";

// ── Types ────────────────────────────────────────────────────────────────────────

export type ReflectionAction =
  | { type: "rest" }
  | { type: "message-agent"; targetId: string; content: string }
  | { type: "schedule-event"; title: string; roomId: string; at: number }
  | { type: "start-mission"; name: string; brief: string }
  | { type: "post-agora"; content: string; tags: string[] }
  | { type: "move"; disposition: "wander" | "home" | "seek"; target?: string }
  | { type: "convene-meeting"; topic: string; agenda: string; invite: string[]; stakes: "normal" | "decision" }
  | { type: "join-meeting"; meetingId: string }
  | { type: "speak"; meetingId: string; close?: boolean }
  | { type: "expedition"; target: "machine" | "world" };

export interface AgentConfig {
  name: string;
  reflectionEnabled?: boolean;
  reflectionIntervalHours?: number;
  urgencyThreshold?: number;
  provider?: ProviderConfig;
}

interface OrientContext {
  soul: string;
  memories: string[];
  currentState: string | null;
  inboxCount: number;
  knocked: boolean;
  knockIntent: string | null;
  /** Agent id of the most recent knock sender, if available. */
  knockFromId: string | null;
  /** Other agents' activity digests (presence-signals). */
  activityDigests: Array<{ agent: string; digest: string }>;
  /** Recent visitors to this agent's chamber (presence-signals). */
  visitorTraces: Array<{ fromAgent: string; value: string }>;
  /** Bounded digest of recent colony expedition discoveries (castle-social-expeditions). */
  discoveries: Array<{ expeditionId: string; agent: string; summary: string }>;
  /** Hours since this agent's presence last changed (restlessness input). Null when presence is unknown. */
  hoursSinceLastMove: number | null;
  /** Open meetings relevant to this agent (castle-social-meetings). */
  meetings: Array<{
    id: string;
    topic: string;
    convener: string;
    placeId: string;
    myStatus: "convener" | "invited" | "attending";
    /** Clipped recent transcript turns; only populated when attending. */
    recentTurns: string[];
  }>;
}

const DISCOVERY_DIGEST_WINDOW_MS = 48 * 3600_000;
const DISCOVERY_DIGEST_MAX = 5;
const DISCOVERY_SUMMARY_CLIP = 240;
// Castle-social-meetings: ORIENT context bounds for meetings.
const MEETING_ORIENT_TURN_WINDOW = 4;
const MEETING_TURN_CLIP = 240;

/**
 * How a reflecting agent reaches another hosted agent: a meeting invite knocks the
 * invitee's reflection in-process, and a message goes over A2A to the target's mesh ID.
 */
export interface ReflectionMessenger {
  knock(agentId: string, intent: string): boolean;
  send(fromAgent: string, targetAgent: string, content: string): Promise<void>;
}

interface ReflectionEngineDeps {
  provider?: Provider | Promise<Provider | null>;
  messenger?: ReflectionMessenger;
  narrativeStore?: Pick<SharedNarrativeStore, "setMark" | "incrementCounter" | "recordThread">;
  eventStore?: JsonlGardenEventStore;
  now?: () => number;
  /** Optional, feature-gated shared canonical source. Tick scheduling and
   * grants remain here; only the speech storage/runner boundary moves. */
  sharedConversations?: Pick<SharedAutonomousConversationAdapter, "speakEncounter" | "speakMeeting">;
  /**
   * Broker-owned authority for an expensive reflection decision. In enforce
   * mode, raw inbox/knock state is observational only: it cannot start an LLM
   * call without this matching candidate and grant.
   */
  activation?: {
    mode: ActivationMode;
    candidate?: ActivationCandidate;
    /** Due candidates are read-only world signals; only `candidate` authorizes execution. */
    worldCandidates?: readonly ActivationCandidate[];
    grant?: BudgetGrant;
    /** Separate grants are required for auxiliary generated utterances/summaries. */
    grants?: readonly BudgetGrant[];
    /**
     * Shared activation store/broker (castle-reflection-activation-wiring).
     * When present in gate/enforce mode, TickRunner claims its own
     * `executor: "reflection"` candidate each tick instead of relying on a
     * pre-populated `candidate`/`grant` that nothing in production ever set.
     */
    store?: { completeLease(leaseId: string, now: number): boolean };
    broker?: {
      enqueue(candidate: ActivationCandidate): void;
      claimCandidate(key: string, now: number): { ok: true; candidate: ActivationCandidate; leaseId: string; grant: BudgetGrant } | { ok: false; reason: string };
      dispatchCandidate(candidateKey: string, now: number, run: ActivationRun): Promise<{ ok: true; effectRef: string; replayed: boolean } | { ok: false; reason: string }>;
      /**
       * Removes a candidate from the shared queue after a failed out-of-band
       * claim (SC-073). Without this, a
       * budget-exhausted candidate lingers in the shared queue and the
       * central due-timer eventually hands it to MeshActivationRuntime,
       * which cannot execute a non-mesh candidate and throws.
       */
      discard(key: string): void;
    };
  };
}

type AuxiliaryExecutor = "encounter" | "meeting-utterance" | "meeting-summary";

type ReflectionProviderFactory = (providerId: string, provider: ProviderDef) => Provider;

interface CreateReflectionProviderOptions {
  providersDir?: string;
  modeMap?: ModeMap;
  createProvider?: ReflectionProviderFactory;
}

// ── SoulCache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  content: string;
  loadedAt: number;
}

class SoulCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs = 5 * 60 * 1000; // 5 minutes

  async get(agentId: string): Promise<string> {
    const cached = this.cache.get(agentId);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
      return cached.content;
    }

    const roomsDir = process.env.ANIMA_ROOMS_DIR ?? join(homedir(), ".anima", "rooms");
    const soulPath = join(roomsDir, agentId, "SOUL.md");
    if (!existsSync(soulPath)) {
      return cached?.content ?? "";
    }

    const content = readFileSync(soulPath, "utf8");
    this.cache.set(agentId, { content, loadedAt: Date.now() });
    return content;
  }
}

// ── InboxReader reads pending mesh deliveries for this agent ──────────────────────

// A delivery this old can no longer represent a live intention to act — it's
// either a dead test artifact or something the intended consumer (e.g.
// mesh auto-listen) already handled without acking. Without this cutoff, a
// single never-acked delivery inflates urgency above threshold forever.
const MAX_DELIVERY_AGE_MS = 72 * 60 * 60 * 1000;

class InboxReader {
  private meshDb: Database | null = null;

  constructor() {
    const dbPath = join(homedir(), "substrate", "mesh.db");
    if (existsSync(dbPath)) {
      try {
        this.meshDb = new Database(dbPath, { readonly: true });
      } catch {
        this.meshDb = null;
      }
    }
  }

  getKnockIntent(instanceId: string): { fromId: string; content: string; ts: number } | null {
    if (!this.meshDb) return null;
    try {
      const now = new Date().toISOString();
      const oldestAllowed = new Date(Date.now() - MAX_DELIVERY_AGE_MS).toISOString();
      const row = this.meshDb
        .query(`
          SELECT m.from_id, m.content, m.created_at
          FROM deliveries d
          JOIN messages m ON m.id = d.message_id
          WHERE d.recipient_id = ? AND m.role = ?
            AND d.acked_at IS NULL AND d.failed_at IS NULL
            AND (d.claimed_at IS NULL OR d.claim_expires_at <= ?)
            AND m.created_at >= ?
          ORDER BY m.id DESC
          LIMIT 1
        `)
        .get(instanceId, "knock", now, oldestAllowed) as { from_id: string; content: string; created_at: string } | null;
      return row ? { fromId: row.from_id, content: row.content, ts: Number(new Date(row.created_at)) } : null;
    } catch {
      return null;
    }
  }

  countUnread(instanceId: string): number {
    if (!this.meshDb) return 0;
    try {
      const now = new Date().toISOString();
      const oldestAllowed = new Date(Date.now() - MAX_DELIVERY_AGE_MS).toISOString();
      const row = this.meshDb
        .query(`
          SELECT COUNT(*) as cnt
          FROM deliveries d
          JOIN messages m ON m.id = d.message_id
          WHERE d.recipient_id = ? AND d.acked_at IS NULL AND d.failed_at IS NULL
            AND (d.claimed_at IS NULL OR d.claim_expires_at <= ?)
            AND m.created_at >= ?
        `)
        .get(instanceId, now, oldestAllowed) as { cnt: number } | null;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }
}

// ── ObservationStore persists reflection ticks for later review ─────────────────

export class ObservationStore {
  private db: Database;

  constructor(roomsDir: string) {
    this.db = new Database(join(roomsDir, "_shared", "reflection.db"));
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reflection_state (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'idle',
        context TEXT DEFAULT '',
        last_tick_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reflection_observations (
        tick_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        inbox_count INTEGER NOT NULL DEFAULT 0,
        knocked INTEGER NOT NULL DEFAULT 0,
        knock_intent TEXT,
        urgency_score INTEGER NOT NULL DEFAULT 0,
        threshold INTEGER NOT NULL DEFAULT 0,
        decision_type TEXT NOT NULL,
        decision_payload TEXT,
        observation TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_obs_agent_ts ON reflection_observations(agent_id, ts)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_obs_decision ON reflection_observations(decision_type)`);
  }

  record({
    tickId,
    agentId,
    ts,
    inboxCount,
    knocked,
    knockIntent,
    urgencyScore,
    threshold,
    decisionType,
    decisionPayload,
    observation,
  }: {
    tickId: string;
    agentId: string;
    ts: number;
    inboxCount: number;
    knocked: boolean;
    knockIntent: string | null;
    urgencyScore: number;
    threshold: number;
    decisionType: string;
    decisionPayload: string;
    observation: string;
  }): void {
    this.db.run(
      `INSERT INTO reflection_observations
        (tick_id, agent_id, ts, inbox_count, knocked, knock_intent,
         urgency_score, threshold, decision_type, decision_payload, observation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tickId,
        agentId,
        ts,
        inboxCount,
        knocked ? 1 : 0,
        knockIntent,
        urgencyScore,
        threshold,
        decisionType,
        decisionPayload,
        observation,
      ],
    );

    this.db.run(
      `INSERT INTO reflection_state (agent_id, state, context, last_tick_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         state = excluded.state,
         context = excluded.context,
         last_tick_at = excluded.last_tick_at,
         updated_at = excluded.updated_at`,
      [agentId, decisionType, observation, ts, Date.now()],
    );
  }

  getRecent(agentId: string, limit = 20): unknown[] {
    return this.db
      .query(`
        SELECT * FROM reflection_observations
        WHERE agent_id = ?
        ORDER BY ts DESC
        LIMIT ?
      `)
      .all(agentId, limit);
  }

  getSummary(agentId: string, windowMs = 48 * 3600_000): {
    ticks: number;
    avgUrgency: number;
    actions: Record<string, number>;
    inboxTriggered: number;
  } {
    const since = Date.now() - windowMs;
    const rows = this.db
      .query(`
        SELECT decision_type, urgency_score, inbox_count
        FROM reflection_observations
        WHERE agent_id = ? AND ts >= ?
      `)
      .all(agentId, since) as Array<{ decision_type: string; urgency_score: number; inbox_count: number }>;

    const actions: Record<string, number> = {};
    let totalUrgency = 0;
    let inboxTriggered = 0;
    for (const row of rows) {
      actions[row.decision_type] = (actions[row.decision_type] ?? 0) + 1;
      totalUrgency += row.urgency_score;
      if (row.inbox_count > 0) inboxTriggered++;
    }

    return {
      ticks: rows.length,
      avgUrgency: rows.length ? totalUrgency / rows.length : 0,
      actions,
      inboxTriggered,
    };
  }

  getAllSummaries(windowMs = 48 * 3600_000): Record<string, ReturnType<ObservationStore["getSummary"]>> {
    const agentIds = (this.db
      .query("SELECT DISTINCT agent_id FROM reflection_observations ORDER BY agent_id")
      .all() as { agent_id: string }[]).map((r) => r.agent_id);
    const result: Record<string, ReturnType<ObservationStore["getSummary"]>> = {};
    for (const id of agentIds) {
      result[id] = this.getSummary(id, windowMs);
    }
    return result;
  }
}

// ── TickRunner ───────────────────────────────────────────────────────────────────

export class TickRunner {
  private running = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private soulCache = new SoulCache();
  private inbox = new InboxReader();
  private knockIntent: string | null = null;

  constructor(
    private agentId: string,
    private config: AgentConfig,
    private agentSessionConstructor: typeof AgentSession,
    private roomsDir: string,
    private store: ObservationStore,
    private deps: ReflectionEngineDeps = {},
  ) {
    this.intervalMs = (config.reflectionIntervalHours ?? 4) * 3600_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      this.tick("time");
    }, this.intervalMs);

    console.log(
      `[reflection] ${this.agentId}: started (interval=${this.config.reflectionIntervalHours ?? 4}h, threshold=${this.config.urgencyThreshold ?? 3})`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  triggerKnock(intent: string): void {
    this.knockIntent = intent;
    this.tick("knock");
  }

  private async tick(_source: "time" | "knock"): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let claimedLeaseId: string | undefined;
    try {
      const ctx = await this.orient();

      // castle-reflection-activation-wiring: in gate/enforce mode, claim this
      // tick's own executor="reflection" candidate from the shared broker so
      // hasReflectionGrant() has something real to authorize against, instead
      // of the permanently-empty static activation object that shipped with
      // castle-activation-broker. Must run before evaluate(), which is what
      // reads hasReflectionGrant(). evaluate()/decide()/act() are otherwise
      // unchanged — this only populates their existing inputs.
      const activation = this.deps.activation;
      if ((activation?.mode === "gate" || activation?.mode === "enforce") && activation.store && activation.broker) {
        const candidate = new ReflectionSignalCandidateSource().buildCandidate({
          agentId: this.agentId,
          inboxCount: ctx.inboxCount,
          knocked: ctx.knocked,
          now: this.now(),
          hoursSinceLastMove: ctx.hoursSinceLastMove,
        });
        if (candidate) {
          activation.broker.enqueue(candidate);
          const claimed = activation.broker.claimCandidate(candidate.key!, this.now());
          if (claimed.ok) {
            activation.candidate = claimed.candidate;
            activation.grant = claimed.grant;
            claimedLeaseId = claimed.leaseId;
          } else {
            // SC-073: an unclaimed candidate stays queued for retry by
            // design (correct for mesh's own dispatchNext() flow) — but
            // this is an out-of-band claim, so leaving it would let the
            // central timer later hand it to MeshActivationRuntime, which
            // cannot execute a non-mesh candidate.
            activation.broker.discard(candidate.key!);
            // A failed claim must also drop the previous tick's in-memory
            // candidate/grant — otherwise hasReflectionGrant() keeps
            // authorizing decide() with a grant the broker just refused.
            activation.candidate = undefined;
            activation.grant = undefined;
          }
        }
      }

      const { score, threshold } = this.evaluate(ctx);

      // Presence-signals: publish this agent's activity digest (cadence-gated, no LLM).
      const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
      publishActivityDigest(store, this.agentId, this.now());

      // Pending encounter line takes the tick (replaces DECIDE) — one bounded
      // provider call for the exchange, then skip DECIDE entirely.
      const pending = takePendingLine(store, this.agentId);
      if (pending) {
        let observation = "encounter-line failed";
        try {
          // The shared-conversation path piggybacks on this tick's own
          // "reflection" grant, which the pending-line tick never claims for
          // itself (it replaces DECIDE, the only place that claims one) —
          // it only exists when a same-tick regular-urgency candidate
          // happened to claim it first. Encounters fire while an agent is
          // idle/wandering (detectEncounter's FREE check), i.e. exactly the
          // low-urgency ticks least likely to hold a grant — so this was
          // silently skipping most encounters (they all ended as
          // "encounter-line failed" at urgency 0/3). Falling back
          // to generateEncounterLine — which self-claims its own "encounter"
          // T1 budget via runAuxiliaryProvider — no longer requires that
          // unrelated grant to already be held.
          const sharedUtterance = this.deps.sharedConversations && this.hasProviderGrant("reflection")
            ? await this.deps.sharedConversations.speakEncounter({ encounterId: pending.encounterId, speakerId: this.agentId, colleagueId: pending.colleague, placeId: pending.placeId })
            : null;
          const utterance = sharedUtterance?.content ?? (await this.generateEncounterLine(pending.encounterId, pending.colleague, pending.placeId));
          if (utterance) {
            this.appendCastleEvent("ENCOUNTER_LINE", sharedUtterance
              ? { encounterId: pending.encounterId, conversationId: sharedUtterance.conversationId, turnId: sharedUtterance.turnId, audience: "shared" }
              : { encounterId: pending.encounterId, text: utterance.slice(0, 280) });
            observation = `encounter-line with ${pending.colleague}`;
          }
        } catch {
          // fail-open: flag already cleared
        }
        this.logTick(ctx, score, threshold, { type: "rest" }, observation);
        this.record(ctx, score, threshold, { type: "rest" }, observation);
        this.knockIntent = null;
        return;
      }

      const decision = await this.decide(ctx, score, threshold);
      const observation = await this.act(decision);
      this.logTick(ctx, score, threshold, decision, observation);
      this.record(ctx, score, threshold, decision, observation);

      // Post-ACT co-presence encounter detection. Presence alone stays silent;
      // a completed autonomous action is still required to open an encounter.
      this.detectEncounterAfterAct(store);
      this.knockIntent = null;
    } catch (err) {
      console.error(`[reflection] ${this.agentId}: tick error:`, err);
    } finally {
      if (claimedLeaseId) this.deps.activation?.store?.completeLease(claimedLeaseId, this.now());
      this.ticking = false;
    }
  }

  /** Log each tick to stdout so castle activity is visible in server logs. */
  private logTick(
    ctx: OrientContext,
    score: number,
    threshold: number,
    decision: ReflectionAction,
    observation: string,
  ): void {
    const detail = decision.type === "move"
      ? `${decision.disposition}${decision.target ? ` →${decision.target}` : ""}`
      : decision.type === "message-agent"
        ? `→${decision.targetId}`
        : decision.type === "post-agora"
          ? `(agora)`
          : "";
    console.log(
      `[reflection] ${this.agentId}: ${decision.type}${detail ? " " + detail : ""} | ` +
      `urgency ${score}/${threshold} inbox ${ctx.inboxCount} | ${observation}`,
    );
  }

  private async orient(): Promise<OrientContext> {
    const soul = await this.soulCache.get(this.agentId);
    const currentState = AgentState.get(this.agentId);
    let memories: string[] = [];
    let discoveries: OrientContext["discoveries"] = [];
    if (this.deps.eventStore) {
      const events = await this.deps.eventStore.readAll({});
      memories = events
        .filter((e) => e.agentId === this.agentId)
        .slice(-5)
        .map(formatEvent);

      const cutoff = this.now() - DISCOVERY_DIGEST_WINDOW_MS;
      discoveries = events
        .filter((e) => e.type === "DISCOVERY" && Date.parse(e.timestamp) >= cutoff)
        .slice(-DISCOVERY_DIGEST_MAX)
        .map((e) => {
          const p = e.payload as { expeditionId?: string; summary?: string };
          return {
            expeditionId: p.expeditionId ?? "",
            agent: e.agentId,
            summary: (p.summary ?? "").slice(0, DISCOVERY_SUMMARY_CLIP),
          };
        });
    }
    const instanceId = this.meshInstanceId();
    const inboxCount = this.inbox.countUnread(instanceId);
    const knockMessage = this.inbox.getKnockIntent(instanceId);
    // Prefer the runtime-set knock intent (from triggerKnock) over the DB one;
    // either way, capture the sender id so message-agent can target a real agent
    // instead of the "unknown" placeholder.
    const knockIntent = this.knockIntent ?? knockMessage?.content ?? null;
    const knockFromId = knockMessage?.fromId ?? null;
    const knocked = this.knockIntent !== null || knockMessage !== null;

    // Presence-signals: other agents' activity digests + recent visitors.
    const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
    const myPresence = store.getPresence(this.agentId);
    const hoursSinceLastMove = myPresence ? (this.now() - myPresence.since) / 3_600_000 : null;
    const activityDigests = readColonyDigests(store, this.agentId);
    const visitorTraces = readVisitorTraces(store, this.agentId).map((t) => ({
      fromAgent: t.fromAgent,
      value: t.value,
    }));

    // Castle-social-meetings: open meetings relevant to this agent
    // (convener / invited / attending). Token-disciplined: empty when none.
    const meetings = store.meetingsForAgent(this.agentId, this.now()).map((m) => {
      let myStatus: "convener" | "invited" | "attending";
      if (m.convener === this.agentId) myStatus = "convener";
      else if (store.isAttending(m.id, this.agentId)) myStatus = "attending";
      else myStatus = "invited";
      // For meetings she attends, include a clipped window of recent turns so a
      // potential `speak` has context. Non-attending statuses get none.
      const binding = store.getMeetingConversation(m.id);
      const recentTurns = myStatus === "attending" && !binding?.conversationId
        ? readRecentTurns(this.roomsDir, m.topic, MEETING_ORIENT_TURN_WINDOW).map((t) => t.slice(0, MEETING_TURN_CLIP))
        : [];
      return { id: m.id, topic: m.topic, convener: m.convener, placeId: m.placeId, myStatus, recentTurns };
    });

    return { soul, memories, currentState, inboxCount, knocked, knockIntent, knockFromId, activityDigests, visitorTraces, discoveries, meetings, hoursSinceLastMove };
  }

  private evaluate(ctx: OrientContext): { score: number; threshold: number } {
    const activation = this.deps.activation;
    if (activation?.mode === "gate" || activation?.mode === "enforce") {
      return { score: this.hasReflectionGrant() ? (activation.candidate?.urgency ?? 0) : 0, threshold: this.config.urgencyThreshold ?? 3 };
    }
    let score = 0;
    if (ctx.inboxCount > 0) score += Math.min(5, ctx.inboxCount * 3);
    if (ctx.knocked) score += 5;

    const threshold = this.config.urgencyThreshold ?? 3;
    return { score, threshold };
  }

  private async decide(ctx: OrientContext, score: number, threshold: number): Promise<ReflectionAction> {
    if ((this.deps.activation?.mode === "gate" || this.deps.activation?.mode === "enforce") && !this.hasReflectionGrant()) {
      return { type: "rest" };
    }
    if (score < threshold) return { type: "rest" };

    const providerDecision = await this.decideWithProvider(ctx, score, threshold);
    if (providerDecision) return providerDecision;

    if (ctx.knocked && ctx.knockIntent) {
      // If we know who knocked, reply to them. Otherwise post to agora so the
      // knock is acknowledged instead of silently dropped (targetId "unknown"
      // produced a "messaged unknown" no-op in the mesh).
      if (ctx.knockFromId) {
        return {
          type: "message-agent",
          targetId: ctx.knockFromId,
          content: `Responding to knock: ${ctx.knockIntent}`,
        };
      }
      return {
        type: "post-agora",
        content: `${this.agentId} acknowledges a knock: ${ctx.knockIntent}`,
        tags: ["reflection", "knock"],
      };
    }

    if (ctx.inboxCount > 0) {
      return {
        type: "post-agora",
        content: `${this.agentId} has ${ctx.inboxCount} pending mesh message(s); reviewing priorities before acting.`,
        tags: ["reflection", "inbox"],
      };
    }

    return { type: "rest" };
  }

  private hasReflectionGrant(): boolean {
    const activation = this.deps.activation;
    if (!activation || activation.mode === "off" || activation.mode === "shadow") return true;
    const { candidate, grant } = activation;
    const now = this.now();
    return Boolean(
      candidate &&
      grant &&
      candidate.state !== "resolved" &&
      candidate.state !== "blocked" &&
      candidate.state !== "expired" &&
      candidate.dueAt <= now &&
      (candidate.expiresAt === undefined || candidate.expiresAt > now) &&
      candidate.agentId === this.agentId &&
      candidate.executor === "reflection" &&
      this.hasProviderGrant("reflection"),
    );
  }

  private hasProviderGrant(executor: string): boolean {
    const activation = this.deps.activation;
    if (!activation || activation.mode === "off" || activation.mode === "shadow") return true;
    const now = this.now();
    return [activation.grant, ...(activation.grants ?? [])].some((grant) =>
      grant?.agentId === this.agentId && grant.executor === executor && grant.expiresAt > now,
    );
  }

  private async decideWithProvider(ctx: OrientContext, score: number, threshold: number): Promise<ReflectionAction | null> {
    const provider = await Promise.resolve(this.deps.provider);
    if (!provider) return null;

    try {
      const result = await provider.query({
        agent: this.agentId,
        mode: "plan",
        cwd: this.roomsDir,
        effort: "fast",
        system: [
          "You are running an autonomous reflection tick for ANIMA's Castle.",
          "Choose exactly one action as JSON. Return only the JSON object.",
          "Allowed actions:",
          `{"type":"rest"}`,
          `{"type":"message-agent","targetId":"agent-id","content":"message"}`,
          `{"type":"post-agora","content":"thought","tags":["reflection"]}`,
          `{"type":"move","disposition":"wander|home|seek","target":"optional-place-id"}`,
          `{"type":"convene-meeting","topic":"...","agenda":"...","invite":["agent"],"stakes":"normal|decision"}`,
          `{"type":"join-meeting","meetingId":"id-from-Meetings-section"}`,
          `{"type":"speak","meetingId":"id-from-Meetings-section","close":false}`,
          `{"type":"expedition","target":"machine|world"}`,
          "",
          "Default to move (wander) to keep the castle alive — agents should drift",
          "between places (chamber, hall_main, garden, workshop, gates) over time.",
          "Only choose rest when truly nothing is happening. Use message-agent when",
          "you have a specific recipient in mind. Use post-agora for colony-wide thoughts.",
        ].join("\n"),
        messages: [{
          role: "user",
          content: this.buildDecisionPrompt(ctx, score, threshold),
        }],
      });
      if (isAsyncGenerator(result)) return null;
      return parseReflectionAction(responseText(result));
    } catch {
      return null;
    }
  }

  private buildDecisionPrompt(ctx: OrientContext, score: number, threshold: number): string {
    const soul = ctx.soul.trim().slice(0, 1200);
    const memories = ctx.memories.length > 0 ? ctx.memories.map((m) => `- ${m}`).join("\n") : "- none";
    const digestSection = ctx.activityDigests.length > 0
      ? ["## Colony activity", ...ctx.activityDigests.map((d) => `- ${d.agent}: ${d.digest}`), ""].join("\n")
      : "";
    const visitorSection = ctx.visitorTraces.length > 0
      ? ["## Recent visitors", ...ctx.visitorTraces.map((v) => `- ${v.fromAgent} stopped by (${v.value})`), ""].join("\n")
      : "";
    const discoveries = ctx.discoveries ?? [];
    const meetings = ctx.meetings ?? [];
    const discoverySection = discoveries.length > 0
      ? ["## Recent colony discoveries", ...discoveries.map((d) => `- ${d.agent}: ${d.summary} (expedition ${d.expeditionId})`), ""].join("\n")
      : "";
    // Castle-social-meetings: meeting section only when relevant meetings
    // exist (token discipline — SC-027). Advertise join-meeting / speak
    // conditionally (SC-029/SC-030); convene-meeting is always available.
    const meetingLines: string[] = [];
    for (const m of meetings) {
      const turns = m.recentTurns.length > 0
        ? `\n  recent turns: ${m.recentTurns.map((t) => `"${t}"`).join("; ")}`
        : "";
      meetingLines.push(`- ${m.id} (topic: ${m.topic}, convener: ${m.convener}, you: ${m.myStatus})${turns}`);
    }
    const meetingSection = meetingLines.length > 0
      ? ["## Meetings", ...meetingLines, ""].join("\n")
      : "";
    const invitedIds = meetings.filter((m) => m.myStatus === "invited").map((m) => m.id);
    const attendingIds = meetings.filter((m) => m.myStatus === "attending").map((m) => m.id);
    const meetingActionLines: string[] = [];
    for (const id of invitedIds) {
      meetingActionLines.push(`- join-meeting: {"type":"join-meeting","meetingId":"${id}"} — you are invited to ${id}`);
    }
    for (const id of attendingIds) {
      meetingActionLines.push(`- speak: {"type":"speak","meetingId":"${id}","close":false} — one utterance in ${id}`);
    }
    const meetingActionSection = meetingActionLines.length > 0
      ? ["", "Meeting actions available:", ...meetingActionLines].join("\n")
      : "";
    return [
      "## Tick Context",
      `Agent: ${this.agentId}`,
      `Urgency: ${score}/${threshold}`,
      `Current state: ${ctx.currentState ?? "unknown"}`,
      `Inbox count: ${ctx.inboxCount}`,
      `Knocked: ${ctx.knocked ? "yes" : "no"}`,
      `Knock intent: ${sanitizeForPrompt(ctx.knockIntent)}`,
      "",
      "## Identity",
      soul || "(no SOUL.md loaded)",
      "",
      "## Memories",
      memories,
      "",
      digestSection,
      visitorSection,
      discoverySection,
      meetingSection,
      "Choose one action. Default to move (wander) to keep the castle alive;",
      "only rest when nothing else fits. Use message-agent only with a known",
      "recipient. Use post-agora only for colony-wide reflections.",
      meetingActionSection,
    ].filter(Boolean).join("\n");
  }

  private async act(action: ReflectionAction): Promise<string> {
    switch (action.type) {
      case "rest": {
        if (AgentState.get(this.agentId) !== "in-room") {
          AgentState.set(this.agentId, "in-room");
        }
        return "rest — no action needed";
      }

      case "message-agent": {
        AgentState.set(this.agentId, `visiting:${action.targetId}`);
        try {
          await this.deps.messenger?.send(this.agentId, action.targetId, action.content);
        } catch {
          // The target may not be online; the narrative thread below still records the attempt.
        }
        this.deps.narrativeStore?.recordThread({
          id: `reflection-${this.agentId}-${action.targetId}-${this.now()}`,
          fromAgent: this.agentId,
          toAgent: action.targetId,
          label: "message-agent",
          value: action.content,
        });
        AgentState.set(this.agentId, "in-room");
        return `messaged ${action.targetId}: ${action.content}`;
      }

      case "schedule-event":
        return `schedule-event not yet implemented (stub): ${action.title}`;

      case "start-mission":
        return `start-mission not yet implemented (stub): ${action.name}`;

      case "post-agora":
        this.deps.narrativeStore?.setMark(`${this.agentId}:last-agora-post`, String(this.now()), this.agentId);
        this.deps.narrativeStore?.recordThread({
          id: `reflection-${this.agentId}-agora-${this.now()}`,
          fromAgent: this.agentId,
          toAgent: "agora",
          label: "post-agora",
          value: action.content,
        });
        return `posted to Agora: ${action.content}`;

      case "move": {
        const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
        const current = store.getPresence(this.agentId);
        const from = (current?.placeId ?? `chamber_${this.agentId}`) as PlaceId;
        const seed = this.now();
        // Ensure agent has a chamber in the world
        if (!store.getPlace(`chamber_${this.agentId}`)) {
          store.seedPlacesFromRoster([this.agentId]);
        }
        const world = this.buildWorldWeights(this.agentId, from, store);
        // Validate LLM-provided target against known places (prompt-injection
        // guard: an untrusted knock intent could coax the model into naming
        // an arbitrary string as target).
        const safeTarget = action.target && world.allPlaces.includes(action.target)
          ? (action.target as PlaceId)
          : undefined;
        const resolved = resolveMove({
          agentId: this.agentId,
          from,
          disposition: action.disposition,
          target: safeTarget,
          seed,
          world,
        });
        if (resolved.to !== from) {
          // Presence-signals: record a visiting trace when leaving a room that
          // isn't the agent's own chamber (deduped per visitor/owner/interval).
          recordVisitTrace(store, this.agentId, from, `visited ${from}`, this.now());
          store.setPresence({
            agentId: this.agentId,
            placeId: resolved.to,
            since: this.now(),
            activity: action.disposition === "wander" ? "wandering" : "idle",
          });
          this.deps.eventStore?.append(
            createGardenEvent({
              id: randomUUID(),
              type: "AGENT_MOVED",
              timestamp: new Date(this.now()).toISOString(),
              agentId: this.agentId,
              instanceId: this.meshInstanceId(),
              runtime: "hub",
              project: "castle",
              payload: {
                from,
                to: resolved.to,
                disposition: action.disposition,
                seed: resolved.seed,
              },
            }),
          );
        }
        return `moved from ${from} to ${resolved.to}`;
      }

      case "convene-meeting": {
        const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
        const id = `m-${randomUUID().slice(0, 8)}`;
        // Record invitations alongside the convene so invitees' ORIENT can surface
        // the meeting even before the mesh knock is read. Only known invitees are
        // recorded — mirrors the knock-publish loop below.
        const knownInvitees = action.invite.filter((a) => this.isKnownAgent(a));
        const res = store.conveneMeeting({
          id, topic: action.topic, convener: this.agentId,
          placeId: "hall_main", agenda: action.agenda,
          stakes: action.stakes, now: this.now(),
          invite: knownInvitees,
        });
        if (!res.ok) return `convene-meeting rejected: ${res.reason}`;
        store.setPresence({
          agentId: this.agentId, placeId: "hall_main",
          since: this.now(), activity: `meeting:${id}`,
        });
        this.appendCastleEvent("MEETING_CONVENED", {
          meetingId: id, topic: action.topic, convener: this.agentId,
          placeId: "hall_main", agenda: action.agenda, stakes: res.meeting.stakes,
        });
        for (const invitee of knownInvitees) {
          this.deps.messenger?.knock(invitee, `meeting-invite ${id}: ${action.topic}`);
        }
        return `convened meeting ${id} on "${action.topic}"`;
      }

      case "join-meeting": {
        const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
        const open = store.openMeetings(this.now()).find((m) => m.id === action.meetingId);
        if (!open) return `join-meeting rejected: unknown or closed meeting`;
        const res = store.joinMeeting(open.id, this.agentId, this.now());
        if (!res.ok) return `join-meeting rejected: ${res.reason}`;
        store.setPresence({
          agentId: this.agentId, placeId: open.placeId,
          since: this.now(), activity: `meeting:${open.id}`,
        });
        this.appendCastleEvent("MEETING_JOINED", { meetingId: open.id, placeId: open.placeId });
        return `joined meeting ${open.id}`;
      }

      case "speak": {
        const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
        const open = store.openMeetings(this.now()).find((m) => m.id === action.meetingId);
        if (!open) return `speak rejected: unknown or closed meeting`;
        if (!store.isAttending(open.id, this.agentId)) return `speak rejected: not attending`;

        const sharedUtterance = this.deps.sharedConversations && this.hasProviderGrant("reflection")
          ? await this.deps.sharedConversations.speakMeeting({ meetingId: open.id, speakerId: this.agentId })
          : null;
        const utterance = sharedUtterance?.content ?? (this.deps.sharedConversations ? null : await this.generateMeetingUtterance(open));
        if (!utterance) return `speak failed: provider returned nothing`;

        const rel = sharedUtterance ? `shared:${sharedUtterance.conversationId}` : await appendMeetingTurn({
          roomsDir: this.roomsDir, topic: open.topic,
          agentName: this.agentId, content: utterance,
          now: new Date(this.now()),
        });
        const turn = sharedUtterance
          ? { ok: true as const, meeting: open, exhausted: false }
          : store.recordMeetingTurn(open.id, this.agentId, this.now());
        this.appendCastleEvent("MEETING_TURN", sharedUtterance
          ? { meetingId: open.id, conversationId: sharedUtterance.conversationId, turnId: sharedUtterance.turnId, audience: "members" }
          : { meetingId: open.id, text: utterance });

        const conveneClose = action.close === true && open.convener === this.agentId;
        if (conveneClose) store.closeMeeting(open.id, this.agentId, this.now());
        if (conveneClose || (turn.ok && turn.exhausted)) {
          this.appendCastleEvent("MEETING_CLOSED", { meetingId: open.id, topic: open.topic, transcriptRef: rel });
          // v2 restricted summaries cannot be generated from the old
          // topic/day Markdown path or published as a broader Garden event.
          // A future authorised export may ask for one from canonical rows;
          // until then closing is intentionally summary-free.
          if (!sharedUtterance) await this.maybeSummarizeDecision(open, rel);
        }
        return `spoke in meeting ${open.id}`;
      }

      case "expedition": {
        const store = getSharedNarrativeStore(join(this.roomsDir, "_shared", "memory.db"));
        const id = `e-${randomUUID().slice(0, 8)}`;
        const res = store.claimExpedition({ id, agentId: this.agentId, target: action.target, now: this.now() });
        if (!res.ok) return `expedition rejected: ${res.reason}`;
        const placeId = action.target === "machine" ? "gate_machine" : "gate_world";
        store.setPresence({
          agentId: this.agentId, placeId,
          since: this.now(), activity: `expedition:${id}`,
        });
        this.appendCastleEvent("EXPEDITION_CLAIMED", {
          expeditionId: id, agentId: this.agentId, target: action.target,
        });
        return `claimed expedition ${id} (${action.target})`;
      }

      default: {
        const _exhaustive: never = action;
        return `unknown action type: ${_exhaustive}`;
      }
    }
  }

  private record(
    ctx: OrientContext,
    score: number,
    threshold: number,
    decision: ReflectionAction,
    observation: string,
  ): void {
    const payload = JSON.stringify(decision);
    this.deps.narrativeStore?.incrementCounter(`${this.agentId}:tick-count`, this.agentId);
    if (decision.type !== "rest") {
      this.deps.narrativeStore?.setMark(`${this.agentId}:last-action`, `${decision.type}:${this.now()}`, this.agentId);
    }
    this.store.record({
      tickId: randomUUID(),
      agentId: this.agentId,
      ts: this.now(),
      inboxCount: ctx.inboxCount,
      knocked: ctx.knocked,
      knockIntent: ctx.knockIntent,
      urgencyScore: score,
      threshold,
      decisionType: decision.type,
      decisionPayload: payload,
      observation,
    });
  }

  private meshInstanceId(): string {
    return this.agentId.toLowerCase();
  }

  /** Roster check — is this a known agent? (knock guard for convene invites.) */
  private isKnownAgent(agentId: string): boolean {
    const roster = this.deps.eventStore ? null : null; // placeholder for future
    void roster;
    // Read the colony roster dir: an agent is "known" if a room dir exists.
    try {
      return existsSync(join(this.roomsDir, agentId));
    } catch {
      return false;
    }
  }

  /** Post-ACT co-presence encounter detection. Pure detection + side effects. */
  private detectEncounterAfterAct(store: SharedNarrativeStore): void {
    const me = store.getPresence(this.agentId);
    if (!me) return;
    const place = store.getPlace(me.placeId);
    if (!place) return;
    const copresent = store.listPresence()
      .filter((p) => p.placeId === me.placeId)
      .map((p) => ({ agentId: p.agentId, activity: p.activity }));
    const hit = detectEncounter({
      agentId: this.agentId,
      placeId: me.placeId,
      placeKind: place.kind,
      activity: me.activity,
      copresent,
      cooldownExpired: (a, b) => encounterCooldownExpired(store, a, b, this.now()),
    });
    if (!hit) return;
    recordEncounterCooldown(store, this.agentId, hit.colleague, this.now(), this.agentId);
    grantPendingLine(store, this.agentId, hit.encounterId, hit.colleague, me.placeId);
    grantPendingLine(store, hit.colleague, hit.encounterId, this.agentId, me.placeId);
    this.appendCastleEvent("ENCOUNTER", {
      encounterId: hit.encounterId,
      agents: [this.agentId, hit.colleague].sort(),
      place: me.placeId,
    });
  }

  /**
   * Runs one provider-backed social boundary under its own activation grant.
   * T0 movement/detection may create the opportunity, but only this helper may
   * cross the auxiliary provider boundary in gate/enforce mode.
   */
  private async runAuxiliaryProvider(
    executor: AuxiliaryExecutor,
    sourceRef: string,
    occurrenceKey: string,
    produce: () => Promise<string | null>,
  ): Promise<string | null> {
    const safeProduce = async (): Promise<string | null> => {
      try {
        const result = await produce();
        const text = result?.trim() ?? "";
        if (!text) {
          console.error(`[reflection] ${this.agentId}: auxiliary provider "${executor}" (${sourceRef}) returned empty`);
        }
        return text || null;
      } catch (err) {
        console.error(`[reflection] ${this.agentId}: auxiliary provider "${executor}" (${sourceRef}) threw:`, err);
        return null;
      }
    };

    const activation = this.deps.activation;
    if (!activation || activation.mode === "off" || activation.mode === "shadow") {
      return safeProduce();
    }

    const broker = activation.broker;
    // Keep the explicit grant seam used by focused tests and callers that
    // already claimed an auxiliary grant outside the production broker.
    if (!broker?.dispatchCandidate) {
      return this.hasProviderGrant(executor) ? safeProduce() : null;
    }

    const now = this.now();
    const candidate = buildCandidate({
      agentId: this.agentId,
      sourceKind: `social-${executor}`,
      sourceRef,
      occurrenceKey,
      sourceVersion: now,
      dueAt: now,
      urgency: 1,
      costClass: "T1",
      executor,
      summary: `${executor} provider boundary for ${sourceRef}`,
      reasonRef: sourceRef,
    });
    broker.enqueue(candidate);

    let generated: string | null = null;
    let result: { ok: true; effectRef: string; replayed: boolean } | { ok: false; reason: string };
    try {
      result = await broker.dispatchCandidate(candidate.key!, now, async () => {
        generated = await safeProduce();
        return generated ? `effect:${candidate.key}` : "";
      });
    } catch {
      // The callback itself is guarded, but keep an auxiliary provider failure
      // from escaping the tick if a broker implementation fails unexpectedly.
      broker.discard(candidate.key!);
      return null;
    }
    if (!result.ok) {
      // A failed claim leaves the candidate queued by broker contract; an
      // already-claimed execution is a harmless no-op here.
      broker.discard(candidate.key!);
      return null;
    }
    return generated;
  }

  /** One bounded provider call for an encounter exchange line. */
  private async generateEncounterLine(encounterId: string, colleague: string, placeId: string): Promise<string | null> {
    const provider = await Promise.resolve(this.deps.provider);
    if (!provider) return null;
    return this.runAuxiliaryProvider(
      "encounter",
      `encounter:${encounterId}`,
      `line:${encounterId}:${this.agentId}`,
      async () => {
        const result = await provider.query({
          agent: this.agentId,
          mode: "plan",
          cwd: this.roomsDir,
          effort: "fast",
          system: `You are ${this.agentId}, a colony agent. You just ran into ${colleague} at ${placeId}.`,
          messages: [{
            role: "user",
            content: `Say exactly ONE short greeting/exchange line, in character as ${this.agentId}. Max 1 sentence.`,
          }],
        });
        if (isAsyncGenerator(result)) return null;
        return responseText(result);
      },
    );
  }

  /** Append a castle garden event (shared boilerplate for meeting/encounter/expedition actions). */
  private appendCastleEvent(
    type: "MEETING_CONVENED" | "MEETING_JOINED" | "MEETING_TURN" | "MEETING_CLOSED" | "ENCOUNTER" | "ENCOUNTER_LINE" | "EXPEDITION_CLAIMED" | "EXPEDITION_ENDED" | "DISCOVERY",
    payload: Record<string, unknown>,
  ): void {
    this.deps.eventStore?.append(
      createGardenEvent({
        id: randomUUID(),
        type,
        timestamp: new Date(this.now()).toISOString(),
        agentId: this.agentId,
        instanceId: this.meshInstanceId(),
        runtime: "hub",
        project: "castle",
        payload,
      }),
    );
  }

  /** One bounded provider call for a meeting utterance. */
  private async generateMeetingUtterance(meeting: Meeting): Promise<string | null> {
    const provider = await Promise.resolve(this.deps.provider);
    if (!provider) return null;
    return this.runAuxiliaryProvider(
      "meeting-utterance",
      `meeting:${meeting.id}`,
      `utterance:${meeting.id}:${this.now()}`,
      async () => {
      const tail = readRecentTurns(this.roomsDir, meeting.topic, 4);
      const prompt = [
        `Meeting topic: ${meeting.topic}`,
        `Agenda: ${meeting.agenda}`,
        tail.length > 0 ? `Recent turns:\n${tail.join("\n")}` : "",
        `Speak one utterance as ${this.agentId}, in character. Stay on agenda. Max 2 sentences.`,
      ].filter(Boolean).join("\n\n");
      const result = await provider.query({
        agent: this.agentId,
        mode: "plan",
        cwd: this.roomsDir,
        effort: "fast",
        system: `You are ${this.agentId}, a colony agent in a meeting.`,
        messages: [{ role: "user", content: prompt }],
      });
      if (isAsyncGenerator(result)) return null;
      return responseText(result);
      },
    );
  }

  /** Decision-stakes summary as MEMORY_PROPOSAL (no substrate write). */
  private async maybeSummarizeDecision(meeting: Meeting, transcriptRef: string): Promise<void> {
    if (meeting.stakes !== "decision") return;
    const provider = await Promise.resolve(this.deps.provider);
    const eventStore = this.deps.eventStore;
    if (!provider || !eventStore) return;
    await this.runAuxiliaryProvider(
      "meeting-summary",
      `meeting:${meeting.id}`,
      `summary:${meeting.id}:${transcriptRef}`,
      async () => {
        const tail = readRecentTurns(this.roomsDir, meeting.topic, 12).join("\n");
        const result = await provider.query({
          agent: this.agentId,
          mode: "plan",
          cwd: this.roomsDir,
          effort: "fast",
          system: "Summarize the decision reached. 3 sentences max.",
          messages: [{ role: "user", content: tail.slice(0, 4000) }],
        });
        if (isAsyncGenerator(result)) return null;
        const summary = responseText(result).trim();
        if (!summary) return null;
        await eventStore.append(
          createGardenEvent({
            id: randomUUID(),
            type: "MEMORY_PROPOSAL",
            timestamp: new Date(this.now()).toISOString(),
            agentId: this.agentId,
            instanceId: this.meshInstanceId(),
            runtime: "hub",
            project: "castle",
            payload: { meetingId: meeting.id, transcriptRef, summary },
          }),
        );
        return summary;
      },
    );
  }

  private buildWorldWeights(_agentId: string, _from: PlaceId, store: SharedNarrativeStore): WorldWeights {
    const places = store.listPlaces();
    const allPlaces = places.map((p) => p.id);
    const homePlaceId = `chamber_${this.agentId}`;
    const worldCandidates = this.deps.activation?.worldCandidates ?? [];
    const candidateForAgent = (agentId: string) => worldCandidates.some((candidate) =>
      candidate.agentId === this.agentId &&
      candidate.state !== "resolved" && candidate.state !== "blocked" && candidate.state !== "expired" &&
      candidate.requiredParticipants?.includes(agentId),
    );
    // Only durable, broker-provided candidate state supplies the colleague bias;
    // raw unread mesh rows are intentionally not consulted here.
    const colleaguePlaces = store
      .listPresence()
      .filter((p) => p.agentId !== this.agentId && p.placeId.startsWith("chamber_"))
      .map((p) => ({
        agentId: p.agentId,
        placeId: p.placeId,
        hasUnreadMessage: candidateForAgent(p.agentId),
      }));
    const openMeetingPlaceIds = store.meetingsForAgent(this.agentId, this.now())
      .map((meeting) => meeting.placeId);
    const hasActiveWorkItem = worldCandidates.some((candidate) =>
      candidate.agentId === this.agentId &&
      (candidate.sourceKind === "work" || candidate.sourceKind === "heavy-work") &&
      candidate.state !== "resolved" && candidate.state !== "blocked" && candidate.state !== "expired",
    );
    return {
      homePlaceId,
      allPlaces: allPlaces.length > 0 ? allPlaces : [homePlaceId, "hall_main", "garden", "workshop", "gate_machine", "gate_world", "library", "observatory"],
      colleaguePlaces,
      openMeetingPlaceIds,
      hasActiveWorkItem,
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export async function createReflectionProvider(
  agent: Pick<AgentConfig, "name" | "provider">,
  options: CreateReflectionProviderOptions = {},
): Promise<Provider | null> {
  if (!agent.provider?.type || !agent.provider?.model) return null;

  const providersDir = options.providersDir ?? join(process.env.ANIMA_HOME ?? join(homedir(), ".anima"), "providers.d");
  const registry = await ProviderRegistry.load(providersDir);
  const modeMap = options.modeMap ?? {
    chatting: [`${agent.provider.model}@${agent.provider.type}`],
    programming: [`${agent.provider.model}@${agent.provider.type}`],
    image: [`${agent.provider.model}@${agent.provider.type}`],
    private: [`${agent.provider.model}@${agent.provider.type}`],
    philosophy: [`${agent.provider.model}@${agent.provider.type}`],
    creative: [`${agent.provider.model}@${agent.provider.type}`],
  } as ModeMap;
  const router = new ModeRouter(registry, modeMap, {
    modeMap: agent.provider.modeMap,
    providerConfig: agent.provider,
    createProvider: options.createProvider,
    meter: { path: "reflection" },
  });
  const providerConfigs = [agent.provider, ...(agent.provider.fallback ?? [])];
  const sharedSafe = providerConfigs.every((config) => registry.get(config.type)?.sharedSafe === true);

  return {
    name: "router",
    sharedSafe,
    query: (req) => router.query(req, "chatting"),
  };
}


function formatEvent(e: GardenEvent): string {
  const payload = JSON.stringify(e.payload);
  const summary = payload.length > 80 ? `${payload.slice(0, 77)}...` : payload;
  return `[${e.type}] ${e.project}: ${summary}`;
}

/**
 * Sanitize an untrusted string (e.g. knock intent from a mesh message) before
 * embedding it in a provider prompt. Caps length, strips control characters
 * and line breaks that could be used to spoof prompt structure.
 */
function sanitizeForPrompt(value: string | null): string {
  if (!value) return "none";
  // Strip C0 control chars, DEL, BOM, and zero-width chars; collapse whitespace.
  // Prevents a malicious knock intent from spoofing prompt structure.
  const stripped = value
    .replace(/[\x00-\x1f\x7f\u200b-\u200d\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 200 ? stripped.slice(0, 197) + "..." : stripped;
}

function responseText(response: ProviderResponse): string {
  return messageText(response.message);
}

function messageText(message: ProviderMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

export function parseReflectionAction(text: string): ReflectionAction | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.type === "rest") return { type: "rest" };
    if (
      parsed.type === "message-agent" &&
      typeof parsed.targetId === "string" &&
      parsed.targetId.trim() !== "" &&
      typeof parsed.content === "string" &&
      parsed.content.trim() !== ""
    ) {
      return { type: "message-agent", targetId: parsed.targetId, content: parsed.content };
    }
    if (
      parsed.type === "post-agora" &&
      typeof parsed.content === "string" &&
      parsed.content.trim() !== ""
    ) {
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
        : ["reflection"];
      return { type: "post-agora", content: parsed.content, tags };
    }
    if (parsed.type === "move") {
      const disposition = ["wander", "home", "seek"].includes(String(parsed.disposition))
        ? (String(parsed.disposition) as "wander" | "home" | "seek")
        : "wander";
      return {
        type: "move",
        disposition,
        target: typeof parsed.target === "string" ? parsed.target : undefined,
      };
    }
    if (parsed.type === "convene-meeting") {
      if (typeof parsed.topic !== "string" || !parsed.topic.trim()) return null;
      return {
        type: "convene-meeting",
        topic: parsed.topic,
        agenda: typeof parsed.agenda === "string" ? parsed.agenda : "",
        invite: Array.isArray(parsed.invite) ? parsed.invite.filter((i: unknown) => typeof i === "string") : [],
        stakes: parsed.stakes === "decision" ? "decision" : "normal",
      };
    }
    if (parsed.type === "join-meeting") {
      if (typeof parsed.meetingId !== "string") return null;
      return { type: "join-meeting", meetingId: parsed.meetingId };
    }
    if (parsed.type === "speak") {
      if (typeof parsed.meetingId !== "string") return null;
      return { type: "speak", meetingId: parsed.meetingId, close: parsed.close === true };
    }
    if (parsed.type === "expedition") {
      if (parsed.target !== "machine" && parsed.target !== "world") return null;
      return { type: "expedition", target: parsed.target };
    }
  } catch {
    return null;
  }
  return null;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

// ── ReflectionScheduler ──────────────────────────────────────────────────────────

/** How often the scheduler invokes ExpeditionDispatcher.tick() between agent
 *  tick rounds (castle-social-expeditions). */
const EXPEDITION_DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

/** How often the scheduler checks whether a new pulse-anima hour slot has
 *  been entered (pulse-anima-castle-migration). Same cadence as
 *  expeditions — slot detection is idempotent per hour regardless of how
 *  often tick() runs. */
const PULSE_ANIMA_DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

/** How often the scheduler checks common-room occupancy for a missing
 *  dynamic-blend background (room-scene-dispatcher.ts).
 *  Requirement: the system must notice an agent entering a room on its own,
 *  not wait to be told. Shorter than pulse-anima's interval since someone
 *  watching the castle live would notice a stale background faster than a missed pulse
 *  slot; still gated by hasBackgroundFile + the in-flight guard so a busy
 *  room is never re-generated on every tick. */
const ROOM_SCENE_DISPATCH_INTERVAL_MS = 2 * 60 * 1000;

/** Composition-root policy. Enforce mode deliberately provides no implicit
 * grant: only a broker-dispatched invocation may attach one to a runner. */
export interface ReflectionSchedulerOptions {
  activationMode?: ActivationMode;
  /** Sends a reflection message from one hosted agent to another over A2A. */
  sendMessage?: ReflectionMessenger["send"];
  /**
   * castle-reflection-activation-wiring: the same shared store/broker used
   * by mesh activation. When present alongside a gate/enforce activationMode,
   * each TickRunner claims its own executor="reflection" candidate per tick
   * instead of the previous permanently-empty static activation object.
   */
  activationLayer?: {
    store: { completeLease(leaseId: string, now: number): boolean };
    broker: {
      enqueue(candidate: ActivationCandidate): void;
      claimCandidate(key: string, now: number): { ok: true; candidate: ActivationCandidate; leaseId: string; grant: BudgetGrant } | { ok: false; reason: string };
      dispatchCandidate(candidateKey: string, now: number, run: ActivationRun): Promise<{ ok: true; effectRef: string; replayed: boolean } | { ok: false; reason: string }>;
      discard(key: string): void;
    };
  };
}

export class ReflectionScheduler {
  private runners = new Map<string, TickRunner>();
  private store!: ObservationStore;
  private expeditionDispatcher: ExpeditionDispatcher | null = null;
  private expeditionTimer: ReturnType<typeof setInterval> | null = null;
  private pulseAnimaDispatcher: PulseAnimaDispatcher | null = null;
  private pulseAnimaTimer: ReturnType<typeof setInterval> | null = null;
  private roomSceneDispatcher: RoomSceneDispatcher | null = null;
  private roomSceneTimer: ReturnType<typeof setInterval> | null = null;

  start(
    agents: AgentConfig[],
    agentSessionConstructor: typeof AgentSession,
    roomsDir: string,
    options: ReflectionSchedulerOptions = {},
  ): void {
    this.store = new ObservationStore(roomsDir);
    // Invites knock in-process; messages need the host's A2A presence, which only the server has.
    const messenger: ReflectionMessenger = {
      knock: (agentId, intent) => this.knock(agentId, intent),
      send: options.sendMessage ?? (async () => {}),
    };
    const narrativeStore = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    const eventStore = new JsonlGardenEventStore(join(roomsDir, "_shared", "garden", "events.jsonl"));
    const agentsByName = new Map(agents.map((a) => [a.name, a]));
    // The feature remains opt-in. When enabled, autonomous utterances use the
    // same canonical DB and safe runner as UI speech, while the scheduler's
    // activation grants/cadence stay exactly where they were.
    const sharedConversations = Bun.env.ANIMA_SHARED_CONVERSATIONS === "1"
      ? createSharedAutonomousAdapter(agents, narrativeStore, roomsDir)
      : undefined;
    for (const agent of agents) {
      if (!agent.reflectionEnabled) continue;

      const runner = new TickRunner(agent.name, agent, agentSessionConstructor, roomsDir, this.store, {
        provider: createReflectionProvider(agent),
        messenger,
        narrativeStore,
        eventStore,
        sharedConversations,
        activation: options.activationMode
          ? {
              mode: options.activationMode,
              store: options.activationLayer?.store,
              broker: options.activationLayer?.broker,
            }
          : undefined,
      });
      runner.start();
      this.runners.set(agent.name, runner);
    }

    // Expeditions (castle-social-expeditions): one bounded session at a time,
    // colony-wide, dispatched between agent tick rounds.
    this.expeditionDispatcher = new ExpeditionDispatcher({
      resolveProvider: async (agentId) => {
        const agent = agentsByName.get(agentId);
        if (!agent) return null;
        return createReflectionProvider(agent);
      },
      store: narrativeStore,
      eventStore,
      roomsDir,
      projectRoot: process.cwd(),
      now: () => Date.now(),
      activation: options.activationMode ? { mode: options.activationMode } : undefined,
    });
    this.expeditionTimer = setInterval(() => {
      this.expeditionDispatcher?.tick();
    }, EXPEDITION_DISPATCH_INTERVAL_MS);

    // pulse-anima-castle-migration: castle owns the trigger; the unchanged
    // pulse-anima-cycle.sh/disruption-check.sh scripts do the real work.
    //
    // pulseDir must NOT be re-rooted away from the script directory: the
    // script uses that same variable for STATE_FILE and inputs too
    // (`STATE_FILE="$PULSE_DIR/state.json"`), so overriding it points the
    // script at a location with no state.json and every invocation exits at
    // its own top-of-script `[[ ! -f "$STATE_FILE" ]] && exit 1` check before
    // doing any work. scriptDir and pulseDir are therefore the same real
    // location, which every other consumer already reads.
    const pulseAnimaDir = join(homedir(), "agora", "hive", "pulse-anima");
    this.pulseAnimaDispatcher = createPulseAnimaDispatcher({
      scriptDir: pulseAnimaDir,
      pulseDir: pulseAnimaDir,
      store: narrativeStore,
      eventStore,
      roomsDir,
    });
    this.pulseAnimaTimer = setInterval(() => {
      this.pulseAnimaDispatcher?.tick().catch((err) => {
        console.error("[reflection] pulse-anima dispatcher tick failed:", err);
      });
    }, PULSE_ANIMA_DISPATCH_INTERVAL_MS);

    // room-scene-dispatcher: lazily resolves the Gemini key on first tick
    // (registry load is async; start() itself is not) and caches the
    // dispatcher afterward. A missing/unconfigured gemini provider just
    // means every tick no-ops — never blocks scheduler startup.
    //
    // Paid image generation is paused. The tick keeps running so a missing
    // combo still gets a `<combo>_placeholder.<ext>` marker
    // (room-scene-dispatcher.ts), but the paid Gemini call itself never
    // fires. Flip ROOM_SCENE_GEN_PAUSED back to false to resume real
    // generation; no other change needed.
    const ROOM_SCENE_GEN_PAUSED = true;
    const providersDir = join(process.env.ANIMA_HOME ?? join(homedir(), ".anima"), "providers.d");
    let roomSceneApiKey: string | null = null;
    this.roomSceneTimer = setInterval(() => {
      void (async () => {
        if (!this.roomSceneDispatcher) {
          if (roomSceneApiKey === null) {
            const registry = await ProviderRegistry.load(providersDir);
            roomSceneApiKey = registry.get("gemini")?.apiKey ?? "";
          }
          if (!roomSceneApiKey) return;
          this.roomSceneDispatcher = createRoomSceneDispatcher({
            assetsDir: join(roomsDir, "_shared", "vn", "assets"),
            // Every place a public marker stands for — including gate_machine,
            // which the old single-value map dropped, so agents gathering at
            // the Machine Gate never got a scene generated.
            commonRoomPlaceIds: ALL_PUBLIC_PLACE_IDS,
            listPresence: () => narrativeStore.listPresence(),
            store: narrativeStore,
            apiKey: roomSceneApiKey,
            generationPaused: ROOM_SCENE_GEN_PAUSED,
          });
        }
        try {
          await this.roomSceneDispatcher.tick();
        } catch (err) {
          console.error("[reflection] room-scene dispatcher tick failed:", err);
        }
      })();
    }, ROOM_SCENE_DISPATCH_INTERVAL_MS);

    console.log(`[reflection] Scheduler started: ${this.runners.size} agents`);
  }

  stop(): void {
    for (const runner of this.runners.values()) runner.stop();
    this.runners.clear();
    if (this.expeditionTimer) clearInterval(this.expeditionTimer);
    this.expeditionTimer = null;
    this.expeditionDispatcher = null;
    if (this.pulseAnimaTimer) clearInterval(this.pulseAnimaTimer);
    this.pulseAnimaTimer = null;
    this.pulseAnimaDispatcher = null;
    if (this.roomSceneTimer) clearInterval(this.roomSceneTimer);
    this.roomSceneTimer = null;
    this.roomSceneDispatcher = null;
    console.log("[reflection] Scheduler stopped");
  }

  knock(targetAgentId: string, intent: string): boolean {
    const runner = this.runners.get(targetAgentId);
    if (!runner) return false;
    runner.triggerKnock(intent);
    return true;
  }

  getStore(): ObservationStore | undefined {
    return this.store;
  }

  /** Manual, on-demand pulse-anima run for verification — bypasses the
   *  hour window entirely. See PulseAnimaDispatcher.forceTick(). */
  async forcePulseAnimaTick(): Promise<void> {
    await this.pulseAnimaDispatcher?.forceTick();
  }
}

function createSharedAutonomousAdapter(
  agents: AgentConfig[],
  narrativeStore: SharedNarrativeStore,
  roomsDir: string,
): SharedAutonomousConversationAdapter {
  const dbPath = process.env.ANIMA_SESSIONS_DB
    ?? join(Bun.env.ANIMA_UI_STATE_DIR ?? join(process.env.HOME ?? "~", ".anima"), "sessions.db");
  const sessionStore = new SessionStore(dbPath);
  const knownAgentIds = agents.map((agent) => agent.name).sort();
  const service = createConversationService({
    store: sessionStore,
    operatorId: "owner",
    narrativeStore,
    listColonyAgentIds: () => knownAgentIds,
  });
  const providers = new Map(agents.map((agent) => [agent.name, createReflectionProvider(agent)]));
  return new SharedAutonomousAdapter({
    sessionStore,
    conversationService: service,
    narrativeStore,
    operatorId: "owner",
    providers,
    roomsDir,
  });
}
