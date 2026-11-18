/**
 * Per-room FIFO serialization for talk pipelines.
 *
 * The "one pipeline" law (presence routes; it does not multiply) was
 * enforced only within a single request — two concurrent
 * `POST /api/talk/:agent` calls ran two pipelines, racing on the
 * session turns read-modify-write and scrambling transcript ordering
 * (SC-101..103). This module serializes them.
 *
 * `SessionManager` is constructed per request, so the lock MUST live at
 * module scope — nothing request-scoped can hold cross-request state.
 */

const inFlight = new Map<string, Promise<void>>();

/** Run `fn` exclusively for `roomId`, FIFO after any in-flight call for the
 *  same room. A second call awaits the first's completion before `fn` starts.
 *  Returns `fn`'s result. The lock releases even when `fn` throws (SC-104),
 *  and a failed predecessor never rejects its waiter (the held promise
 *  swallows the rejection so the next request's `prev` stays fulfilled). */
export function runExclusive<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const next = prev.then(() => fn().finally(release));
  // Keep the chain alive until `next` settles so a later request sees `held`
  // (not the resolved `prev`) as its predecessor. Swallow rejection so the
  // waiter's `prev` never rejects.
  inFlight.set(roomId, held.then(() => next.then(() => {}, () => {})));
  return next;
}

/** Acquire the per-room lock, returning a promise that resolves when the
 *  caller holds the lock (i.e. after any in-flight predecessor finishes) plus
 *  a release function the caller MUST call when done. FIFO: the returned
 *  promise resolves only after all earlier acquirers have released. */
export function acquireRoomLock(roomId: string): { whenHeld: Promise<void>; release: () => void } {
  const prev = inFlight.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // whenHeld resolves when the predecessor has released — the caller then
  // holds the lock until it calls release(). The inFlight entry is the held
  // promise (resolves on release), so the next acquirer's `prev` waits for it.
  const whenHeld = prev.then(() => undefined);
  inFlight.set(roomId, held);
  return { whenHeld, release };
}

/** What `makeRes` is given. `signal` aborts when the client closes the stream: work that can stop (a provider call) should watch it. */
export interface LockContext {
  signal: AbortSignal;
  /** How long this send waited for the room, in ms (0 when it was free). */
  waitedMs: number;
}

/** A response and, optionally, a promise that settles when the work behind it has stopped. A disconnect aborts the
 *  signal and frees the room only once `finished` settles (or after `graceMs`), so two pipelines never share a session. */
export interface LockedRun {
  response: Response;
  finished?: Promise<void>;
}

export interface LockOptions {
  /** Return an event stream at once, with a `queued` frame first, when the room is busy. Only for call sites whose
   *  responses are event streams (a JSON error made later is turned into an error frame). */
  queued?: boolean;
  /** How long a disconnect waits for the work to stop before the room is freed anyway. Default 5 s. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 5000;
const enc = new TextEncoder();
const frame = (payload: unknown) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`);

/** Wrap a Response factory so the per-room lock is acquired and awaited
 *  BEFORE the Response (and its stream) is created. This matters because Bun
 *  eagerly starts a ReadableStream when it's wrapped in `new Response(stream)` —
 *  so creating the Response before holding the lock would let the stream's
 *  start() (provider query) run before the lock is held, defeating serialization.
 *
 *  The factory is called only once the lock is held. The lock releases when the
 *  response body stream closes (or immediately, if the body is null/empty — e.g.
 *  a JSON error response), when the factory throws, and, after a disconnect, once
 *  the work behind the response has stopped (see `LockedRun`). This makes the lock
 *  span the full SSE pipeline lifetime. A second concurrent request for the same
 *  room queues behind; with `queued` it hears so at once. */
export async function withRoomLock(
  roomId: string,
  makeRes: (ctx: LockContext) => Response | LockedRun | Promise<Response | LockedRun>,
  opts: LockOptions = {},
): Promise<Response> {
  const { whenHeld, release } = acquireRoomLock(roomId);
  const abort = new AbortController();
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const askedAt = Date.now();
  const make = async (): Promise<LockedRun> => {
    const made = await makeRes({ signal: abort.signal, waitedMs: Date.now() - askedAt });
    return made instanceof Response ? { response: made } : made;
  };
  // After a disconnect: stop the work, then free the room once it has stopped (or the grace has passed).
  const freeAfterStop = (finished: Promise<void> | undefined) => {
    abort.abort();
    if (!finished) { release(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => { timer = setTimeout(() => resolve("grace"), graceMs); });
    void Promise.race([finished.then(() => "stopped" as const, () => "stopped" as const), grace]).then((outcome) => {
      clearTimeout(timer);
      if (outcome === "grace") console.warn(`[talk] room ${roomId}: the work did not stop ${graceMs} ms after the client left; freeing the room anyway`);
      release();
    });
  };

  if (opts.queued) {
    const free = await Promise.race([whenHeld.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 0))]);
    if (!free) return queuedResponse(whenHeld, make, release, freeAfterStop);
  }

  await whenHeld;
  let run: LockedRun;
  try {
    run = await make();
  } catch (err) {
    release();
    throw err;
  }
  const res = run.response;
  const body = res.body;
  if (!body) {
    release();
    return res;
  }
  // Pipe through a pass-through stream that releases the lock on close/error.
  // The reader is hoisted so cancel() can call reader.cancel() (not body.cancel())
  // — body is locked by getReader(), so body.cancel() throws "ReadableStream is
  // locked" (Bun unhandledRejection) when the client disconnects mid-stream.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let clientLeft = false;
  const releaseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
      const pump = (): void => {
        reader!.read().then(({ done, value }) => {
          // After a disconnect the room is freed by freeAfterStop, not by the reader ending.
          if (clientLeft) return;
          if (done) { controller.close(); release(); return; }
          controller.enqueue(value);
          pump();
        }).catch((err) => {
          if (clientLeft) return;
          controller.error(err);
          release();
        });
      };
      pump();
    },
    cancel(reason) {
      clientLeft = true;
      freeAfterStop(run.finished);
      return reader ? reader.cancel(reason) : body.cancel(reason);
    },
  });
  return new Response(releaseStream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** The room is busy: answer now with an event stream that says `queued`, then, once the lock is held, carries the real
 *  response. A response that cannot be made, or that is a JSON error, becomes an `error` frame followed by `[DONE]`. */
function queuedResponse(
  whenHeld: Promise<void>,
  make: () => Promise<LockedRun>,
  release: () => void,
  freeAfterStop: (finished: Promise<void> | undefined) => void,
): Response {
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let run: LockedRun | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: Uint8Array) => { try { controller.enqueue(chunk); } catch { cancelled = true; } };
      const end = () => { try { controller.close(); } catch { /* already closed */ } };
      send(frame({ type: "queued" }));
      await whenHeld;
      if (cancelled) { release(); return; }
      // The room is ours: tell the client its send is running now, before the (possibly slow) response is made.
      send(frame({ type: "running" }));
      try {
        run = await make();
      } catch (err) {
        send(frame({ error: err instanceof Error ? err.message : String(err) }));
        send(enc.encode("data: [DONE]\n\n"));
        end();
        release();
        return;
      }
      const res = run.response;
      if (cancelled) {
        // The client left while the response was being made: stop what was started and free the room once it stops.
        freeAfterStop(run.finished);
        void res.body?.cancel().catch(() => {});
        return;
      }
      const isStream = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!res.body || (!isStream && !res.ok)) {
        const detail = res.body ? (await res.text()).slice(0, 500) : res.statusText;
        send(frame({ error: detail || `HTTP ${res.status}` }));
        send(enc.encode("data: [DONE]\n\n"));
        end();
        release();
        return;
      }
      reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          send(value);
        }
      } catch (err) {
        send(frame({ error: err instanceof Error ? err.message : String(err) }));
      }
      // After a disconnect the room is freed by freeAfterStop once the work has stopped.
      if (cancelled) return;
      end();
      release();
    },
    cancel() {
      cancelled = true;
      if (run) {
        freeAfterStop(run.finished);
        return reader?.cancel().catch(() => {});
      }
      // Still waiting for the lock: free it again as soon as it is ours.
      return undefined;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
