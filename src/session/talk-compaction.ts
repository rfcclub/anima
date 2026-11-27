import type { TurnRecord } from "../memory/session-store";
import { estimateTokens } from "../utils/tokens";

/**
 * Talk-path compaction trigger. A talk turn compacts when the context before the turn and the context predicted
 * after it both exceed T = 50% of min(W, 256,000): 128,000 for any model whose window is 256K or larger, and half
 * of its own window for a smaller one. A room may replace T through `session.compactThreshold`.
 */
export const TALK_WINDOW_CAP = 256_000;
/** Assumed window when the room does not name one (256K, so T is 128,000). */
export const TALK_DEFAULT_WINDOW = TALK_WINDOW_CAP;
/** Reply estimate used when the session has no assistant turn to average yet. */
export const TALK_DEFAULT_REPLY_TOKENS = 500;
/** How many recent assistant turns the reply estimate averages. */
export const TALK_REPLY_SAMPLE = 5;
export const TALK_DECISION_TIMEOUT_MS = 1500;

/**
 * The config loader's default for `session.compactThreshold` (src/config/types.ts). Every room carries it whether
 * or not its config.yaml names one, so a room whose value is this default is treated as not overriding T.
 */
export const TALK_LEGACY_DEFAULT_OVERRIDE = 60_000;

/** T = 50% of min(window, 256,000); a room's own `session.compactThreshold` replaces it. */
export function talkCompactThreshold(input: { contextWindow?: number; override?: number }): number {
  if (typeof input.override === "number" && Number.isFinite(input.override) && input.override > 0) {
    return Math.floor(input.override);
  }
  const window = typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0
    ? input.contextWindow
    : TALK_DEFAULT_WINDOW;
  return Math.floor(0.5 * Math.min(window, TALK_WINDOW_CAP));
}

/** Pinned summary + live history. System content is added by the caller's own estimate when it known. */
export function estimatePreTurnTokens(input: { summary?: string; turns: TurnRecord[]; systemTokens?: number }): number {
  return estimateTokens(input.summary ?? "")
    + input.turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
    + Math.max(0, input.systemTokens ?? 0);
}

/** The session's recent average reply size, or TALK_DEFAULT_REPLY_TOKENS when there is nothing to average. */
export function estimateReplyTokens(turns: TurnRecord[]): number {
  const replies = turns.filter((turn) => turn.role === "assistant").slice(-TALK_REPLY_SAMPLE);
  if (replies.length === 0) return TALK_DEFAULT_REPLY_TOKENS;
  const total = replies.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
  return Math.ceil(total / replies.length);
}

/** Pre-turn size plus the incoming message and the reply estimate for this turn. */
export function predictPostTurnTokens(input: { preTurnTokens: number; incomingMessage: string; replyTokens: number }): number {
  return input.preTurnTokens + estimateTokens(input.incomingMessage) + Math.max(0, input.replyTokens);
}

export interface TalkCompactionDecision {
  compact: boolean;
  threshold: number;
  preTurnTokens: number;
  predictedPostTurnTokens: number;
  /** "arithmetic" unless a decision model answered. */
  source: "arithmetic" | "model";
}

/** The arithmetic rule: both the pre-turn and the predicted post-turn size must exceed T. */
export function decideTalkCompaction(input: {
  turns: TurnRecord[];
  summary?: string;
  incomingMessage: string;
  threshold: number;
  systemTokens?: number;
}): TalkCompactionDecision {
  const preTurnTokens = estimatePreTurnTokens(input);
  const predictedPostTurnTokens = predictPostTurnTokens({
    preTurnTokens,
    incomingMessage: input.incomingMessage,
    replyTokens: estimateReplyTokens(input.turns),
  });
  return {
    compact: preTurnTokens > input.threshold && predictedPostTurnTokens > input.threshold,
    threshold: input.threshold,
    preTurnTokens,
    predictedPostTurnTokens,
    source: "arithmetic",
  };
}

/** Numeric features given to an optional decision model; no conversation text is required. */
export interface TalkDecisionFeatures {
  preTurnTokens: number;
  predictedPostTurnTokens: number;
  threshold: number;
  ratio: number;
  turnCount: number;
  estimatedReplyTokens: number;
}

/**
 * An optional, typed decision model: it answers "compact now?" with a probability. It never writes the summary;
 * it only replaces the arithmetic answer for one turn.
 */
export interface TalkDecisionModel {
  decide(features: TalkDecisionFeatures, signal: AbortSignal): Promise<{ probability: number } | null>;
}

/**
 * Decide with the decision model when one is configured, and with the arithmetic rule otherwise. A model that
 * errors, times out or answers out of range is ignored: the arithmetic answer stands and the turn proceeds.
 */
export async function decideTalkCompactionWithModel(input: {
  turns: TurnRecord[];
  summary?: string;
  incomingMessage: string;
  threshold: number;
  systemTokens?: number;
  model?: TalkDecisionModel;
  timeoutMs?: number;
}): Promise<TalkCompactionDecision> {
  const arithmetic = decideTalkCompaction(input);
  if (!input.model) return arithmetic;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, input.timeoutMs ?? TALK_DECISION_TIMEOUT_MS);
  });
  const features: TalkDecisionFeatures = {
    preTurnTokens: arithmetic.preTurnTokens,
    predictedPostTurnTokens: arithmetic.predictedPostTurnTokens,
    threshold: arithmetic.threshold,
    ratio: arithmetic.threshold > 0 ? arithmetic.predictedPostTurnTokens / arithmetic.threshold : 0,
    turnCount: input.turns.length,
    estimatedReplyTokens: estimateReplyTokens(input.turns),
  };
  let answer: { probability: number } | null = null;
  try {
    answer = await Promise.race([input.model.decide(features, controller.signal), timeout]);
  } catch {
    answer = null;
  } finally {
    clearTimeout(timer);
  }
  const probability = answer?.probability;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return arithmetic;
  return { ...arithmetic, compact: arithmetic.preTurnTokens > arithmetic.threshold && probability > 0.5, source: "model" };
}

/**
 * Everything a talk turn needs from the trigger, for one call site: T, the reply estimate for the predicted
 * post-turn size, and the prior-history budget to send when no compaction starts (T, so a prompt is always
 * bounded even if compaction is skipped or fails).
 */
export function talkCompactionPlan(input: {
  turns: TurnRecord[];
  summary?: string;
  incomingMessage: string;
  contextWindow?: number;
  override?: number;
}): { threshold: number; preTurnTokens: number; replyEstimateTokens: number; budget: number } {
  // The loader's default is not an override (see TALK_LEGACY_DEFAULT_OVERRIDE).
  const override = input.override === TALK_LEGACY_DEFAULT_OVERRIDE ? undefined : input.override;
  const threshold = talkCompactThreshold({ contextWindow: input.contextWindow, override });
  return {
    threshold,
    preTurnTokens: estimatePreTurnTokens({ summary: input.summary, turns: input.turns }),
    replyEstimateTokens: estimateReplyTokens(input.turns),
    budget: threshold,
  };
}
