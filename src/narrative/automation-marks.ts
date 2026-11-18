/** Machine state has a separate namespace from facts visible in narrative prompts. */
export const SLOT_MARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VISIT_MARK_TTL_MS = 12 * 60 * 60 * 1000;
export const ENCOUNTER_MARK_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export function isAutomationMark(key: string): boolean {
  return /^(pulse-anima-slot-fired:|visit-dedup:|encounter:|encounter-line:|expedition:)/.test(key)
    || /:(digest|last-digest|last-action|last-agora-post)$/.test(key)
    || ["pulse-anima-library-active", "pulse-anima-restore-due", "room-scene-gen-count"].includes(key);
}

export function automationMarkTtlMs(key: string): number | undefined {
  if (key.startsWith("pulse-anima-slot-fired:")) return SLOT_MARK_TTL_MS;
  if (key.startsWith("visit-dedup:")) return VISIT_MARK_TTL_MS;
  if (key.startsWith("encounter:")) return ENCOUNTER_MARK_TTL_MS;
  return undefined;
}

/** SQLite's historical datetime('now') values are UTC but omit a zone. */
export function markTimestampMs(timestamp: string): number {
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(timestamp)
    ? timestamp.replace(" ", "T") + "Z" : timestamp);
}
