import { describe, test, expect } from "bun:test";
import { createHealthPoller, POLL_INTERVAL_MS } from "./poller";

function harness(script: boolean[]) {
  let now = 0;
  let call = 0;
  const statuses: Array<"connected" | "disconnected"> = [];
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;

  const poller = createHealthPoller({
    probe: async () => script[Math.min(call++, script.length - 1)]!,
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });

  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
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

  return { poller, statuses, advance, flush, probeCalls: () => call };
}

describe("createHealthPoller", () => {
  test("polls every 10 seconds", async () => {
    expect(POLL_INTERVAL_MS).toBe(10_000);
    const h = harness([true]);
    await h.poller.start();
    await h.flush();
    await h.advance(POLL_INTERVAL_MS);
    await h.advance(POLL_INTERVAL_MS);
    expect(h.probeCalls()).toBe(3);
  });

  test("emits connected on success, disconnected on failure (transitions only)", async () => {
    const h = harness([true, true, false, true]);
    await h.poller.start();
    await h.flush();
    await h.advance(POLL_INTERVAL_MS); // ok (no dup)
    await h.advance(POLL_INTERVAL_MS); // fail
    await h.advance(POLL_INTERVAL_MS); // ok
    expect(h.statuses).toEqual(["connected", "disconnected", "connected"]);
  });

  test("restart() probes immediately — settings change takes effect at once", async () => {
    const h = harness([true]);
    await h.poller.start();
    await h.flush();
    expect(h.probeCalls()).toBe(1);
    await h.poller.restart();
    await h.flush();
    expect(h.probeCalls()).toBe(2); // no 10s wait
  });

  test("stop() halts polling", async () => {
    const h = harness([true]);
    await h.poller.start();
    await h.flush();
    h.poller.stop();
    await h.advance(POLL_INTERVAL_MS * 5);
    expect(h.probeCalls()).toBe(1);
  });
});
