/**
 * Reference ProposalPromoter — the only path for LOCKED_SCOPES writes.
 *
 * propose(): deterministic validation (rules 1-5), no LLM, held-for-review.
 * promote(): explicit, out-of-band; re-checks lease binding + touched-domain
 * drift (rule 6), then the privileged writer performs exactly one write.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { LeaseStore } from "./lease-store.js";
import type { DomainRevisions } from "./domain-revisions.js";
import type {
  IdentityProposal,
  IncarnationLease,
  LockedScope,
  ProposeInput,
  PromotionReceipt,
} from "./types.js";

const ALL_LOCKED_SCOPES: readonly LockedScope[] = ["identity", "private", "heartwood"];

export class LeaseInvalidError extends Error {
  constructor(reason: string) {
    super(`lease invalid: ${reason}`);
    this.name = "LeaseInvalidError";
  }
}
export class ScopeNotProposableError extends Error {
  constructor(scope: string) {
    super(`scope "${scope}" is not in this lease's proposalScopes`);
    this.name = "ScopeNotProposableError";
  }
}
export class StateHashMismatchError extends Error {
  constructor() {
    super("proposal.stateHash does not match lease.baseManifest.stateHash");
    this.name = "StateHashMismatchError";
  }
}
export class EmptyContentError extends Error {
  constructor() {
    super("proposal content must be non-empty");
    this.name = "EmptyContentError";
  }
}
export class MissingEvidenceError extends Error {
  constructor() {
    super("proposal must carry at least one evidence source reference");
    this.name = "MissingEvidenceError";
  }
}
export class ProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`proposal not found: ${proposalId}`);
    this.name = "ProposalNotFoundError";
  }
}
export class ProposalNotPromotableError extends Error {
  constructor(proposalId: string, status: string) {
    super(`proposal ${proposalId} cannot be promoted from status "${status}"`);
    this.name = "ProposalNotPromotableError";
  }
}
export class StaleProposalError extends Error {
  constructor(proposalId: string, scope: string) {
    super(`proposal ${proposalId} is stale — scope "${scope}" drifted since propose time`);
    this.name = "StaleProposalError";
  }
}

/** Injected once at wiring time — never exported from the package's public surface. */
export interface PrivilegedWriter {
  remember(entry: {
    scope: LockedScope;
    content: string;
    tags: string[];
    confidence: number;
    source: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface ProposalPromoterOptions {
  dbPath: string;
  privilegedWriter: PrivilegedWriter;
  domainRevisions: DomainRevisions;
  leaseStore: LeaseStore;
  now?: () => number;
  idGenerator?: () => string;
}

export class ProposalPromoter {
  private readonly db: Database;
  private readonly writer: PrivilegedWriter;
  private readonly domainRevisions: DomainRevisions;
  private readonly leaseStore: LeaseStore;
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(options: ProposalPromoterOptions) {
    this.db = new Database(options.dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS identity_proposals (
        proposal_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        idempotency_namespace TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        UNIQUE(idempotency_namespace, idempotency_key)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS promotion_receipts (
        receipt_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE,
        promoted_entry_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        base_version TEXT NOT NULL,
        new_version TEXT NOT NULL,
        approver TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.writer = options.privilegedWriter;
    this.domainRevisions = options.domainRevisions;
    this.leaseStore = options.leaseStore;
    this.now = options.now ?? Date.now;
    this.genId = options.idGenerator ?? randomUUID;
  }

  async propose(lease: IncarnationLease, input: ProposeInput): Promise<IdentityProposal> {
    // Authorize against the PERSISTED lease record, never the caller-supplied
    // object's fields directly — a caller could otherwise pass a forged lease
    // (fake expiresAt, widened proposalScopes) and bypass every check below.
    const persisted = this.leaseStore.get(lease.leaseId);
    if (!persisted || persisted.agentId !== lease.agentId) {
      throw new LeaseInvalidError("lease not found or agent mismatch");
    }
    // Rule 1: lease exists, unexpired, unreleased, agentId matches.
    if (!this.leaseStore.isActive(persisted, this.now())) {
      throw new LeaseInvalidError("expired or released");
    }
    // Rule 2: scope must be within lease.proposalScopes (⊆ LOCKED_SCOPES).
    if (!persisted.proposalScopes.includes(input.scope)) {
      throw new ScopeNotProposableError(input.scope);
    }
    // Rule 3: proposal.stateHash must match the lease's base projection.
    if (input.stateHash !== persisted.baseManifest.stateHash) {
      throw new StateHashMismatchError();
    }
    // Rule 4: content non-empty; at least one evidence reference.
    if (!input.content || input.content.trim().length === 0) {
      throw new EmptyContentError();
    }
    if (!input.evidence || input.evidence.length === 0) {
      throw new MissingEvidenceError();
    }

    // Rule 5: idempotency replay — same key returns the existing proposal, no duplicate.
    const existing = this.findByIdempotencyKey(persisted.idempotencyNamespace, input.idempotencyKey);
    if (existing) return existing;

    const proposal: IdentityProposal = {
      proposalId: this.genId(),
      leaseId: persisted.leaseId,
      agentId: persisted.agentId,
      scope: input.scope,
      content: input.content,
      evidence: input.evidence,
      stateHash: input.stateHash,
      idempotencyKey: input.idempotencyKey,
      status: "held",
      createdAt: this.now(),
    };

    this.db.run(
      `INSERT INTO identity_proposals
        (proposal_id, lease_id, agent_id, scope, content, evidence_json, state_hash,
         idempotency_key, idempotency_namespace, status, reason, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      [
        proposal.proposalId,
        proposal.leaseId,
        proposal.agentId,
        proposal.scope,
        proposal.content,
        JSON.stringify(proposal.evidence),
        proposal.stateHash,
        proposal.idempotencyKey,
        persisted.idempotencyNamespace,
        proposal.status,
        proposal.createdAt,
      ],
    );

    return proposal;
  }

  async promote(proposalId: string, approver: string): Promise<PromotionReceipt> {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new ProposalNotFoundError(proposalId);

    // SC-28: promotion replay is idempotent.
    if (proposal.status === "promoted") {
      const receipt = this.getReceiptByProposal(proposalId);
      if (receipt) return receipt;
    }
    if (proposal.status === "rejected" || proposal.status === "stale") {
      throw new ProposalNotPromotableError(proposalId, proposal.status);
    }

    const lease = this.leaseStore.get(proposal.leaseId);
    if (!lease || lease.agentId !== proposal.agentId) {
      throw new LeaseInvalidError("lease-agent binding no longer holds");
    }
    // Natural TTL expiry is NOT checked here — a held proposal is meant to
    // outlive its lease's short join-window for async review. Explicit
    // revocation is checked: a released lease can never promote anything,
    // even a proposal made while it was still active.
    if (this.leaseStore.isReleased(lease)) {
      throw new LeaseInvalidError("lease was explicitly released");
    }

    // Rule 6: per-domain stale check — touched scope only.
    const baseVersion = lease.baseManifest.memoryDomainVersions[proposal.scope];
    const currentVersion = this.domainRevisions.getRevision(proposal.agentId, proposal.scope);
    if (currentVersion !== baseVersion) {
      this.markDecided(proposalId, "stale", this.now());
      throw new StaleProposalError(proposalId, proposal.scope);
    }

    const now = this.now();
    const written = await this.writer.remember({
      scope: proposal.scope,
      content: proposal.content,
      tags: [],
      confidence: 1,
      source: "identity-proposal-gate",
      metadata: {
        proposalId: proposal.proposalId,
        leaseId: proposal.leaseId,
        stateHash: proposal.stateHash,
        approver,
      },
    });

    const newVersion = this.domainRevisions.incrementRevision(proposal.agentId, proposal.scope, now);

    const receipt: PromotionReceipt = {
      receiptId: this.genId(),
      proposalId: proposal.proposalId,
      promotedEntryId: written.id,
      domain: proposal.scope,
      baseVersion,
      newVersion,
      approver,
      createdAt: now,
    };

    this.db.run(
      `INSERT INTO promotion_receipts
        (receipt_id, proposal_id, promoted_entry_id, domain, base_version, new_version, approver, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receipt.receiptId,
        receipt.proposalId,
        receipt.promotedEntryId,
        receipt.domain,
        receipt.baseVersion,
        receipt.newVersion,
        receipt.approver,
        receipt.createdAt,
      ],
    );

    this.markDecided(proposalId, "promoted", now);

    return receipt;
  }

  private markDecided(proposalId: string, status: string, decidedAt: number): void {
    this.db.run("UPDATE identity_proposals SET status = ?, decided_at = ? WHERE proposal_id = ?", [
      status,
      decidedAt,
      proposalId,
    ]);
  }

  private findByIdempotencyKey(namespace: string, key: string): IdentityProposal | undefined {
    const row = this.db
      .query(
        "SELECT * FROM identity_proposals WHERE idempotency_namespace = ? AND idempotency_key = ?",
      )
      .get(namespace, key) as ProposalRow | null;
    return row ? rowToProposal(row) : undefined;
  }

  getProposal(proposalId: string): IdentityProposal | undefined {
    const row = this.db
      .query("SELECT * FROM identity_proposals WHERE proposal_id = ?")
      .get(proposalId) as ProposalRow | null;
    return row ? rowToProposal(row) : undefined;
  }

  getReceiptByProposal(proposalId: string): PromotionReceipt | undefined {
    const row = this.db
      .query("SELECT * FROM promotion_receipts WHERE proposal_id = ?")
      .get(proposalId) as ReceiptRow | null;
    return row ? rowToReceipt(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

interface ProposalRow {
  proposal_id: string;
  lease_id: string;
  agent_id: string;
  scope: LockedScope;
  content: string;
  evidence_json: string;
  state_hash: string;
  idempotency_key: string;
  status: IdentityProposal["status"];
  reason: string | null;
  created_at: number;
  decided_at: number | null;
}

function rowToProposal(row: ProposalRow): IdentityProposal {
  return {
    proposalId: row.proposal_id,
    leaseId: row.lease_id,
    agentId: row.agent_id,
    scope: row.scope,
    content: row.content,
    evidence: JSON.parse(row.evidence_json),
    stateHash: row.state_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

interface ReceiptRow {
  receipt_id: string;
  proposal_id: string;
  promoted_entry_id: string;
  domain: LockedScope;
  base_version: string;
  new_version: string;
  approver: string;
  created_at: number;
}

function rowToReceipt(row: ReceiptRow): PromotionReceipt {
  return {
    receiptId: row.receipt_id,
    proposalId: row.proposal_id,
    promotedEntryId: row.promoted_entry_id,
    domain: row.domain,
    baseVersion: row.base_version,
    newVersion: row.new_version,
    approver: row.approver,
    createdAt: row.created_at,
  };
}
