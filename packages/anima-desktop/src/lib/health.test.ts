import { describe, test, expect } from "bun:test";
import {
  HealthMonitor,
  HEALTHY_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  type HealthEvent,
} from "./health";

/** Deterministic harness: manual clock + scripted probe results. */
function harness(results: Array<boolean | (() => boolean)>) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const events: HealthEvent[] = [];
  let call = 0;

  const monitor = new HealthMonitor({
    probe: async () => {
      const r = results[Math.min(call, results.length - 1)]!;
      call++;
      return typeof r === "function" ? r() : r;
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    onEvent: (e) => events.push(e),
  });

  /** Advance the clock, firing due timers (and awaiting probe settls). */
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
    now = target;
  }
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  return { monitor, events, advance, flush, probeCalls: () => call };
}

describe("HealthMonitor", () => {
  test("healthy start → connected, polls every 30s", async () => {
    const h = harness([true]);
    await h.monitor.start();
    await h.flush();
    expect(h.events).toEqual([{ status: "connected" }]);
    await h.advance(HEALTHY_INTERVAL_MS);
    await h.advance(HEALTHY_INTERVAL_MS);
    expect(h.probeCalls()).toBe(3);
    // no duplicate events while status unchanged
    expect(h.events).toEqual([{ status: "connected" }]);
  });

  test("failure → reconnecting, retries every 5s", async () => {
    const h = harness([false]);
    await h.monitor.start();
    await h.flush();
    expect(h.events).toEqual([{ status: "reconnecting" }]);
    await h.advance(RETRY_INTERVAL_MS);
    await h.advance(RETRY_INTERVAL_MS);
    expect(h.probeCalls()).toBe(3);
  });

  test("recovery emits connected with recovered flag", async () => {
    const h = harness([false, true]);
    await h.monitor.start();
    await h.flush();
    await h.advance(RETRY_INTERVAL_MS);
    expect(h.events).toEqual([
      { status: "reconnecting" },
      { status: "connected", recovered: true },
    ]);
  });

  test("degradation then recovery sequence", async () => {
    const h = harness([true, false, false, true]);
    await h.monitor.start();
    await h.flush();
    await h.advance(HEALTHY_INTERVAL_MS); // probe 2: fail
    await h.advance(RETRY_INTERVAL_MS); // probe 3: fail (no dup event)
    await h.advance(RETRY_INTERVAL_MS); // probe 4: recover
    expect(h.events).toEqual([
      { status: "connected" },
      { status: "reconnecting" },
      { status: "connected", recovered: true },
    ]);
  });

  test("stop cancels pending timers", async () => {
    const h = harness([true]);
    await h.monitor.start();
    await h.flush();
    h.monitor.stop();
    await h.advance(HEALTHY_INTERVAL_MS * 3);
    expect(h.probeCalls()).toBe(1);
  });

  test("start after stop restarts cleanly", async () => {
    const h = harness([true]);
    await h.monitor.start();
    await h.flush();
    h.monitor.stop();
    await h.monitor.start();
    await h.flush();
    expect(h.probeCalls()).toBe(2);
  });
});
