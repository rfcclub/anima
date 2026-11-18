/** Bounds one beat (one speaker's provider run) and stops it when the client leaves.
 *
 *  A beat that runs past the limit, or whose client has gone, ends with an error and its `signal` is aborted, so a
 *  provider call that honours it stops too. The stream is raced against the guard, so a provider that ignores the
 *  signal still cannot hold the room: the pipeline stops waiting for it. */

import type { ProviderChunk } from "../../../../providers/interface";

const DEFAULT_LIMIT_MS = 600_000;

/** `ANIMA_TALK_BEAT_TIMEOUT_MS`: the longest one beat may run. Default ten minutes; a missing, zero or unreadable value gives the default. */
export function beatLimitMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANIMA_TALK_BEAT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT_MS;
}

const DEFAULT_GRACE_MS = 5000;

/** `ANIMA_TALK_STOP_GRACE_MS`: how long a stopped beat is waited for to really stop before the room is freed anyway. Default five seconds. */
export function beatGraceMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANIMA_TALK_STOP_GRACE_MS);
  return env.ANIMA_TALK_STOP_GRACE_MS !== undefined && env.ANIMA_TALK_STOP_GRACE_MS !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_GRACE_MS;
}

export class BeatLimitError extends Error {
  constructor(public readonly limitMs: number) {
    super(`the reply took longer than the limit of ${limitMs} ms (ANIMA_TALK_BEAT_TIMEOUT_MS) and was stopped`);
    this.name = "BeatLimitError";
  }
}

export class ClientLeftError extends Error {
  constructor() {
    super("the client left; the reply was stopped");
    this.name = "ClientLeftError";
  }
}

export interface BeatGuard {
  /** Pass to the provider call: aborted when the beat times out or the client leaves. */
  signal: AbortSignal;
  /** Rejects with a BeatLimitError or a ClientLeftError. Never resolves. */
  expired: Promise<never>;
  /** How long to wait for a stopped provider call to really stop. */
  graceMs: number;
  elapsedMs(): number;
  /** The beat is over: clear the timer. */
  done(): void;
}

export function createBeatGuard(opts: { signal: AbortSignal; limitMs: number; graceMs?: number }): BeatGuard {
  const own = new AbortController();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClientAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { own.abort(); reject(new BeatLimitError(opts.limitMs)); }, opts.limitMs);
    onClientAbort = () => { own.abort(); reject(new ClientLeftError()); };
    if (opts.signal.aborted) onClientAbort();
    else opts.signal.addEventListener("abort", onClientAbort, { once: true });
  });
  expired.catch(() => {}); // an unobserved rejection after the beat is over is not an error
  return {
    signal: own.signal,
    expired,
    graceMs: opts.graceMs ?? beatGraceMs(),
    elapsedMs: () => Date.now() - startedAt,
    done() {
      clearTimeout(timer);
      if (onClientAbort) opts.signal.removeEventListener("abort", onClientAbort);
    },
  };
}

/** The chunks of `gen`, raced against the guard: when the guard expires the iteration throws. `gen` is told to stop
 *  and is waited for, up to the guard's grace, before the iteration ends: the room is freed after that, so a provider
 *  that honours the signal never shares its session with the next send. One that ignores it is waited for only the
 *  grace (with a warning), so it cannot hold the room for ever. */
export async function* guarded<T>(gen: AsyncGenerator<T>, guard: BeatGuard): AsyncGenerator<T> {
  const it = gen[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([it.next(), guard.expired]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    const stop = Promise.resolve(it.return?.(undefined as never)).then(() => "stopped" as const, () => "stopped" as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => { timer = setTimeout(() => resolve("grace"), guard.graceMs); });
    const outcome = await Promise.race([stop, grace]);
    clearTimeout(timer);
    if (outcome === "grace") console.warn(`[talk] the provider call did not stop ${guard.graceMs} ms after it was told to; going on without it`);
  }
}

// ── One beat, bounded and logged ─────────────────────────────────────────

export interface BeatMeta {
  room: string;
  speaker: string;
  provider: string;
  model: string;
  /** How long this send waited for the room lock, in ms. */
  lockWaitMs: number;
}

/** One structured line per beat: where the time went. */
export function logBeat(meta: BeatMeta, providerMs: number, outcome: string): void {
  console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), msg: "talk beat", ...meta, providerMs, outcome }));
}

const outcomeOf = (err: unknown) => (err instanceof BeatLimitError ? "limit" : err instanceof ClientLeftError ? "client_left" : "error");


/** Run one beat to the end and return the text chunks. `stream` gets the signal to give the provider call. */
export async function collectBeat(a: { signal: AbortSignal; meta: BeatMeta; stream: (signal: AbortSignal) => AsyncGenerator<ProviderChunk> }): Promise<string[]> {
  const guard = createBeatGuard({ signal: a.signal, limitMs: beatLimitMs() });
  const parts: string[] = [];
  let outcome = "ok";
  try {
    for await (const chunk of guarded(a.stream(guard.signal), guard)) {
      if (chunk.type === "text" && chunk.content) parts.push(chunk.content);
    }
  } catch (err) {
    outcome = outcomeOf(err);
    throw err;
  } finally {
    guard.done();
    logBeat(a.meta, guard.elapsedMs(), outcome);
  }
  return parts;
}

/** The same bound and log for a beat whose chunks are streamed on (the single-speaker path). */
export async function* streamBeat(a: { signal: AbortSignal; meta: BeatMeta; stream: (signal: AbortSignal) => AsyncGenerator<ProviderChunk> }): AsyncGenerator<ProviderChunk> {
  const guard = createBeatGuard({ signal: a.signal, limitMs: beatLimitMs() });
  let outcome = "ok";
  try {
    yield* guarded(a.stream(guard.signal), guard);
  } catch (err) {
    outcome = outcomeOf(err);
    throw err;
  } finally {
    guard.done();
    logBeat(a.meta, guard.elapsedMs(), outcome);
  }
}

/** `gen`, with `onEnd` called when its iteration ends, however it ends: the room lock is freed after that. */
export async function* tracked<T>(gen: AsyncGenerator<T>, onEnd: () => void): AsyncGenerator<T> {
  try {
    yield* gen;
  } finally {
    onEnd();
  }
}
