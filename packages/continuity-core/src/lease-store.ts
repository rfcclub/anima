/**
 * bun:sqlite-backed IncarnationLease store — mint/get/release/expire.
 *
 * LOCKED_SCOPES can never land in `writeScopes` (ScopedMemoryStore's own
 * constructor already filters them too — this is defense in depth, not the
 * only enforcement point). `proposalScopes` must be a subset of LOCKED_SCOPES.
 */

import { Database } from "bun:sqlite";
import type { IncarnationLease, LockedScope, ProjectionManifest } from "./types.js";

const ALL_LOCKED_SCOPES: readonly LockedScope[] = ["identity", "private", "heartwood"];

export interface MintLeaseInput {
  leaseId: string;
  agentId: string;
  surfaceId: string;
  baseManifest: ProjectionManifest;
  readScopes: string[];
  writeScopes: string[];
  proposalScopes: LockedScope[];
  idempotencyNamespace: string;
  issuedAt: number;
  expiresAt: number;
}

export class ProposalScopeNotLockedError extends Error {
  constructor(scope: string) {
    super(`proposalScopes entry "${scope}" is not one of LOCKED_SCOPES`);
    this.name = "ProposalScopeNotLockedError";
  }
}

export class LeaseStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS incarnation_leases (
        lease_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        base_manifest_json TEXT NOT NULL,
        read_scopes_json TEXT NOT NULL,
        write_scopes_json TEXT NOT NULL,
        proposal_scopes_json TEXT NOT NULL,
        idempotency_namespace TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_leases_agent ON incarnation_leases(agent_id, expires_at)",
    );
  }

  mint(input: MintLeaseInput): IncarnationLease {
    for (const scope of input.proposalScopes) {
      if (!ALL_LOCKED_SCOPES.includes(scope)) {
        throw new ProposalScopeNotLockedError(scope);
      }
    }
    // Defense in depth: LOCKED_SCOPES must never appear in writeScopes, even if
    // maliciously passed — ScopedMemoryStore's own constructor filters these too.
    const writeScopes = input.writeScopes.filter(
      (s) => !ALL_LOCKED_SCOPES.includes(s as LockedScope),
    );

    const lease: IncarnationLease = {
      leaseId: input.leaseId,
      agentId: input.agentId,
      surfaceId: input.surfaceId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      idempotencyNamespace: input.idempotencyNamespace,
      baseManifest: input.baseManifest,
      readScopes: input.readScopes,
      writeScopes,
      proposalScopes: input.proposalScopes,
    };

    this.db.run(
      `INSERT INTO incarnation_leases
        (lease_id, agent_id, surface_id, state_hash, projection_id, base_manifest_json,
         read_scopes_json, write_scopes_json, proposal_scopes_json, idempotency_namespace,
         issued_at, expires_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        lease.leaseId,
        lease.agentId,
        lease.surfaceId,
        lease.baseManifest.stateHash,
        lease.baseManifest.projectionId,
        JSON.stringify(lease.baseManifest),
        JSON.stringify(lease.readScopes),
        JSON.stringify(lease.writeScopes),
        JSON.stringify(lease.proposalScopes),
        lease.idempotencyNamespace,
        lease.issuedAt,
        lease.expiresAt,
      ],
    );

    return lease;
  }

  get(leaseId: string): IncarnationLease | undefined {
    const row = this.db
      .query("SELECT * FROM incarnation_leases WHERE lease_id = ?")
      .get(leaseId) as LeaseRow | null;
    return row ? rowToLease(row) : undefined;
  }

  release(leaseId: string, now: number): void {
    this.db.run("UPDATE incarnation_leases SET released_at = ? WHERE lease_id = ?", [now, leaseId]);
  }

  /** Fail-closed: unexpired AND unreleased. */
  isActive(lease: IncarnationLease, now: number): boolean {
    return now < lease.expiresAt && lease.releasedAt === undefined;
  }

  /**
   * Explicit revocation only (not natural TTL expiry) — a held proposal is
   * meant to survive its lease's short join-window for async review
   * (the held-for-review flow), so `promote()` checks this
   * instead of `isActive`. An explicitly released lease should never be
   * trusted for anything further, including promoting a proposal made
   * under it while it was still active.
   */
  isReleased(lease: IncarnationLease): boolean {
    return lease.releasedAt !== undefined;
  }

  close(): void {
    this.db.close();
  }
}

interface LeaseRow {
  lease_id: string;
  agent_id: string;
  surface_id: string;
  base_manifest_json: string;
  read_scopes_json: string;
  write_scopes_json: string;
  proposal_scopes_json: string;
  idempotency_namespace: string;
  issued_at: number;
  expires_at: number;
  released_at: number | null;
}

function rowToLease(row: LeaseRow): IncarnationLease {
  return {
    leaseId: row.lease_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    idempotencyNamespace: row.idempotency_namespace,
    baseManifest: JSON.parse(row.base_manifest_json),
    readScopes: JSON.parse(row.read_scopes_json),
    writeScopes: JSON.parse(row.write_scopes_json),
    proposalScopes: JSON.parse(row.proposal_scopes_json),
    releasedAt: row.released_at ?? undefined,
  };
}
