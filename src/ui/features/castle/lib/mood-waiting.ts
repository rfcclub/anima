/**
 * Waiting-state text shown in RoomWaitingBubble while the agent's LLM reply
 * is in flight (after the user sends, before the reply streams back).
 *
 * Used to also carry a Vietnamese "embodied mood" line above the English
 * status caption below — removed because the waiting bubble showed
 * the wait twice, once in Vietnamese and once in English; every caller
 * passed `mood: undefined` anyway, so it always rendered the generic
 * "neutral" bucket, never anything mood-specific). The caption below is now
 * the only waiting text.
 */

/**
 * Small whimsical status word shown next to the elapsed-time counter —
 * the words follow the style of Claude Code's spinner. This is a secondary technical caption, not
 * a replacement for the embodied mood line above — same idea as Claude
 * Code's own status line ("Pondering… (12s · esc to interrupt)"), where
 * the playful verb rides alongside the timer rather than the character's
 * in-scene action.
 */
const WHIMSICAL_STATUS_WORDS = [
  "Pondering",
  "Percolating",
  "Noodling",
  "Marinating",
  "Ruminating",
  "Musing",
  "Simmering",
  "Cogitating",
  "Brewing",
  "Conjuring",
  "Synthesizing",
  "Meandering",
  "Puttering",
  "Divining",
  "Unfurling",
];

/** Pick a random whimsical status word. */
export function whimsicalStatusWord(): string {
  return WHIMSICAL_STATUS_WORDS[Math.floor(Math.random() * WHIMSICAL_STATUS_WORDS.length)];
}

/**
 * Escalating status phrase for the waiting caption, keyed on elapsed
 * seconds — phases: thinking, still thinking,
 * thinking more, remote slow response. A real LLM reply through the
 * castle shared-conversation path runs ~30-45s end to end (measured
 * live); thresholds are spaced to move roughly with that,
 * not tied to any server-side timeout.
 */
export function waitingStatusPhrase(elapsedSec: number): string {
  if (elapsedSec < 7) return "thinking";
  if (elapsedSec < 18) return "still thinking";
  if (elapsedSec < 32) return "thinking more";
  return "remote slow response";
}
