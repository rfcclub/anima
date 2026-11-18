import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";
import type { IdentityProposal, ProposeInput } from "@anima/continuity-core";
import type { CanonicalSubstrateScope, IdentityRuntimeRecallResponse } from "../../../src/identity-runtime/contract/scope-mapper.ts";

export interface SessionRecallRequest {
  query: string;
  substrateScope: string;
}

interface ResolvedSessionRecallRequest extends SessionRecallRequest { declaredScopes: readonly CanonicalSubstrateScope[]; }

export interface SessionRememberRequest {
  stateHash: string;
  idempotencyKey: string;
  entry: Omit<AgentMemoryEntry, "id" | "createdAt">;
}

interface IdentitySessionPort {
  recall(request: ResolvedSessionRecallRequest): Promise<IdentityRuntimeRecallResponse<unknown>>;
  remember(request: SessionRememberRequest): Promise<AgentMemoryEntry>;
  propose(input: ProposeInput): Promise<IdentityProposal>;
}

/** A lease-bound client capability. It intentionally contains no raw store or writer. */
export class IdentitySession {
  constructor(
    readonly leaseId: string,
    private readonly port: IdentitySessionPort,
    private readonly declaredScopes: readonly CanonicalSubstrateScope[],
  ) {}

  recall(request: SessionRecallRequest): Promise<IdentityRuntimeRecallResponse<unknown>> {
    return this.port.recall({ query: request.query, substrateScope: request.substrateScope, declaredScopes: this.declaredScopes });
  }

  remember(request: SessionRememberRequest): Promise<AgentMemoryEntry> {
    return this.port.remember(request);
  }

  propose(input: ProposeInput): Promise<IdentityProposal> {
    return this.port.propose(input);
  }
}
