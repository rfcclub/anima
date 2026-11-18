/**
 * Health-poll reconnect state machine.
 *
 * Healthy → probe every 30s. Unhealthy → probe every 5s until recovery.
 * Emits an event only on status *transitions*; recovery carries
 * `recovered: true` so the UI can reload iframes.
 *
 * Timers and the probe are injected so the machine is fully testable.
 */

export const HEALTHY_INTERVAL_MS = 30_000;
export const RETRY_INTERVAL_MS = 5_000;

export type HealthStatus = "connected" | "reconnecting";

export interface HealthEvent {
  status: HealthStatus;
  recovered?: boolean;
}

export interface HealthMonitorDeps {
  /** Returns true when the server is reachable/healthy. Must not throw. */
  probe: () => Promise<boolean>;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  onEvent: (event: HealthEvent) => void;
}

export class HealthMonitor {
  private deps: HealthMonitorDeps;
  private timerId: number | null = null;
  private status: HealthStatus | null = null;
  private running = false;

  constructor(deps: HealthMonitorDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    this.stop();
    this.running = true;
    this.status = null;
    await this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      this.deps.clearTimer(this.timerId);
      this.timerId = null;
    }
  }

  /** Force an immediate re-probe (e.g. after a settings change). */
  async checkNow(): Promise<void> {
    if (!this.running) return;
    if (this.timerId !== null) {
      this.deps.clearTimer(this.timerId);
      this.timerId = null;
    }
    await this.tick();
  }

  private async tick(): Promise<void> {
    const healthy = await this.deps.probe();
    if (!this.running) return;

    const next: HealthStatus = healthy ? "connected" : "reconnecting";
    if (next !== this.status) {
      const wasDown = this.status === "reconnecting";
      this.status = next;
      if (next === "connected" && wasDown) {
        this.deps.onEvent({ status: "connected", recovered: true });
      } else {
        this.deps.onEvent({ status: next });
      }
    }

    const delay = healthy ? HEALTHY_INTERVAL_MS : RETRY_INTERVAL_MS;
    this.timerId = this.deps.setTimer(() => {
      void this.tick();
    }, delay);
  }
}
