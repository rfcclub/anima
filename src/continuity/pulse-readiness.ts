#!/usr/bin/env bun
/**
 * pulse-single-owner: the one place that defines how "the
 * replacement Pulse scheduler is running" is spelled on the wire.
 *
 * Why this exists: `src/server.ts` catches reflection-init
 * failures and keeps serving, so `/health` answers 200 even when
 * `ReflectionScheduler.start()` never installed the Pulse timer. The deploy
 * step that retires the old scheduler must not read
 * that 200 as "castle has taken over" — doing so would stop the only
 * scheduler still firing and lose every subsequent slot.
 *
 * The producer (`src/server.ts`'s `/health` handler) and its consumers
 * import these values so they cannot drift apart silently.
 */

/** `/health` field name. */
export const PULSE_ANIMA_HEALTH_FIELD = "pulseAnima";

/** The only value that authorises retiring the old scheduler. */
export const PULSE_ANIMA_RUNNING = "running";

/** Everything else — including a degraded startup — is not ready. */
export const PULSE_ANIMA_UNAVAILABLE = "unavailable";

/** What the server writes into `/health`: was the castle Pulse dispatcher and
 *  its interval timer actually installed? */
export function pulseAnimaHealthField(running: boolean): string {
  return running ? PULSE_ANIMA_RUNNING : PULSE_ANIMA_UNAVAILABLE;
}
