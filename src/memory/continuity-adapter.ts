/**
 * ContinuityPort implementation — thin wiring adapter (Phase 0, `continuity-ports`).
 *
 * Lease-scoped reads (recall filtered to lease.readScopes), guarded writes via
 * the existing ScopedMemoryStore/guardMemoryStore, and the ProposalPromoter
 * constructed with the raw adapter as its privileged writer (constructor-
 * injected once, never re-exported). See design.md §4, Components.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMemoryStore, MemoryScope } from "./contract";
import { guardMemoryStore } from "./scoped-store";
import { stampProjectionProvenance } from "../agents/manifest-logger";
import {
  ProposalPromoter,
  LeaseStore,
  DomainRevisions,
  LeaseInvalidError,
  type ContinuityPort,
  type IncarnationLease,
  type ProposeInput,
  type IdentityProposal,
  type PromotionReceipt,
} from "@anima/continuity-core";

export function defaultContinuityDbPath(agentName: string): string {
  return join(homedir(), ".anima", "agents", agentName, "continuity.db");
}

export class ContinuityAdapter implements ContinuityPort {
  private readonly promoter: ProposalPromoter;

  constructor(
    private readonly rawStore: AgentMemoryStore,
    private readonly leaseStore: LeaseStore,
    private readonly domainRevisions: DomainRevisions,
    dbPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.promoter = new ProposalPromoter({
      dbPath,
      // Constructor-injected once, at wiring time. Never re-exported —
      // no other module can reach the raw adapter through this class's surface.
      privilegedWriter: {
        remember: (entry) => rawStore.remember(entry),
      },
      domainRevisions,
      leaseStore,
      now: this.now,
    });
  }

  /**
   * Re-fetches the lease by id from the persisted store and validates it —
   * never trusts the caller-supplied lease object's own fields directly.
   * Without this, a caller could pass a forged/stale lease (fake expiresAt,
   * widened readScopes/writeScopes) and bypass every check below entirely.
   */
  private requireActiveLease(lease: IncarnationLease): IncarnationLease {
    const persisted = this.leaseStore.get(lease.leaseId);
    if (!persisted || persisted.agentId !== lease.agentId) {
      throw new LeaseInvalidError("lease not found or agent mismatch");
    }
    if (!this.leaseStore.isActive(persisted, this.now())) {
      throw new LeaseInvalidError("expired or released");
    }
    return persisted;
  }

  /** Reads are restricted to the intersection of requested scopes and the lease's readScopes. */
  async recall(lease: IncarnationLease, query: string, scopes?: string[]): Promise<unknown[]> {
    const persisted = this.requireActiveLease(lease);
    const requested = scopes ?? persisted.readScopes;
    const allowed = requested.filter((s) => persisted.readScopes.includes(s));
    return this.rawStore.recall(query, { scopes: allowed as MemoryScope[] });
  }

  /** A store guarded to exactly this lease's writeScopes — non-locked writes route through here. */
  guardedStore(lease: IncarnationLease): AgentMemoryStore {
    const persisted = this.requireActiveLease(lease);
    return guardMemoryStore(this.rawStore, {
      name: `lease:${persisted.leaseId}`,
      memory: { writeScopes: persisted.writeScopes as MemoryScope[] },
    })!;
  }

  /**
   * Convenience wrapper over guardedStore(lease).remember() — a scope outside
   * writeScopes throws MemoryScopeViolationError. Stamps baseManifest.projectionId
   * into the entry's metadata (SC-37 drift seeding) — the only production caller
   * of stampProjectionProvenance(); without this wiring the helper existed but
   * nothing actually attached provenance to a real commit (Codex review finding).
   */
  async remember(
    lease: IncarnationLease,
    entry: Parameters<AgentMemoryStore["remember"]>[0],
  ): ReturnType<AgentMemoryStore["remember"]> {
    const persisted = this.requireActiveLease(lease);
    const stamped = {
      ...entry,
      metadata: stampProjectionProvenance(entry.metadata, persisted.baseManifest),
    };
    return this.guardedStore(lease).remember(stamped);
  }

  async propose(lease: IncarnationLease, input: ProposeInput): Promise<IdentityProposal> {
    return this.promoter.propose(lease, input);
  }

  async promote(proposalId: string, approver: string): Promise<PromotionReceipt> {
    return this.promoter.promote(proposalId, approver);
  }

  proposalStatus(proposalId: string): IdentityProposal | undefined {
    return this.promoter.getProposal(proposalId);
  }

  /** Runtime composition owns this adapter and closes its proposal database on shutdown. */
  close(): void {
    this.promoter.close();
  }
}
