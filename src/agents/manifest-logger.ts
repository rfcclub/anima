/**
 * ManifestLogger — the seed consumer (Phase 0, `continuity-ports`).
 *
 * Two entry points, split across the turn lifecycle (design.md §5):
 *  1. mint — delegates to incarnation-adapter's join(), called from prepareTurn().
 *  2. record — the completion-write, called exactly once from the `finally`
 *     block in run()/runStream(), regardless of success or error.
 *
 * Also: stampProjectionProvenance(), the drift-seeding helper that attaches
 * baseManifest.projectionId to non-kernel commit metadata.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import type { ProjectionManifest } from "@anima/continuity-core";
import { join, type JoinInput, type JoinResult } from "./incarnation-adapter";

export type TurnOutcome = "ok" | "error";

export interface ManifestLogRow {
  id: number;
  turnId: string;
  agentId: string;
  surfaceId: string;
  projectionId: string;
  stateHash: string;
  domainVersions: Record<string, string>;
  compiledAt: number;
  outcome: TurnOutcome;
}

export function defaultManifestLogDbPath(agentName: string): string {
  return joinPath(homedir(), ".anima", "agents", agentName, "continuity.db");
}

/** Mint hook — call from prepareTurn(). Thin re-export of incarnation-adapter's join(). */
export async function mintForTurn(input: JoinInput): Promise<JoinResult> {
  return join(input);
}

export class ManifestLogger {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS manifest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        domain_versions_json TEXT NOT NULL,
        compiled_at INTEGER NOT NULL,
        outcome TEXT NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_manifest_log_agent ON manifest_log(agent_id, compiled_at)",
    );
  }

  /** Completion-write hook — call exactly once from the `finally` block in run()/runStream(). */
  record(turnId: string, manifest: ProjectionManifest, outcome: TurnOutcome): void {
    this.db.run(
      `INSERT INTO manifest_log
        (turn_id, agent_id, surface_id, projection_id, state_hash, domain_versions_json, compiled_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        turnId,
        manifest.agentId,
        manifest.surfaceId,
        manifest.projectionId,
        manifest.stateHash,
        JSON.stringify(manifest.memoryDomainVersions),
        manifest.compiledAt,
        outcome,
      ],
    );
  }

  entriesFor(agentId: string): ManifestLogRow[] {
    const rows = this.db
      .query("SELECT * FROM manifest_log WHERE agent_id = ? ORDER BY id ASC")
      .all(agentId) as RawRow[];
    return rows.map(rowToEntry);
  }

  close(): void {
    this.db.close();
  }
}

interface RawRow {
  id: number;
  turn_id: string;
  agent_id: string;
  surface_id: string;
  projection_id: string;
  state_hash: string;
  domain_versions_json: string;
  compiled_at: number;
  outcome: TurnOutcome;
}

function rowToEntry(row: RawRow): ManifestLogRow {
  return {
    id: row.id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    projectionId: row.projection_id,
    stateHash: row.state_hash,
    domainVersions: JSON.parse(row.domain_versions_json),
    compiledAt: row.compiled_at,
    outcome: row.outcome,
  };
}

/**
 * Drift seeding (Quin review, issue 5): stamp baseManifest.projectionId into a
 * non-kernel commit's metadata so a future drift observer can replay which
 * projection produced which commit. The observer itself is Phase 1+.
 */
export function stampProjectionProvenance(
  metadata: Record<string, unknown> | undefined,
  baseManifest: ProjectionManifest,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    baseManifest: { projectionId: baseManifest.projectionId },
  };
}
