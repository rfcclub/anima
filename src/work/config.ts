/**
 * Work settings for the castle work loop (anima #135, WL-9): the pinned author and
 * model, and the finite execution caps. Defaults are materialised into every work
 * record; a missing, non-finite or non-positive limit is rejected, never defaulted.
 */

export interface WorkCaps {
  /** Execution sessions per work, revise sessions and failed sessions included. */
  maxSessions: number;
  /** Provider/tool-loop iterations per session. */
  maxIterationsPerSession: number;
  /** Wall time of one session. */
  sessionWallMs: number;
  /** Execution wall time of the sessions before the first publish; once a pull request is recorded only sessionWallMs and maxSessions bound a work. */
  workWallMs: number;
}

export interface WorkConfig {
  author: string;
  provider: string;
  model: string;
  externalAdapter: "off" | "low";
  caps: WorkCaps;
}

export const DEFAULT_CAPS: Readonly<WorkCaps> = Object.freeze({
  maxSessions: 3,
  maxIterationsPerSession: 5,
  sessionWallMs: 10 * 60_000,
  workWallMs: 30 * 60_000,
});

const CAP_KEYS = Object.keys(DEFAULT_CAPS) as Array<keyof WorkCaps>;
// Bun and Node use a signed 32-bit millisecond delay for setTimeout.
const MAX_SESSION_WALL_MS = 2_147_483_647;

function checkCap(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new RangeError(`work cap ${name} must be a finite positive integer, got ${String(value)}`);
  }
  return value;
}

function checkCaps(caps: WorkCaps): WorkCaps {
  const out = {} as WorkCaps;
  for (const key of CAP_KEYS) out[key] = checkCap(key, caps[key]);
  if (out.sessionWallMs > MAX_SESSION_WALL_MS) {
    throw new RangeError(`work cap sessionWallMs exceeds the timer maximum (${MAX_SESSION_WALL_MS} ms)`);
  }
  if (out.sessionWallMs > out.workWallMs) {
    throw new RangeError(`work cap sessionWallMs (${out.sessionWallMs}) exceeds workWallMs (${out.workWallMs})`);
  }
  return out;
}

function checkName(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new RangeError(`work ${name} must be a non-empty string`);
  return value;
}

/** Initial author, from the approved intent (#135 rev2): Finn on the Agnes model, no fallback. */
export const DEFAULT_AUTHOR = { author: "finn", provider: "agnes", model: "agnes-3.0-flash" } as const;

export interface WorkConfigInput {
  author?: string;
  provider?: string;
  model?: string;
  externalAdapter?: "off" | "low";
  caps?: Partial<WorkCaps>;
}

/** Builds a complete, validated config. Omitted fields take the defaults; supplied ones must be valid. */
export function loadWorkConfig(input: WorkConfigInput = {}): WorkConfig {
  const given = input.caps ?? {};
  for (const key of Object.keys(given)) {
    if (!(CAP_KEYS as string[]).includes(key)) throw new RangeError(`unknown work cap ${key}`);
  }
  const caps = checkCaps({ ...DEFAULT_CAPS, ...given });
  const externalAdapter = input.externalAdapter === undefined ? "off" : input.externalAdapter;
  if (externalAdapter !== "off" && externalAdapter !== "low") throw new RangeError("work externalAdapter must be off or low");
  return {
    author: checkName("author", input.author ?? DEFAULT_AUTHOR.author),
    provider: checkName("provider", input.provider ?? DEFAULT_AUTHOR.provider),
    model: checkName("model", input.model ?? DEFAULT_AUTHOR.model),
    externalAdapter,
    caps,
  };
}

/** Reads the caps stored in a work record. Every key must be present: a record is never repaired with defaults. */
export function parseStoredCaps(json: string): WorkCaps {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new RangeError("stored work caps are not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new RangeError("stored work caps are not an object");
  return checkCaps(raw as WorkCaps);
}

/**
 * The base branch a work's repository is based on (anima #372). A repository named in `repoBases` uses its own
 * base (matched without regard to case); every other repository keeps the configured default. There is no
 * auto-detection: a base that is wrong or has no tracking upstream still fails closed.
 */
export function baseForRepo(repoBases: Record<string, string> | undefined, fallback: string, repo: string): string {
  return repoBases?.[repo.toLowerCase()] ?? fallback;
}
