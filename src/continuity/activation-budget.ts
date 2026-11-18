import { type ActivationCostClass } from "./activation-candidate";
import { ActivationStore } from "./activation-store";

export interface BudgetGrant {
  leaseId: string;
  agentId: string;
  executor: string;
  costClass: ActivationCostClass;
  units: number;
  expiresAt: number;
}

export interface ActivationBudgetPolicy {
  colonyDailyLimit: number;
  agentDailyLimit: number;
  grantTtlMs?: number;
}

export type BudgetResult = { ok: true; grant: BudgetGrant } | { ok: false; reason: "agent-budget" | "colony-budget" };

const COST_UNITS: Record<ActivationCostClass, number> = { T0: 0, T1: 1, T2: 10 };

export class ActivationBudget {
  constructor(private readonly store: ActivationStore, private readonly policy: ActivationBudgetPolicy) {}

  reserve(input: { leaseId: string; agentId: string; executor: string; costClass: ActivationCostClass; now: number }): BudgetResult {
    const units = COST_UNITS[input.costClass];
    const grant: BudgetGrant = {
      ...input,
      units,
      expiresAt: input.now + (this.policy.grantTtlMs ?? 5 * 60_000),
    };
    if (units === 0) return { ok: true, grant };
    const result = this.store.reserveBudget({
      leaseId: input.leaseId,
      day: utcDay(input.now),
      agentId: input.agentId,
      units,
      colonyLimit: this.policy.colonyDailyLimit,
      agentLimit: this.policy.agentDailyLimit,
      now: input.now,
    });
    return result.ok ? { ok: true, grant } : result;
  }

  settle(leaseId: string, now: number): boolean { return this.store.settleBudget(leaseId, now); }
  release(leaseId: string, now: number): boolean { return this.store.releaseBudget(leaseId, now); }

  isValidGrant(grant: BudgetGrant | undefined, expected: { agentId: string; executor: string; now: number }): grant is BudgetGrant {
    return Boolean(grant && grant.agentId === expected.agentId && grant.executor === expected.executor && grant.expiresAt > expected.now);
  }
}

function utcDay(now: number): string { return new Date(now).toISOString().slice(0, 10); }
