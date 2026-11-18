/**
 * Movement Resolver — pure, seeded function for Castle Step 1.
 *
 * Given a disposition (wander/home/user), a 'from' place, a seed, and a
 * read-only snapshot of world signals, return the destination place id.
 *
 * Pure + seeded RNG → identical inputs always produce identical output
 * (replay determinism for the AGENT_MOVED event).
 *
 * Weights (baseline):
 *   home chamber:  5
 *   hall_main:     3
 *   garden:        2
 *   workshop:      2
 *   gates:        1
 *
 * Biases (added when the corresponding world signal exists):
 *   open meeting place:               +4
 *   colleague's chamber w/ unread msg: +3
 *   workshop when active work item:    +3
 */

export type MoveDisposition = "wander" | "home" | "seek";

export type PlaceId = string;

export interface WorldWeights {
  homePlaceId: PlaceId;
  openMeetingPlaceIds?: PlaceId[];
  colleaguePlaces?: Array<{ agentId: string; placeId: PlaceId; hasUnreadMessage: boolean }>;
  hasActiveWorkItem?: boolean;
  allPlaces: PlaceId[];
  /** Places excluded from weighted wander only — an explicit `seek` target
   *  still reaches them (e.g. a convened meeting), and `allPlaces` itself
   *  stays the authoritative "does this place exist" list for target
   *  validation elsewhere. */
  wanderExcluded?: PlaceId[];
}

export interface ResolveMoveInput {
  agentId: string;
  from: PlaceId;
  disposition: MoveDisposition;
  target?: PlaceId;
  seed: number;
  world: WorldWeights;
}

export interface ResolveMoveResult {
  to: PlaceId;
  seed: number;
}

export function resolveMove(input: ResolveMoveInput): ResolveMoveResult {
  const { from, disposition, target, seed, world } = input;

  if (disposition === "home") {
    return { to: world.homePlaceId, seed };
  }

  if (disposition === "seek" && target) {
    return { to: target, seed };
  }

  // wander (or seek-without-target → weighted wander)
  const candidates = world.allPlaces.filter(
    (p) => p !== from && !world.wanderExcluded?.includes(p),
  );
  if (candidates.length === 0) {
    return { to: from, seed };
  }

  const weighted = candidates.map((place) => ({
    place,
    weight: weightFor(place, world),
  }));

  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) {
    // Degenerate: all weights zero — fall back to first candidate
    return { to: weighted[0].place, seed };
  }

  const rng = seededRandom(seed);
  let roll = rng() * total;
  for (const { place, weight } of weighted) {
    roll -= weight;
    if (roll <= 0) {
      return { to: place, seed };
    }
  }
  // Floating-point fallback
  return { to: weighted[weighted.length - 1].place, seed };
}

function weightFor(place: PlaceId, world: WorldWeights): number {
  let w = 0;

  if (place === world.homePlaceId) {
    w += 5;
  } else if (place === "hall_main") {
    w += 3;
  } else if (place === "garden" || place === "workshop") {
    w += 2;
  } else {
    w += 1;
  }

  if (world.openMeetingPlaceIds?.includes(place)) {
    w += 4;
  }

  const colleague = world.colleaguePlaces?.find(
    (c) => c.placeId === place && c.hasUnreadMessage,
  );
  if (colleague) {
    w += 3;
  }

  if (world.hasActiveWorkItem && place === "workshop") {
    w += 3;
  }

  return w;
}

/**
 * Seeded RNG — deterministic across Node/Bun/Deno runtimes.
 *
 * Uses a splitmix32-style scramble on the seed first, then an LCG. The
 * scramble is necessary because a raw LCG started from consecutive seeds
 * (0,1,2,...) produces nearly identical first outputs (the multiplier
 * 1664525 is tiny relative to the 2^32 modulus), which would make
 * every agent on the same tick pick the same destination.
 */
function seededRandom(seed: number): () => number {
  let s = scramble(seed >>> 0);
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function scramble(input: number): number {
  let s = (input + 0x9e3779b9) | 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
  s ^= s >>> 16;
  return s >>> 0;
}
