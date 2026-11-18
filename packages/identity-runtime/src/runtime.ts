import { randomUUID } from "node:crypto";
import type { AgentMemoryEntry, AgentMemoryStore, MemoryScope } from "../../../src/memory/contract.ts";
import { MemoryScopeViolationError } from "../../../src/memory/scoped-store.ts";
import { ContinuityAdapter } from "../../../src/memory/continuity-adapter.ts";
import {
  buildManifest,
  DomainRevisions,
  LeaseStore,
  assertProjectionCompileRequest,
  type IdentityProposal,
  type IncarnationLease,
  type LockedScope,
  type ProjectionCompileRequest,
  type PromotionReceipt,
  type ProposeInput,
} from "@anima/continuity-core";
import { IdentitySession, type SessionRecallRequest, type SessionRememberRequest } from "./identity-session.ts";
import { RuntimeEventStore, type IdentityRuntimeEvent, type RuntimeEventKind } from "../../../src/identity-runtime/contract/runtime-events.ts";
import { ScopeMapper, type CanonicalSubstrateScope, type IdentityRuntimeRecallResponse } from "../../../src/identity-runtime/contract/scope-mapper.ts";
import type { RuntimeJoinRequest, RuntimeProjection } from "../../../src/identity-runtime/contract/runtime-projection.ts";

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

export class StaleMutationError extends Error {
  constructor() {
    super("mutation stateHash does not match the lease projection state");
    this.name = "StaleMutationError";
  }
}

export interface IdentityRuntimeOptions {
  agentId: string;
  dbPath: string;
  rawStore: AgentMemoryStore;
  /**
   * The composition root supplies this seam. Legacy callers may still pass a
   * join envelope while they migrate; canary callers pass the explicit compile
   * envelope and are validated below before any lease is minted.
   */
  composeProjection(request: RuntimeJoinRequest | ProjectionCompileRequest): Promise<RuntimeProjection>;
  now?: () => number;
  idGenerator?: () => string;
  leaseTtlMs?: number;
}

export interface JoinIdentityResponse {
  projection: string;
  projectionId: string;
  stateHash: string;
  leaseId: string;
  expiresAt: number;
  scopeDeclarationStatus: RuntimeProjection["scopeDeclarationStatus"];
  session: IdentitySession;
}

export interface RuntimeJoinComposition {
  compile?: ProjectionCompileRequest;
  /** A canonical compiler output may be handed to the runtime exactly once. */
  projection?: RuntimeProjection;
}

/**
 * The sole composition root that receives raw storage. It exports only
 * `IdentitySession` capabilities, never storage or privileged writers.
 */
export class IdentityRuntime {
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly leaseTtlMs: number;
  private readonly leaseStore: LeaseStore;
  private readonly domainRevisions: DomainRevisions;
  private readonly continuity: ContinuityAdapter;
  private readonly eventsStore: RuntimeEventStore;
  private readonly mapper = new ScopeMapper();
  private readonly declaredScopesByLease = new Map<string, readonly CanonicalSubstrateScope[]>();
  private readonly clientIdByLease = new Map<string, string>();

  constructor(private readonly options: IdentityRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.generateId = options.idGenerator ?? randomUUID;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.leaseStore = new LeaseStore(options.dbPath);
    this.domainRevisions = new DomainRevisions(options.dbPath);
    this.continuity = new ContinuityAdapter(
      options.rawStore,
      this.leaseStore,
      this.domainRevisions,
      options.dbPath,
      this.now,
    );
    this.eventsStore = new RuntimeEventStore(options.dbPath);
  }

  get agentId(): string { return this.options.agentId; }

  async join(request: RuntimeJoinRequest, input?: ProjectionCompileRequest | RuntimeJoinComposition): Promise<JoinIdentityResponse> {
    if (!request.clientId || !request.surfaceId) throw new Error("clientId and surfaceId are required");
    if (this.eventsStore.hasPendingMutation(this.options.agentId)) {
      throw new Error("identity runtime mutation recovery required");
    }

    const compileRequest = isProjectionCompileRequest(input) ? input : input?.compile;
    const suppliedProjection = isProjectionCompileRequest(input) ? undefined : input?.projection;
    if (compileRequest) {
      assertProjectionCompileRequest(compileRequest);
      if (compileRequest.identity !== this.options.agentId) {
        throw new Error("compile identity does not match runtime identity");
      }
      if (compileRequest.surfaceId !== request.surfaceId) {
        throw new Error("compile surface does not match join surface");
      }
    }
    if (suppliedProjection) assertRuntimeProjection(suppliedProjection);
    const projection = suppliedProjection ?? await this.options.composeProjection(compileRequest ?? request);
    const now = this.now();
    const manifest = buildManifest({
      agentId: this.options.agentId,
      kernelVersion: projection.kernelVersion,
      cartridgeVersions: projection.cartridgeVersions,
      substrateViewVersion: versionedSubstrateView(projection.substrateViewVersion, this.eventsStore.revision(this.options.agentId)),
      memoryDomainVersions: {
        identity: this.domainRevisions.getRevision(this.options.agentId, "identity"),
        private: this.domainRevisions.getRevision(this.options.agentId, "private"),
        heartwood: this.domainRevisions.getRevision(this.options.agentId, "heartwood"),
      },
      surfaceId: request.surfaceId,
      compiledAt: now,
      promptStaticHash: projection.promptStaticHash,
    });
    const leaseId = this.generateId();
    const lease = this.leaseStore.mint({
      leaseId,
      agentId: this.options.agentId,
      surfaceId: request.surfaceId,
      baseManifest: manifest,
      readScopes: projection.readScopes,
      writeScopes: projection.writeScopes,
      proposalScopes: projection.proposalScopes,
      idempotencyNamespace: `${this.options.agentId}:${request.surfaceId}:${leaseId}`,
      issuedAt: now,
      expiresAt: now + this.leaseTtlMs,
    });
    this.declaredScopesByLease.set(lease.leaseId, projection.declaredSubstrateScopes);
    this.clientIdByLease.set(lease.leaseId, request.clientId);
    const session = new IdentitySession(lease.leaseId, {
      recall: (input) => this.recallForLease(lease, request.clientId, input),
      remember: (input) => this.rememberForLease(lease, request.clientId, input),
      propose: (input) => this.proposeForLease(lease, request.clientId, input),
    }, projection.declaredSubstrateScopes);
    this.record("join", lease, request.clientId, "issued");
    return {
      projection: projection.prompt,
      projectionId: manifest.projectionId,
      stateHash: manifest.stateHash,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      scopeDeclarationStatus: projection.scopeDeclarationStatus,
      session,
    };
  }

  events(input: { limit: number }): IdentityRuntimeEvent[] {
    return this.eventsStore.list(this.options.agentId, input.limit);
  }

  eventsForLease(leaseId: string, clientId: string, limit: number): IdentityRuntimeEvent[] {
    const lease = this.activeLease(leaseId);
    this.requireClient(leaseId, clientId);
    return this.eventsStore.listForLease(this.options.agentId, lease.leaseId, limit);
  }

  async propose(leaseId: string, input: ProposeInput): Promise<IdentityProposal> {
    const lease = this.activeLease(leaseId);
    return this.proposeForLease(lease, this.clientIdByLease.get(leaseId) ?? lease.surfaceId, input);
  }

  async recall(leaseId: string, request: SessionRecallRequest): Promise<IdentityRuntimeRecallResponse<unknown>> {
    const lease = this.activeLease(leaseId);
    const declaredScopes = this.declaredScopesByLease.get(leaseId);
    if (!declaredScopes) throw new Error("lease scope declarations unavailable");
    return this.recallForLease(lease, this.clientIdByLease.get(leaseId) ?? lease.surfaceId, { ...request, declaredScopes });
  }

  async remember(leaseId: string, request: SessionRememberRequest): Promise<AgentMemoryEntry> {
    const lease = this.activeLease(leaseId);
    return this.rememberForLease(lease, this.clientIdByLease.get(leaseId) ?? lease.surfaceId, request);
  }

  proposalStatus(proposalId: string): { proposalId: string; status: IdentityProposal["status"] } | undefined {
    const proposal = this.continuity.proposalStatus(proposalId);
    return proposal ? { proposalId: proposal.proposalId, status: proposal.status } : undefined;
  }

  proposalStatusForLease(proposalId: string, leaseId: string): { proposalId: string; status: IdentityProposal["status"] } | undefined {
    const proposal = this.continuity.proposalStatus(proposalId);
    if (!proposal || proposal.leaseId !== leaseId) return undefined;
    return { proposalId: proposal.proposalId, status: proposal.status };
  }

  async promote(proposalId: string, approver: string): Promise<PromotionReceipt> {
    const proposal = this.continuity.proposalStatus(proposalId);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.status === "promoted") return this.continuity.promote(proposalId, approver);
    const lease = this.leaseStore.get(proposal.leaseId);
    if (!lease) throw new Error("proposal lease not found");
    const claim = this.eventsStore.claimMutation(this.options.agentId, lease.leaseId, "promote", proposalId);
    if (claim === "pending") throw new Error("mutation_in_progress");
    if (typeof claim === "object") return this.continuity.promote(proposalId, approver);
    const expectedRevision = revisionFromSubstrateView(lease.baseManifest.substrateViewVersion);
    if (proposal.stateHash !== this.stateHashFor(lease, expectedRevision)
      || !this.eventsStore.advanceRevision(this.options.agentId, expectedRevision)) {
      this.eventsStore.abandonMutation(this.options.agentId, lease.leaseId, "promote", proposalId);
      this.record("mutation_rejected", lease, approver, "stale_state");
      throw new StaleMutationError();
    }
    let receipt: PromotionReceipt;
    try {
      receipt = await this.continuity.promote(proposalId, approver);
    } catch (error) {
      this.eventsStore.rollbackRevision(this.options.agentId, expectedRevision);
      this.eventsStore.abandonMutation(this.options.agentId, lease.leaseId, "promote", proposalId);
      throw error;
    }
    this.eventsStore.completeMutation(this.options.agentId, lease.leaseId, "promote", proposalId, { receiptId: receipt.receiptId });
    this.record("promotion", lease, approver, "promoted");
    return receipt;
  }

  close(): void {
    this.eventsStore.close();
    this.continuity.close();
    this.domainRevisions.close();
    this.leaseStore.close();
  }

  private async recallForLease(
    lease: IncarnationLease,
    clientId: string,
    request: SessionRecallRequest & { declaredScopes: readonly CanonicalSubstrateScope[] },
  ): Promise<IdentityRuntimeRecallResponse<unknown>> {
    lease = this.activeLease(lease.leaseId);
    this.requireClient(lease.leaseId, clientId);
    const result = await this.mapper.recall(
      request.substrateScope,
      request.declaredScopes,
      (memoryScopes) => this.continuity.recall(lease, request.query, [...memoryScopes]),
    );
    if (!result.resolution.ok) {
      this.record("scope_rejected", lease, clientId, result.resolution.diagnostic.code);
    }
    return result;
  }

  private async rememberForLease(
    lease: IncarnationLease,
    clientId: string,
    request: SessionRememberRequest,
  ): Promise<AgentMemoryEntry> {
    lease = this.activeLease(lease.leaseId);
    this.requireClient(lease.leaseId, clientId);
    if (!lease.writeScopes.includes(request.entry.scope)) {
      this.record("mutation_rejected", lease, clientId, "write_scope");
      throw new MemoryScopeViolationError(request.entry.scope, `lease:${lease.leaseId}`);
    }
    const expectedRevision = revisionFromSubstrateView(lease.baseManifest.substrateViewVersion);
    const idempotencyKey = request.idempotencyKey;
    if (!idempotencyKey) throw new Error("idempotency key is required");
    const claim = this.eventsStore.claimMutation(this.options.agentId, lease.leaseId, "remember", idempotencyKey);
    if (claim === "pending") throw new Error("mutation_in_progress");
    if (typeof claim === "object") {
      return { ...request.entry, id: String(claim.result.id), createdAt: String(claim.result.createdAt) };
    }
    if (request.stateHash !== this.stateHashFor(lease, expectedRevision)
      || !this.eventsStore.advanceRevision(this.options.agentId, expectedRevision)) {
      this.eventsStore.abandonMutation(this.options.agentId, lease.leaseId, "remember", idempotencyKey);
      this.record("mutation_rejected", lease, clientId, "stale_state");
      throw new StaleMutationError();
    }
    try {
      const written = await this.continuity.remember(lease, request.entry);
      this.eventsStore.completeMutation(this.options.agentId, lease.leaseId, "remember", idempotencyKey, { id: written.id, createdAt: written.createdAt });
      return written;
    } catch (error) {
      this.eventsStore.rollbackRevision(this.options.agentId, expectedRevision);
      this.eventsStore.abandonMutation(this.options.agentId, lease.leaseId, "remember", idempotencyKey);
      throw error;
    }
  }

  private async proposeForLease(lease: IncarnationLease, clientId: string, input: ProposeInput): Promise<IdentityProposal> {
    lease = this.activeLease(lease.leaseId);
    this.requireClient(lease.leaseId, clientId);
    const expectedRevision = revisionFromSubstrateView(lease.baseManifest.substrateViewVersion);
    if (input.stateHash !== this.stateHashFor(lease, expectedRevision)
      || this.eventsStore.revision(this.options.agentId) !== expectedRevision) {
      this.record("mutation_rejected", lease, clientId, "stale_state");
      throw new StaleMutationError();
    }
    const proposal = await this.continuity.propose(lease, input);
    this.record("proposal_held", lease, clientId, proposal.status);
    return proposal;
  }

  private record(kind: RuntimeEventKind, lease: IncarnationLease, sourceClient: string, outcome: string): void {
    this.eventsStore.append({
      id: this.generateId(),
      kind,
      agentId: this.options.agentId,
      surfaceId: lease.surfaceId,
      leaseId: lease.leaseId,
      projectionId: lease.baseManifest.projectionId,
      stateHash: lease.baseManifest.stateHash,
      sourceClient,
      outcome,
      createdAt: this.now(),
    });
  }

  private activeLease(leaseId: string): IncarnationLease {
    const lease = this.leaseStore.get(leaseId);
    if (!lease || lease.agentId !== this.options.agentId || !this.leaseStore.isActive(lease, this.now())) {
      throw new Error("lease not active");
    }
    return lease;
  }

  private requireClient(leaseId: string, clientId: string): void {
    const joinedClientId = this.clientIdByLease.get(leaseId);
    if (!joinedClientId || joinedClientId !== clientId) throw new Error("lease client mismatch");
  }

  private stateHashFor(lease: IncarnationLease, revision: number): string {
    const manifest = lease.baseManifest;
    return buildManifest({
      agentId: manifest.agentId,
      kernelVersion: manifest.kernelVersion,
      cartridgeVersions: manifest.cartridgeVersions,
      substrateViewVersion: versionedSubstrateView(baseSubstrateView(manifest.substrateViewVersion), revision),
      memoryDomainVersions: manifest.memoryDomainVersions,
      surfaceId: manifest.surfaceId,
      compiledAt: manifest.compiledAt,
      promptStaticHash: manifest.promptStaticHash,
    }).stateHash;
  }
}

const RUNTIME_REVISION_MARKER = "::identity-runtime-revision:";

function versionedSubstrateView(base: string, revision: number): string {
  return `${baseSubstrateView(base)}${RUNTIME_REVISION_MARKER}${revision}`;
}

function baseSubstrateView(value: string): string {
  return value.split(RUNTIME_REVISION_MARKER, 1)[0] ?? value;
}

function revisionFromSubstrateView(value: string): number {
  const index = value.lastIndexOf(RUNTIME_REVISION_MARKER);
  if (index === -1) return 0;
  const revision = Number(value.slice(index + RUNTIME_REVISION_MARKER.length));
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function isProjectionCompileRequest(value: ProjectionCompileRequest | RuntimeJoinComposition | undefined): value is ProjectionCompileRequest {
  return value !== undefined && "identity" in value;
}

function assertRuntimeProjection(value: RuntimeProjection): void {
  if (!value.prompt || !value.promptStaticHash || !value.kernelVersion || !value.substrateViewVersion) {
    throw new Error("runtime projection is incomplete");
  }
  if (!Array.isArray(value.readScopes) || !Array.isArray(value.writeScopes)
    || !Array.isArray(value.proposalScopes) || !Array.isArray(value.declaredSubstrateScopes)) {
    throw new Error("runtime projection scopes are invalid");
  }
}

export type { CanonicalSubstrateScope };
