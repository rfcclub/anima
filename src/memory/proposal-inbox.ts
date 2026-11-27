import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * The agent's inbox of memory proposals (#666). Everything a remote session
 * or the Hindsight curation job proposes lands here and never in the
 * substrate: the agent's own reflection decides what, if anything, is
 * promoted into a neuron.
 */
export interface ProposalProvenance {
  /** "remote-session" for a consolidated batch, "hindsight-curation" for a curated page. */
  kind: "remote-session" | "hindsight-curation";
  /** The remote surface or Hindsight bank the proposal came from. */
  source: string;
  sessionId?: string;
  sequence?: number;
  pageId?: string;
  evidence?: string;
  confidence?: number;
}

export interface Proposal {
  proposalId: string;
  agentId: string;
  claim: string;
  contentHash: string;
  provenance: ProposalProvenance;
  /** Everything from a remote host stays untrusted until reflection accepts it. */
  trust: "untrusted";
  status: "pending";
  createdAt: number;
}

export type AppendOutcome = { status: "appended"; proposalId: string } | { status: "duplicate"; proposalId: string };

/** Content hash used for dedupe: claim text only, whitespace- and case-normalized. */
export function proposalContentHash(claim: string): string {
  return createHash("sha256").update(claim.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

export class ProposalInbox {
  private readonly db: Database;

  constructor(dbPath: string, private readonly now: () => number = Date.now) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS proposal_inbox (
        proposal_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        trust TEXT NOT NULL DEFAULT 'untrusted',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        UNIQUE (agent_id, content_hash)
      )
    `);
  }

  /** One proposal per distinct claim per agent; a repeat is reported, never rewritten. */
  append(agentId: string, claim: string, provenance: ProposalProvenance): AppendOutcome {
    const contentHash = proposalContentHash(claim);
    const existing = this.db.query(
      "SELECT proposal_id FROM proposal_inbox WHERE agent_id = ? AND content_hash = ?",
    ).get(agentId, contentHash) as { proposal_id: string } | null;
    if (existing) return { status: "duplicate", proposalId: existing.proposal_id };
    const proposalId = randomUUID();
    this.db.run(
      "INSERT INTO proposal_inbox (proposal_id, agent_id, claim, content_hash, provenance_json, trust, status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 'untrusted', 'pending', ?)",
      [proposalId, agentId, claim.trim(), contentHash, JSON.stringify(provenance), this.now()],
    );
    return { status: "appended", proposalId };
  }

  list(agentId: string, status: "pending" | "all" = "pending"): Proposal[] {
    const rows = this.db.query(
      status === "all"
        ? "SELECT * FROM proposal_inbox WHERE agent_id = ? ORDER BY created_at ASC, proposal_id ASC"
        : "SELECT * FROM proposal_inbox WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC, proposal_id ASC",
    ).all(agentId) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  /** Claims already present as neurons are backed by their content hash; used to skip restating what is known. */
  hasContentHash(agentId: string, contentHash: string): boolean {
    return Boolean(this.db.query(
      "SELECT 1 FROM proposal_inbox WHERE agent_id = ? AND content_hash = ?",
    ).get(agentId, contentHash));
  }

  close(): void { this.db.close(); }
}

interface ProposalRow {
  proposal_id: string;
  agent_id: string;
  claim: string;
  content_hash: string;
  provenance_json: string;
  trust: string;
  status: string;
  created_at: number;
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    proposalId: row.proposal_id,
    agentId: row.agent_id,
    claim: row.claim,
    contentHash: row.content_hash,
    provenance: JSON.parse(row.provenance_json) as ProposalProvenance,
    trust: "untrusted",
    status: "pending",
    createdAt: row.created_at,
  };
}
