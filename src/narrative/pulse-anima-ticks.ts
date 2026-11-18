/**
 * Pulse-anima's Library gathering has 4 generated scene variants
 * (generated group art). Each stage's rotation in state.json
 * has a period of 4, so the whole cycle's 4-agent combination repeats on a
 * period-4 schedule too — there are exactly 4 combinations it will ever
 * be, one per tick, mapped to a specific batch image:
 *   Tick 1: observe=ivan, reflect=dana, dream=finn, integrate=abel
 *   Tick 2: observe=rhea, reflect=cleo, dream=eli, integrate=hana
 *   Tick 3: observe=gus, reflect=nora, dream=sam, integrate=lena
 *   Tick 4: observe=milo, reflect=kai, dream=pia, integrate=bruno
 *
 * Pure, no node/fs imports — safe to import from both the client bundle
 * (PublicRoomPage.tsx) and the server (room-scene-dispatcher.ts), which
 * both need the identical answer to "is this a pulse-anima tick, or just
 * ordinary common-room occupancy?" (requirement: pulse-anima ticks
 * must NEVER trigger a paid dynamic-blend generation; use library_batch_X.png
 * even if agents walk in, and never blend 5 people).
 */
export const PULSE_ANIMA_TICKS: readonly (readonly string[])[] = [
  ["ivan", "dana", "finn", "abel"],
  ["rhea", "cleo", "eli", "hana"],
  ["gus", "nora", "sam", "lena"],
  ["milo", "kai", "pia", "bruno"],
];

/** Returns the 1-indexed tick number if `occupants` exactly match one of the
 *  4 known pulse-anima combinations, else null. */
export function matchPulseAnimaTick(occupants: string[]): number | null {
  if (occupants.length !== 4) return null;
  const set = new Set(occupants);
  const tickIndex = PULSE_ANIMA_TICKS.findIndex((tick) => tick.length === set.size && tick.every((a) => set.has(a)));
  return tickIndex >= 0 ? tickIndex + 1 : null;
}

/** Index of the "integrate" role within each tick's 4-tuple — see the
 *  module docstring's "Tick N: observe=..., reflect=..., dream=...,
 *  integrate=..." ordering. */
const INTEGRATE_ROLE_INDEX = 3;

/**
 * Returns the 1-indexed tick number whose "integrate" member matches
 * `integrateAgent`, else null.
 *
 * The 4 stages (observe/reflect/dream/integrate) each
 * cycle their own 4-name sequence independently and drift out of lockstep
 * over time — the exact 4-way combination `matchPulseAnimaTick` requires
 * eventually stops occurring at all once any stage's phase shifts relative
 * to the others (e.g. occupants {abel, ivan, kai, pia} mix Tick 1's
 * {ivan, abel} and Tick 4's {kai, pia} and match neither). The integrate role's own sequence
 * (["abel","hana","lena","bruno"]) still maps 1:1 onto the 4 ticks/images
 * regardless of where the other 3 stages currently are, so anchoring on
 * it alone keeps a batch image showing at all times instead of
 * permanently falling back to the plain default once the stages drift.
 */
export function matchPulseAnimaTickByIntegrate(integrateAgent: string | null): number | null {
  if (!integrateAgent) return null;
  const tickIndex = PULSE_ANIMA_TICKS.findIndex((tick) => tick[INTEGRATE_ROLE_INDEX] === integrateAgent);
  return tickIndex >= 0 ? tickIndex + 1 : null;
}

/** Index of the "dream" role within each tick's 4-tuple. */
const DREAM_ROLE_INDEX = 2;

/**
 * Returns the 1-indexed tick matching BOTH the integrate and dream agents
 * of one of the 4 known tuples, else null.
 *
 * Each of the 4 integrate agents maps to 4 agents in dream, so a pair gives
 * a second anchor, tried before falling back to integrate
 * alone. Integrate alone always resolves to *a* tick (see
 * matchPulseAnimaTickByIntegrate), but the other 3 roles' faces in that
 * tick's fixed art may not match who's actually in the room today. Adding
 * dream as a second required match doesn't fix that in general (dream can
 * drift independently of integrate too, same as every other role), but
 * when both happen to land on the same tick's original pairing, the art
 * is a strictly better match than integrate alone — worth checking first.
 */
export function matchPulseAnimaTickByIntegrateAndDream(
  integrateAgent: string | null,
  dreamAgent: string | null,
): number | null {
  if (!integrateAgent || !dreamAgent) return null;
  const tickIndex = PULSE_ANIMA_TICKS.findIndex(
    (tick) => tick[INTEGRATE_ROLE_INDEX] === integrateAgent && tick[DREAM_ROLE_INDEX] === dreamAgent,
  );
  return tickIndex >= 0 ? tickIndex + 1 : null;
}

/**
 * The scene id (no extension) for the dedicated cross-tick combo art — e.g.
 * `animaComboFileName("abel", "pia") === "anima_abel_pia"`. 12 of these exist,
 * one per integrate x dream pair that ISN'T already
 * covered by a same-tick anima_batchN image (4 pairs x 4 pairs - 4 same-tick
 * = 12). Order is integrate-then-dream, not sorted — that's the convention
 * on disk. Callers should try `matchPulseAnimaTickByIntegrateAndDream` first
 * (same-tick pairing, strictly correct art for all 4 roles) and only fall
 * back to this when that returns null.
 */
export function animaComboFileName(integrateAgent: string | null, dreamAgent: string | null): string | null {
  if (!integrateAgent || !dreamAgent) return null;
  return `anima_${integrateAgent}_${dreamAgent}`;
}
