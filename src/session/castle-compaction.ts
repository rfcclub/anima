import type { SessionStore, TurnRecord } from "../memory/session-store";
import type { Provider, ProviderMessage } from "../providers/interface";
import { estimateTokens } from "../utils/tokens";

/**
 * Castle session compaction. A castle session is compacted when it grows past
 * COMPACT_SIZE_TOKENS or has been idle longer than the provider's prompt cache lives; the earlier messages
 * are folded into one stored summary and soft-deleted in the same transaction.
 */
export const COMPACT_SIZE_TOKENS = 200_000;
/** Idle gap after which the provider's prompt cache is assumed to have expired. */
export const COMPACT_IDLE_MS = 30 * 60_000;
export const KEEP_TAIL_MESSAGES = 10;
export const IDLE_MIN_ELIGIBLE = 10;
/** Prior-history budget the castle path gives AgentSession, summary pair included. */
export const CASTLE_PRIOR_HISTORY_BUDGET = 200_000;
/** Budget for a turn whose compaction is running in the background (the default prior-history budget). */
export const COMPACTING_TURN_BUDGET = 30_000;
/** A summary longer than this is treated as a failed compaction; the request asks for at most 4,096 tokens. */
export const SUMMARY_MAX_CHARS = 40_000;
export const SUMMARY_TIMEOUT_MS = 300_000;
/** After a failed automatic compaction, the session is not retried automatically for this long. */
export const COMPACT_RETRY_MS = 30 * 60_000;
export const SUMMARY_MARKER = "[Earlier conversation — summary]";
export const SUMMARY_ACK = "Understood. Continuing from the summary.";

export type CompactReason = "size" | "idle" | "manual";
export type Summarizer = (input: { previousSummary?: string; turns: TurnRecord[]; signal: AbortSignal }) => Promise<string>;
type Log = (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface CompactionDeps {
  store: SessionStore;
  summarize: Summarizer;
  log: Log;
  now?: () => number;
  timeoutMs?: number;
  /** sessionId → time of the last failed automatic compaction (module-wide by default). */
  failures?: Map<string, number>;
}

const recentFailures = new Map<string, number>();

export interface CompactionResult {
  status: "compacted" | "nothing" | "skipped" | "failed" | "stale";
  reason?: CompactReason;
  summarized?: number;
  kept?: number;
}

/** The user/assistant pair that carries a stored summary ahead of the remaining messages. */
export function priorSummaryMessages(summary: string): ProviderMessage[] {
  return [
    { role: "user", content: `${SUMMARY_MARKER}\n${summary}` },
    { role: "assistant", content: SUMMARY_ACK },
  ];
}

/** Index where the kept tail starts: the newest 10 messages, extended back to a user message and to the newest exchange. */
export function keptTailStart(turns: TurnRecord[]): number {
  let start = Math.max(0, turns.length - KEEP_TAIL_MESSAGES);
  while (start > 0 && turns[start]!.role !== "user") start--;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "user") { start = Math.min(start, i); break; }
  }
  return start;
}

/** Idle wins when both triggers fire. Size counts the summary, every message and the incoming message. */
export function decideCompaction(input: { turns: TurnRecord[]; summary?: string; incomingMessage: string; now: number }): { reason?: "size" | "idle"; eligible: TurnRecord[] } {
  const eligible = input.turns.slice(0, keptTailStart(input.turns));
  const last = input.turns.at(-1);
  if (last && input.now - Date.parse(last.ts) > COMPACT_IDLE_MS && eligible.length >= IDLE_MIN_ELIGIBLE) return { reason: "idle", eligible };
  const size = estimateTokens(input.summary ?? "") + estimateTokens(input.incomingMessage)
    + input.turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
  if (size > COMPACT_SIZE_TOKENS && eligible.length > 0) return { reason: "size", eligible };
  return { eligible };
}

/** Compact when a trigger fires. Branching rooms are skipped (logged only when a trigger would have fired). */
export async function compactIfNeeded(
  deps: CompactionDeps,
  input: { sessionId: string; agent: string; incomingMessage: string; branching?: boolean },
): Promise<CompactionResult> {
  const now = deps.now?.() ?? Date.now();
  const failures = deps.failures ?? recentFailures;
  const failedAt = failures.get(input.sessionId);
  if (failedAt !== undefined && now - failedAt < COMPACT_RETRY_MS) return { status: "nothing" };
  const decision = decideCompaction({
    turns: deps.store.getTurns(input.sessionId),
    summary: deps.store.getSummary(input.sessionId)?.summary,
    incomingMessage: input.incomingMessage,
    now,
  });
  if (!decision.reason) return { status: "nothing" };
  if (input.branching) {
    deps.log("info", "session compaction skipped", { agent: input.agent, reason: "branching" });
    return { status: "skipped" };
  }
  const result = await publish(deps, input.sessionId, input.agent, decision.reason, decision.eligible);
  if (result.status === "failed") failures.set(input.sessionId, now);
  else failures.delete(input.sessionId);
  return result;
}

/** Compact now with `reason` (manual: `/compact` and the compact HTTP handler), keeping the kept tail. */
export async function compactSession(
  deps: CompactionDeps,
  input: { sessionId: string; agent: string; reason: CompactReason; branching?: boolean },
): Promise<CompactionResult> {
  if (input.branching) {
    deps.log("info", "session compaction skipped", { agent: input.agent, reason: "branching" });
    return { status: "skipped" };
  }
  const turns = deps.store.getTurns(input.sessionId);
  const eligible = turns.slice(0, keptTailStart(turns));
  if (eligible.length === 0) return { status: "nothing" };
  return publish(deps, input.sessionId, input.agent, input.reason, eligible);
}

async function publish(deps: CompactionDeps, sessionId: string, agent: string, reason: CompactReason, eligible: TurnRecord[]): Promise<CompactionResult> {
  const previous = deps.store.getSummary(sessionId);
  const fail = (error: unknown): CompactionResult => {
    deps.log("error", "session compaction failed", { agent, reason, error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", reason };
  };
  let summary: string;
  const controller = new AbortController();
  try {
    summary = (await withDeadline(
      deps.summarize({ previousSummary: previous?.summary, turns: eligible, signal: controller.signal }),
      deps.timeoutMs ?? SUMMARY_TIMEOUT_MS,
      controller,
    )).trim();
  } catch (error) {
    return fail(error);
  }
  if (!summary) return fail(new Error("empty summary"));
  if (summary.length > SUMMARY_MAX_CHARS) return fail(new Error(`summary too long (${summary.length} characters)`));
  let published: boolean;
  try {
    published = deps.store.publishSummary({
      sessionId,
      expectedVersion: previous?.version ?? 0,
      summary,
      coversThroughTurn: eligible.at(-1)!.id,
      turnIds: eligible.map((turn) => turn.id),
    });
  } catch (error) {
    return fail(error);
  }
  if (!published) return { status: "stale", reason };
  const kept = deps.store.getTurns(sessionId).length;
  deps.log("info", "session compacted", { agent, reason, summarized: eligible.length, kept, summaryEstimatedTokens: estimateTokens(summary) });
  return { status: "compacted", reason, summarized: eligible.length, kept };
}

/** Reject after `ms` and abort the summary query, so a timed-out provider call or stream stops too. */
function withDeadline<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`summary timeout after ${ms} ms`));
      reject(new Error(`summary timeout after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SUMMARY_SYSTEM_PROMPT = [
  "Summarize the earlier part of a conversation so it can continue without it.",
  "Keep durable facts, decisions, open questions and tasks, the user's preferences, and the tone of the relationship.",
  "If a previous summary is given, merge it with the new messages into one summary. Do not invent details.",
  "Write in the language the conversation uses.",
].join("\n");

/**
 * A Summarizer backed by the agent's own provider; streaming and non-streaming providers both work. The request
 * asks for a bounded answer (effort "normal") and carries the deadline's signal; a stream that grows past
 * SUMMARY_MAX_CHARS is stopped.
 */
export function providerSummarizer(provider: Provider, model?: string): Summarizer {
  return async ({ previousSummary, turns, signal }) => {
    const body = [
      previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}` : "",
      turns.map((turn) => `${turn.role.toUpperCase()}:\n${turn.content}`).join("\n\n"),
    ].filter(Boolean).join("\n\n");
    const result = provider.query({
      agent: "compactor", mode: "plan", model, system: SUMMARY_SYSTEM_PROMPT, effort: "normal", signal,
      messages: [{ role: "user", content: body }],
    });
    if (Symbol.asyncIterator in result) {
      let text = "";
      for await (const chunk of result) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("summary aborted");
        if (chunk.type === "error") throw new Error(chunk.error ?? "provider error");
        if (chunk.type === "text" && chunk.content) text += chunk.content;
        if (text.length > SUMMARY_MAX_CHARS) throw new Error(`summary too long (over ${SUMMARY_MAX_CHARS} characters)`);
      }
      return text;
    }
    const response = await result;
    return typeof response.message.content === "string" ? response.message.content : JSON.stringify(response.message.content);
  };
}

function structuredLog(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console[level === "error" ? "error" : "log"](JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields }));
}

const inFlight = new Map<string, Promise<CompactionResult>>();

function castleDeps(input: { store: SessionStore; provider: Provider; model?: string }): CompactionDeps {
  return { store: input.store, summarize: providerSummarizer(input.provider, input.model), log: structuredLog };
}

/**
 * Own a detached compaction: callers never await it, so an unexpected rejection (a SQLite read error outside the
 * worker's own failure handling) becomes a logged failure with the automatic-retry back-off, never an unhandled
 * rejection, and the session's in-flight slot is always released.
 */
function track(
  sessionId: string,
  agent: string,
  failures: Map<string, number>,
  now: number,
  pending: Promise<CompactionResult>,
): Promise<CompactionResult> {
  const done: Promise<CompactionResult> = pending
    .catch((error: unknown): CompactionResult => {
      structuredLog("error", "session compaction failed", { agent, error: error instanceof Error ? error.message : String(error) });
      failures.set(sessionId, now);
      return { status: "failed" };
    })
    .finally(() => { if (inFlight.get(sessionId) === done) inFlight.delete(sessionId); });
  inFlight.set(sessionId, done);
  return done;
}

/** Settle every castle compaction running in this process (tests; a clean shutdown). */
export async function waitForCastleCompactions(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
}

/**
 * The castle talk paths' entry point, for the agent that speaks this turn. Synchronous: when a trigger fires it
 * starts the compaction in the background (at most one per session) and this turn sends history trimmed to
 * COMPACTING_TURN_BUDGET; otherwise the turn sends the stored summary and up to CASTLE_PRIOR_HISTORY_BUDGET.
 * The caller reads the session's turns right after this call, with no await in between, so the summary and
 * the turns it reads come from the same published state.
 */
export function startCastleCompaction(input: {
  store: SessionStore;
  sessionId: string;
  agent: string;
  branching: boolean;
  provider: Provider;
  model?: string;
  incomingMessage: string;
  now?: number;
  failures?: Map<string, number>;
}): { summary?: string; budget: number; pending?: Promise<CompactionResult> } {
  // Branching rooms are never compacted and keep the default budget.
  if (input.branching) {
    const turns = input.store.getTurns(input.sessionId);
    const now = input.now ?? Date.now();
    if (decideCompaction({ turns, incomingMessage: input.incomingMessage, now }).reason) {
      structuredLog("info", "session compaction skipped", { agent: input.agent, reason: "branching" });
    }
    return { budget: COMPACTING_TURN_BUDGET };
  }
  const summary = input.store.getSummary(input.sessionId)?.summary;
  const running = inFlight.get(input.sessionId);
  if (running) return { summary, budget: COMPACTING_TURN_BUDGET, pending: running };
  const now = input.now ?? Date.now();
  const decision = decideCompaction({ turns: input.store.getTurns(input.sessionId), summary, incomingMessage: input.incomingMessage, now });
  if (!decision.reason) return { summary, budget: CASTLE_PRIOR_HISTORY_BUDGET };
  const failures = input.failures ?? recentFailures;
  const failedAt = failures.get(input.sessionId);
  if (failedAt !== undefined && now - failedAt < COMPACT_RETRY_MS) return { summary, budget: COMPACTING_TURN_BUDGET };
  const pending = track(input.sessionId, input.agent, failures, now, compactIfNeeded(
    { ...castleDeps(input), now: () => now, failures },
    { sessionId: input.sessionId, agent: input.agent, incomingMessage: input.incomingMessage },
  ));
  return { summary, budget: COMPACTING_TURN_BUDGET, pending };
}

/**
 * `/compact` and the compact HTTP handler: decide now, run in the background, and report whether a compaction
 * started. Running in the background keeps a long summary call from holding the HTTP request open.
 */
export function startCastleCompactionNow(input: {
  store: SessionStore;
  sessionId: string;
  agent: string;
  branching: boolean;
  provider: Provider;
  model?: string;
}): { status: "started" | "running" | "nothing" | "skipped"; summarizing?: number; pending?: Promise<CompactionResult> } {
  if (input.branching) {
    structuredLog("info", "session compaction skipped", { agent: input.agent, reason: "branching" });
    return { status: "skipped" };
  }
  const running = inFlight.get(input.sessionId);
  if (running) return { status: "running", pending: running };
  const turns = input.store.getTurns(input.sessionId);
  const eligible = keptTailStart(turns);
  if (eligible === 0) return { status: "nothing" };
  const pending = track(input.sessionId, input.agent, recentFailures, Date.now(),
    compactSession(castleDeps(input), { sessionId: input.sessionId, agent: input.agent, reason: "manual" }));
  return { status: "started", summarizing: eligible, pending };
}
