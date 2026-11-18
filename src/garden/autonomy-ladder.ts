import { createGardenEvent, type GardenRuntime } from "./events";
import type { JsonlGardenEventStore } from "./event-store";

export type ActionClass = "code-change" | "deploy" | "substrate-write" | "identity-change" | "review";
export type AutonomyLevel = 0 | 1 | 2 | 3;

export interface AutonomyState {
  agentId: string;
  actionClass: ActionClass;
  level: AutonomyLevel;
  successCount: number;
  violationCount: number;
  promotedAt: string;
  demotedAt?: string;
}

export interface AutonomyChangePayload {
  agentId: string;
  actionClass: ActionClass;
  from: AutonomyLevel;
  to: AutonomyLevel;
  reason: string;
}

export interface AutonomyLadderOptions {
  store: JsonlGardenEventStore;
  project: string;
  instanceId?: string;
  runtime?: GardenRuntime;
  now?: () => string;
  id?: () => string;
}

// Cumulative successes (with 0 violations) required to reach the next level.
const PROMOTION_THRESHOLDS: Partial<Record<AutonomyLevel, number>> = {
  0: 10,
  1: 50,
  2: 100,
};

export interface AutonomySeed {
  agentId: string;
  actionClass: ActionClass;
  level: AutonomyLevel;
}

export class AutonomyLadder {
  private readonly states = new Map<string, AutonomyState>();
  private readonly peerReviewed = new Set<string>();

  constructor(private readonly options: AutonomyLadderOptions) {}

  /** Set initial levels for known agents. Only applies if agent has no existing state. */
  async seed(seeds: AutonomySeed[]): Promise<void> {
    for (const s of seeds) {
      const k = key(s.agentId, s.actionClass);
      if (this.states.has(k)) continue; // don't override existing state
      const state: AutonomyState = {
        agentId: s.agentId,
        actionClass: s.actionClass,
        level: s.level,
        successCount: 0,
        violationCount: 0,
        promotedAt: this.now(),
      };
      this.states.set(k, state);
      await this.emitChange({
        agentId: s.agentId,
        actionClass: s.actionClass,
        from: 0,
        to: s.level,
        reason: `seeded at L${s.level}`,
      });
    }
  }

  getLevel(agentId: string, actionClass: ActionClass): AutonomyLevel {
    return this.stateFor(agentId, actionClass).level;
  }

  getState(agentId: string, actionClass: ActionClass): AutonomyState {
    return { ...this.stateFor(agentId, actionClass) };
  }

  isAllowed(agentId: string, actionClass: ActionClass): boolean {
    return this.getLevel(agentId, actionClass) >= 1;
  }

  requiresApproval(agentId: string, actionClass: ActionClass): boolean {
    return this.getLevel(agentId, actionClass) === 0;
  }

  approvePeerReview(agentId: string, actionClass: ActionClass): void {
    this.peerReviewed.add(key(agentId, actionClass));
  }

  async recordSuccess(agentId: string, actionClass: ActionClass): Promise<void> {
    const state = this.stateFor(agentId, actionClass);
    state.successCount += 1;
    if (state.violationCount > 0) return;

    const threshold = PROMOTION_THRESHOLDS[state.level];
    if (threshold === undefined || state.successCount < threshold) return;
    if (state.level === 2 && !this.peerReviewed.has(key(agentId, actionClass))) return;

    const from = state.level;
    const to = (state.level + 1) as AutonomyLevel;
    const reason = to === 3
      ? `${state.successCount} successes, peer review approved`
      : `${state.successCount} successes, 0 violations`;
    state.level = to;
    state.promotedAt = this.now();
    await this.emitChange({ agentId, actionClass, from, to, reason });
  }

  async recordViolation(agentId: string, actionClass: ActionClass): Promise<void> {
    const state = this.stateFor(agentId, actionClass);
    state.violationCount += 1;
    if (state.level === 0) return;

    const from = state.level;
    const to = (state.level - 1) as AutonomyLevel;
    state.level = to;
    state.demotedAt = this.now();
    state.successCount = 0;
    state.violationCount = 0;
    this.peerReviewed.delete(key(agentId, actionClass));
    await this.emitChange({ agentId, actionClass, from, to, reason: "violation recorded" });
  }

  async hydrate(): Promise<void> {
    const events = await this.options.store.readAll({
      project: this.options.project,
      type: "AUTONOMY_CHANGE",
    });
    for (const event of events) {
      const payload = event.payload as AutonomyChangePayload;
      const state = this.stateFor(payload.agentId, payload.actionClass);
      state.level = payload.to;
      if (payload.to > payload.from) {
        state.promotedAt = event.timestamp;
      } else {
        state.demotedAt = event.timestamp;
      }
    }
  }

  private stateFor(agentId: string, actionClass: ActionClass): AutonomyState {
    const stateKey = key(agentId, actionClass);
    let state = this.states.get(stateKey);
    if (!state) {
      state = {
        agentId,
        actionClass,
        level: 0,
        successCount: 0,
        violationCount: 0,
        promotedAt: this.now(),
      };
      this.states.set(stateKey, state);
    }
    return state;
  }

  private async emitChange(payload: AutonomyChangePayload): Promise<void> {
    await this.options.store.append(createGardenEvent({
      id: this.nextId(),
      type: "AUTONOMY_CHANGE",
      timestamp: this.now(),
      agentId: payload.agentId,
      instanceId: this.options.instanceId ?? "garden-hub",
      runtime: this.options.runtime ?? "hub",
      project: this.options.project,
      payload,
      confidence: "high",
    }));
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  private nextId(): string {
    return (this.options.id ?? (() => crypto.randomUUID()))();
  }
}

function key(agentId: string, actionClass: ActionClass): string {
  return `${agentId}:${actionClass}`;
}
