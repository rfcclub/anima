import {
  TenantMutationOutbox,
  type TenantMutationClaim,
} from "../../identity-runtime/src/tenant-mutation-outbox.ts";
import { RuntimeEventStore } from "../../../src/identity-runtime/contract/runtime-events.ts";

export type MutationClaim = TenantMutationClaim;

/** Compatibility facade for the fixed-agent outbox API. */
export class MutationOutbox {
  private readonly outbox: TenantMutationOutbox;

  constructor(
    store: RuntimeEventStore,
    private readonly agentId: string,
  ) {
    this.outbox = new TenantMutationOutbox(store);
  }

  claim(leaseId: string, operation: string, idempotencyKey: string): MutationClaim {
    return this.outbox.claim(this.agentId, leaseId, operation, idempotencyKey);
  }

  complete(
    leaseId: string,
    operation: string,
    idempotencyKey: string,
    result: Record<string, unknown>,
  ): void {
    this.outbox.complete(this.agentId, leaseId, operation, idempotencyKey, result);
  }

  hasPending(): boolean {
    return this.outbox.hasPending(this.agentId);
  }
}
