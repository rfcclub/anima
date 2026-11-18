/**
 * continuity-core — Continuity-plane port contracts (port contracts).
 *
 * Types only. Zero runtime imports — mirrors `src/memory/contract.ts` discipline
 * so this module can be imported anywhere (including from `src/continuity/` or
 * `src/narrative/`) without pulling in adapters, sqlite, or crypto.
 */

export type LockedScope = "identity" | "private" | "heartwood";

/**
 * Versions the identity *inputs* that produced a projection, split into a
 * surface/compile-agnostic `stateHash` and a per-compile `projectionId`.
 * The split keeps the hash stable across surfaces and compiles.
 */
export interface ProjectionManifest {
  agentId: string;

  // ── stateHash inputs (surface- and compile-agnostic) ──
  kernelVersion: string;
  cartridgeVersions: Record<string, string>;
  substrateViewVersion: string;
  /** Per-scope append-only revision counter, as a string (sentinel `"0"`). */
  memoryDomainVersions: Record<LockedScope, string>;
  stateHash: string;

  // ── projectionId inputs (per-compile metadata, NOT in stateHash) ──
  surfaceId: string;
  compiledAt: number;
  promptStaticHash: string;
  projectionId: string;
}

/**
 * A scoped, time-bounded capability record. Not an identity lock — multiple
 * concurrent leases per agent are legal.
 */
export interface IncarnationLease {
  leaseId: string;
  agentId: string;
  surfaceId: string;
  issuedAt: number;
  expiresAt: number;
  idempotencyNamespace: string;
  baseManifest: ProjectionManifest;
  readScopes: string[];
  writeScopes: string[];
  /** Subset of LOCKED_SCOPES this lease may *propose* into (never widens writeScopes). */
  proposalScopes: LockedScope[];
  releasedAt?: number;
}

export type ProposalStatus = "held" | "rejected" | "promoted" | "stale";

export interface IdentityProposal {
  proposalId: string;
  leaseId: string;
  agentId: string;
  scope: LockedScope;
  content: string;
  evidence: string[];
  stateHash: string;
  idempotencyKey: string;
  status: ProposalStatus;
  reason?: string;
  createdAt: number;
  decidedAt?: number;
}

export interface PromotionReceipt {
  receiptId: string;
  proposalId: string;
  promotedEntryId: string;
  domain: LockedScope;
  baseVersion: string;
  newVersion: string;
  approver: string;
  createdAt: number;
}

export interface ProposeInput {
  scope: LockedScope;
  content: string;
  evidence: string[];
  idempotencyKey: string;
  /** Caller-asserted state — validated against `lease.baseManifest.stateHash`. */
  stateHash: string;
}

/** The only path for reading/writing scoped memory through a minted lease. */
export interface ContinuityPort {
  /** Reads are restricted to the intersection of requested scopes and `lease.readScopes`. */
  recall(lease: IncarnationLease, query: string, scopes?: string[]): Promise<unknown[]>;
  propose(lease: IncarnationLease, input: ProposeInput): Promise<IdentityProposal>;
  promote(proposalId: string, approver: string): Promise<PromotionReceipt>;
}

/** Joins an agent into a projection + lease for a given surface. */
export interface IncarnationPort {
  join(
    agentId: string,
    surfaceId: string,
  ): Promise<{
    prompt: { full: string; staticPrefix: string; dynamicSuffix: string; staticHash: string };
    manifest: ProjectionManifest;
    lease: IncarnationLease;
  }>;
}

/** Pure builder: state-input strings/tuples in, ProjectionManifest out. No I/O. */
export interface ProjectionManifestCompiler {
  compile(input: {
    agentId: string;
    surfaceId: string;
    kernelVersion: string;
    cartridgeVersions: Record<string, string>;
    substrateViewVersion: string;
    memoryDomainVersions: Record<LockedScope, string>;
    promptStaticHash: string;
    compiledAt: number;
  }): ProjectionManifest;
}

/** Reference gate: propose -> deterministic validate -> held -> explicit promote -> receipt. */
export interface ProposalPromoter {
  propose(lease: IncarnationLease, input: ProposeInput): Promise<IdentityProposal>;
  promote(proposalId: string, approver: string): Promise<PromotionReceipt>;
}
