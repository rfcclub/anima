import { test, expect, describe } from "bun:test";
import { BeatLimitError, ClientLeftError, beatLimitMs, beatGraceMs, createBeatGuard, guarded } from "../../src/ui/features/town/api/beat-guard";

// A beat (one speaker's provider run) is bounded and stops when the client leaves.

async function* chunks(...xs: string[]) { for (const x of xs) yield { type: "text" as const, content: x }; }
async function* never(): AsyncGenerator<{ type: "text"; content: string }> { await new Promise(() => {}); }
const collect = async (gen: AsyncGenerator<{ type: "text"; content?: string }>) => { const out: string[] = []; for await (const c of gen) out.push(c.content ?? ""); return out; };

describe("beatLimitMs", () => {
  test("defaults to ten minutes, reads ANIMA_TALK_BEAT_TIMEOUT_MS, ignores nonsense", () => {
    expect(beatLimitMs({})).toBe(600_000);
    expect(beatLimitMs({ ANIMA_TALK_BEAT_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(beatLimitMs({ ANIMA_TALK_BEAT_TIMEOUT_MS: "abc" })).toBe(600_000);
    expect(beatLimitMs({ ANIMA_TALK_BEAT_TIMEOUT_MS: "0" })).toBe(600_000);
  });
});

describe("beatGraceMs", () => {
  test("defaults to five seconds, reads ANIMA_TALK_STOP_GRACE_MS, ignores nonsense", () => {
    expect(beatGraceMs({})).toBe(5000);
    expect(beatGraceMs({ ANIMA_TALK_STOP_GRACE_MS: "250" })).toBe(250);
    expect(beatGraceMs({ ANIMA_TALK_STOP_GRACE_MS: "0" })).toBe(0);
    expect(beatGraceMs({ ANIMA_TALK_STOP_GRACE_MS: "-1" })).toBe(5000);
    expect(beatGraceMs({ ANIMA_TALK_STOP_GRACE_MS: "abc" })).toBe(5000);
  });
});

describe("guarded", () => {
  test("passes the chunks of a beat that finishes in time", async () => {
    const client = new AbortController();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 1000 });
    expect(await collect(guarded(chunks("a", "b"), guard))).toEqual(["a", "b"]);
    guard.done();
    expect(guard.signal.aborted).toBe(false);
  });

  test("SC-4: a beat that runs past the limit throws a BeatLimitError that names the limit, and aborts its signal", async () => {
    const client = new AbortController();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 40, graceMs: 20 });
    const err = await collect(guarded(never(), guard)).catch((e) => e);
    expect(err).toBeInstanceOf(BeatLimitError);
    expect((err as Error).message).toContain("40 ms");
    expect(guard.signal.aborted).toBe(true);
  });

  test("SC-2: a client that leaves stops the beat with a ClientLeftError and aborts its signal", async () => {
    const client = new AbortController();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 10_000, graceMs: 20 });
    const pending = collect(guarded(never(), guard)).catch((e) => e);
    setTimeout(() => client.abort(), 10);
    expect(await pending).toBeInstanceOf(ClientLeftError);
    expect(guard.signal.aborted).toBe(true);
  });

  test("a client that has already left stops the beat before it starts", async () => {
    const client = new AbortController();
    client.abort();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 10_000, graceMs: 20 });
    expect(await collect(guarded(chunks("a"), guard)).catch((e) => e)).toBeInstanceOf(ClientLeftError);
  });

  test("elapsedMs counts from the start of the beat", async () => {
    const client = new AbortController();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(guard.elapsedMs()).toBeGreaterThanOrEqual(25);
    guard.done();
  });

  test("regression: the iteration ends only once a provider that honours the signal has stopped", async () => {
    const client = new AbortController();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 30, graceMs: 2000 });
    let stopped = false;
    async function* honours(): AsyncGenerator<{ type: "text"; content: string }> {
      try {
        await new Promise<void>((resolve) => guard.signal.addEventListener("abort", () => setTimeout(resolve, 60), { once: true }));
        yield { type: "text", content: "late" };
      } finally { stopped = true; }
    }
    const startedAt = Date.now();
    const err = await collect(guarded(honours(), guard)).catch((e) => e);
    expect(err).toBeInstanceOf(BeatLimitError);
    expect(stopped).toBe(true); // the room is freed after this, so the provider call is really over
    expect(Date.now() - startedAt).toBeLessThan(1500); // and the grace was not waited out
  });

  test("regression: a provider that ignores the signal is waited for only for the grace, with a warning", async () => {
    const client = new AbortController();
    const guard = createBeatGuard({ signal: client.signal, limitMs: 20, graceMs: 120 });
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    const startedAt = Date.now();
    try {
      const err = await collect(guarded(never(), guard)).catch((e) => e);
      expect(err).toBeInstanceOf(BeatLimitError);
    } finally { console.warn = warn; }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
    expect(warns.join("\n")).toContain("did not stop");
  });
});
