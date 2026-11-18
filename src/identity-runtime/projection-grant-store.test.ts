import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectionGrant } from "./contract/projection-grant.ts";
import { ProjectionGrantStore } from "./projection-grant-store";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const grant: ProjectionGrant = {
  grantId: "grant-1",
  identity: "eli",
  surfaceId: "windows-codex",
  projectionId: "projection-1",
  stateHash: "state-1",
  writeScopes: ["scent"],
  readScopes: ["episode", "observation"],
  declaredSubstrateScopes: ["episodic_memory"],
  scopeDeclarationStatus: "implemented",
  issuedAt: 1_000,
  expiresAt: 2_000,
};

describe("ProjectionGrantStore", () => {
  test("persists and returns an ANIMA-owned active grant", () => {
    root = mkdtempSync(join(tmpdir(), "projection-grant-"));
    const store = new ProjectionGrantStore(join(root, "continuity.db"));

    store.put(grant);

    expect(store.getActive("grant-1", 1_500)).toEqual(grant);
    store.close();
  });

  test("does not return grants after expiry", () => {
    root = mkdtempSync(join(tmpdir(), "projection-grant-"));
    const store = new ProjectionGrantStore(join(root, "continuity.db"));

    store.put(grant);

    expect(store.getActive("grant-1", 2_000)).toBeUndefined();
    store.close();
  });

  test("migrates an old grant table with empty read capability", () => {
    root = mkdtempSync(join(tmpdir(), "projection-grant-"));
    const path = join(root, "continuity.db");
    const oldDb = new Database(path, { create: true });
    oldDb.run(`
      CREATE TABLE identity_projection_grants (
        grant_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        write_scopes_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    oldDb.run(
      "INSERT INTO identity_projection_grants (grant_id, identity_id, surface_id, projection_id, state_hash, write_scopes_json, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["old-grant", "eli", "surface", "projection", "state", JSON.stringify(["scent"]), 1_000, 2_000],
    );
    oldDb.close();

    const store = new ProjectionGrantStore(path);

    expect(store.getActive("old-grant", 1_500)).toMatchObject({
      grantId: "old-grant",
      readScopes: [],
      declaredSubstrateScopes: [],
      scopeDeclarationStatus: "unimplemented",
    });
    store.close();
  });
});
