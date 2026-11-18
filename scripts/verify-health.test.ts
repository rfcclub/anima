import { expect, test } from "bun:test";
import { verifyHealth } from "./verify-health.ts";

function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms) => { calls.push(ms); };
}

test("returns true immediately when the first check succeeds", async () => {
  let calls = 0;
  const fetcher = (async () => { calls += 1; return new Response("ok", { status: 200 }); }) as unknown as typeof fetch;

  const ok = await verifyHealth("http://x/health", { fetcher, sleep: fakeSleep([]) });

  expect(ok).toBe(true);
  expect(calls).toBe(1);
});

test("retries on failure and succeeds once the service comes up", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return calls < 3 ? new Response("down", { status: 503 }) : new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];

  const ok = await verifyHealth("http://x/health", { fetcher, sleep: fakeSleep(sleeps), retries: 5, delayMs: 250 });

  expect(ok).toBe(true);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([250, 250]); // slept between attempts 1→2 and 2→3, not after success
});

test("returns false after exhausting retries, including when fetch throws", async () => {
  const fetcher = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

  const ok = await verifyHealth("http://x/health", { fetcher, sleep: fakeSleep([]), retries: 3, delayMs: 10 });

  expect(ok).toBe(false);
});
