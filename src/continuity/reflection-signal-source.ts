import { buildCandidate, type ActivationCandidate } from "./activation-candidate";

export interface ReflectionSignalInput {
  agentId: string;
  inboxCount: number;
  knocked: boolean;
  now: number;
  /** Hours since this agent last moved/acted (presence.since). Null/undefined
   *  when unknown — treated as "not restless" (no bonus), never as infinite
   *  idle time. */
  hoursSinceLastMove?: number | null;
}

/** Below this many idle hours, restlessness contributes nothing. Shorter than
 *  a human's equivalent (agents don't sleep, so no reason to wait as long as a
 *  human would). */
const RESTLESS_THRESHOLD_HOURS = 3;
/** Restlessness grows by 1 urgency point per this many hours past the
 *  threshold, capped at RESTLESS_CAP. Raised to make restlessness
 *  stronger: the original cap (3) exactly equalled the default
 *  urgencyThreshold, so restlessness alone only ever just barely crossed it
 *  after ~15h idle, with zero margin. RESTLESS_CAP now clears the threshold
 *  with real headroom, and RESTLESS_RATE_HOURS ramps faster so it first
 *  crosses at ~9h idle instead of ~15h.
 */
const RESTLESS_RATE_HOURS = 3;
const RESTLESS_CAP = 6;

/** Day/night window (agents socialize more by day and go
 *  home to sleep at night) — restlessness (boredom-driven wandering) only
 *  applies during the day. Real signals (inbox mail, knock) still work at
 *  night, same as a phone call can wake someone but boredom shouldn't.
 *  Colony convention (CLAUDE.md) treats operational timestamps as
 *  America/New_York, so the window is evaluated in that zone (handles
 *  EST/EDT automatically) rather than a hardcoded UTC offset. */
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 23;
const CASTLE_TIMEZONE = "America/New_York";

function isDaytime(nowMs: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: CASTLE_TIMEZONE, hour: "numeric", hour12: false }).format(
      new Date(nowMs),
    ),
  );
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

function restlessnessUrgency(nowMs: number, hoursSinceLastMove?: number | null): number {
  if (hoursSinceLastMove == null || hoursSinceLastMove <= RESTLESS_THRESHOLD_HOURS) return 0;
  if (!isDaytime(nowMs)) return 0;
  const overage = hoursSinceLastMove - RESTLESS_THRESHOLD_HOURS;
  return Math.min(RESTLESS_CAP, Math.floor(overage / RESTLESS_RATE_HOURS) + 1);
}

/**
 * Wraps TickRunner's existing inbox-count/knock-intent heuristic
 * (previously only used in evaluate()'s non-gate branch) as an
 * `executor: "reflection"` activation candidate, so gate/enforce mode has a
 * real, claimable candidate instead of never producing one. Deterministic,
 * stateless, no provider call — matches the heuristic gate/enforce mode
 * silently dropped: min(5, inboxCount * 3) + (knocked ? 5 : 0).
 *
 * Restlessness (like a human wanting to go out for a walk, not just work
 * like a machine) adds a third,
 * inbox/knock-independent source: an agent idle long enough gets a small,
 * capped urgency bump on its own, so agents nobody ever messages aren't
 * permanently inert.
 */
export class ReflectionSignalCandidateSource {
  buildCandidate(input: ReflectionSignalInput): ActivationCandidate | null {
    const { agentId, inboxCount, knocked, now, hoursSinceLastMove } = input;
    let urgency = 0;
    if (inboxCount > 0) urgency += Math.min(5, inboxCount * 3);
    if (knocked) urgency += 5;
    urgency += restlessnessUrgency(now, hoursSinceLastMove);
    if (urgency <= 0) return null;

    return buildCandidate({
      agentId,
      sourceKind: "reflection-signal",
      sourceRef: agentId,
      occurrenceKey: `tick:${now}`,
      sourceVersion: now,
      dueAt: now,
      urgency,
      costClass: "T1",
      executor: "reflection",
      summary: knocked ? "pending knock" : `${inboxCount} unread`,
      reasonRef: `reflection-signal:${agentId}:${now}`,
    });
  }
}
