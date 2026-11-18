/**
 * 10-second health poller. Emits status only on transitions.
 * Timers and the probe are injected for testability.
 */

export const POLL_INTERVAL_MS = 10_000;

export type PollStatus = "connected" | "disconnected";

export interface PollerDeps {
  /** Returns true when the backend is healthy. Must not throw. */
  probe: () => Promise<boolean>;
  onStatus: (status: PollStatus) => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

export interface HealthPoller {
  start(): Promise<void>;
  /** Cancel any pending wait and probe immediately (e.g. URL changed). */
  restart(): Promise<void>;
  stop(): void;
}

export function createHealthPoller(deps: PollerDeps): HealthPoller {
  let timerId: number | null = null;
  let running = false;
  let last: PollStatus | null = null;

  const clear = () => {
    if (timerId !== null) {
      deps.clearTimer(timerId);
      timerId = null;
    }
  };

  async function tick(): Promise<void> {
    const healthy = await deps.probe();
    if (!running) return;
    const status: PollStatus = healthy ? "connected" : "disconnected";
    if (status !== last) {
      last = status;
      deps.onStatus(status);
    }
    timerId = deps.setTimer(() => {
      void tick();
    }, POLL_INTERVAL_MS);
  }

  return {
    async start() {
      clear();
      running = true;
      last = null;
      await tick();
    },
    async restart() {
      clear();
      running = true;
      last = null; // re-emit status for the new target
      await tick();
    },
    stop() {
      running = false;
      clear();
    },
  };
}
