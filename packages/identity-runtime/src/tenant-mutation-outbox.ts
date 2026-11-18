import { RuntimeEventStore } from "../../../src/identity-runtime/contract/runtime-events.ts";

export type TenantMutationClaim = "claimed" | "pending" | { result: Record<string, unknown> };

/** Durable, restart-safe idempotency boundary for every registered tenant. */
export class TenantMutationOutbox {
  constructor(private readonly store: RuntimeEventStore) {}

  claim(
    agentId: string,
    leaseId: string,
    operation: string,
    idempotencyKey: string,
    now?: number,
  ): TenantMutationClaim {
    return this.store.claimMutation(agentId, leaseId, operation, idempotencyKey, now);
  }

  complete(
    agentId: string,
    leaseId: string,
    operation: string,
    idempotencyKey: string,
    result: Record<string, unknown>,
  ): void {
    this.store.completeMutation(agentId, leaseId, operation, idempotencyKey, result);
  }

  /** Release a claimed row whose write was proven never to have happened. */
  abandon(agentId: string, leaseId: string, operation: string, idempotencyKey: string): void {
    this.store.abandonMutation(agentId, leaseId, operation, idempotencyKey);
  }

  hasPending(agentId: string): boolean {
    return this.store.hasPendingMutation(agentId);
  }

  /** Stuck rows for this agent, for a recovery tool to inspect and abandon. */
  pending(agentId: string): Array<{ leaseId: string; operation: string; idempotencyKey: string; createdAt: number }> {
    return this.store.pendingMutations(agentId);
  }
}
