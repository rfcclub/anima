import { Database } from "bun:sqlite";
import type { ProjectionGrant } from "./contract/projection-grant.ts";
import type { MemoryScope } from "../memory/contract";

/** ANIMA's persistence boundary for opaque projection grants. */
export class ProjectionGrantStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS identity_projection_grants (
        grant_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        write_scopes_json TEXT NOT NULL,
        read_scopes_json TEXT NOT NULL DEFAULT '[]',
        declared_substrate_scopes_json TEXT NOT NULL DEFAULT '[]',
        scope_declaration_status TEXT NOT NULL DEFAULT 'unimplemented',
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.ensureColumn("read_scopes_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("declared_substrate_scopes_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("scope_declaration_status", "TEXT NOT NULL DEFAULT 'unimplemented'");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_identity_projection_grants_expiry ON identity_projection_grants(expires_at)",
    );
  }

  put(grant: ProjectionGrant): void {
    this.db.run(
      `INSERT INTO identity_projection_grants
        (grant_id, identity_id, surface_id, projection_id, state_hash, write_scopes_json,
         read_scopes_json, declared_substrate_scopes_json, scope_declaration_status, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         identity_id = excluded.identity_id,
         surface_id = excluded.surface_id,
         projection_id = excluded.projection_id,
         state_hash = excluded.state_hash,
         write_scopes_json = excluded.write_scopes_json,
         read_scopes_json = excluded.read_scopes_json,
         declared_substrate_scopes_json = excluded.declared_substrate_scopes_json,
         scope_declaration_status = excluded.scope_declaration_status,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at`,
      [
        grant.grantId,
        grant.identity,
        grant.surfaceId,
        grant.projectionId,
        grant.stateHash,
        JSON.stringify(grant.writeScopes),
        JSON.stringify(grant.readScopes ?? []),
        JSON.stringify(grant.declaredSubstrateScopes ?? []),
        grant.scopeDeclarationStatus ?? "unimplemented",
        grant.issuedAt,
        grant.expiresAt,
      ],
    );
  }

  getActive(grantId: string, now: number): ProjectionGrant | undefined {
    const row = this.db.query(
      `SELECT grant_id, identity_id, surface_id, projection_id, state_hash,
              write_scopes_json, read_scopes_json, declared_substrate_scopes_json,
              scope_declaration_status, issued_at, expires_at
       FROM identity_projection_grants
       WHERE grant_id = ? AND expires_at > ?`,
    ).get(grantId, now) as ProjectionGrantRow | null;
    return row ? rowToGrant(row) : undefined;
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db.query("PRAGMA table_info(identity_projection_grants)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.run(`ALTER TABLE identity_projection_grants ADD COLUMN ${name} ${definition}`);
    }
  }
}

interface ProjectionGrantRow {
  grant_id: string;
  identity_id: string;
  surface_id: string;
  projection_id: string;
  state_hash: string;
  write_scopes_json: string;
  read_scopes_json: string;
  declared_substrate_scopes_json: string;
  scope_declaration_status: "unimplemented" | "implemented" | "none";
  issued_at: number;
  expires_at: number;
}

function rowToGrant(row: ProjectionGrantRow): ProjectionGrant {
  return {
    grantId: row.grant_id,
    identity: row.identity_id,
    surfaceId: row.surface_id,
    projectionId: row.projection_id,
    stateHash: row.state_hash,
    writeScopes: JSON.parse(row.write_scopes_json) as MemoryScope[],
    readScopes: JSON.parse(row.read_scopes_json) as MemoryScope[],
    declaredSubstrateScopes: JSON.parse(row.declared_substrate_scopes_json),
    scopeDeclarationStatus: row.scope_declaration_status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}
