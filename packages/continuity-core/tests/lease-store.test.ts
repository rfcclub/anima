import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseStore, ProposalScopeNotLockedError, type MintLeaseInput } from "../src/lease-store";
import type { ProjectionManifest } from "../src/types";

let tmpDir: string | undefined;

function freshStore(): { store: LeaseStore; dbPath: string } {
  tmpDir = mkdtempSync(join(tmpdir(), "continuity-core-lease-store-"));
  const dbPath = join(tmpDir, "continuity.db");
  return { store: new LeaseStore(dbPath), dbPath };
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function fixtureManifest(overrides: Partial<ProjectionManifest> = {}): ProjectionManifest {
  return {
    agentId: "bruno",
    kernelVersion: "k",
    cartridgeVersions: {},
    substrateViewVersion: "v",
    memoryDomainVersions: { identity: "0", private: "0", heartwood: "0" },
    stateHash: "state-hash-fixture",
    surfaceId: "cc",
    compiledAt: 1000,
    promptStaticHash: "prompt-hash",
    projectionId: "projection-id-fixture",
    ...overrides,
  };
}

function fixtureMint(overrides: Partial<MintLeaseInput> = {}): MintLeaseInput {
  return {
    leaseId: "lease-1",
    agentId: "bruno",
    surfaceId: "cc",
    baseManifest: fixtureManifest(),
    readScopes: ["identity_core", "current_state"],
    writeScopes: ["scent", "scar", "decision", "episode", "observation", "fact", "project"],
    proposalScopes: ["identity"],
    idempotencyNamespace: "bruno:cc:lease-1",
    issuedAt: 1000,
    expiresAt: 2000,
    ...overrides,
  };
}

describe("SC-13 composition equality — ExecutionPlan guard intersection persisted verbatim", () => {
  test("writeScopes from a guard-intersection fixture round-trip unchanged", () => {
    const { store } = freshStore();
    const intersected = ["scent", "decision"]; // simulates ExecutionPlan guardEntry intersection
    const lease = store.mint(fixtureMint({ writeScopes: intersected }));
    expect(lease.writeScopes).toEqual(intersected);
    expect(store.get(lease.leaseId)!.writeScopes).toEqual(intersected);
  });
});

describe("SC-14 DEFAULT_WRITE_SCOPES fallback branch persisted verbatim", () => {
  test("the DEFAULT_WRITE_SCOPES fallback round-trips unchanged", () => {
    const { store } = freshStore();
    const DEFAULT_WRITE_SCOPES = ["scent", "scar", "decision", "episode", "observation", "fact", "project"];
    const lease = store.mint(fixtureMint({ writeScopes: DEFAULT_WRITE_SCOPES }));
    expect(lease.writeScopes).toEqual(DEFAULT_WRITE_SCOPES);
  });
});

describe("SC-15 read-scope equality from real resolved cartridge policies", () => {
  test("readScopes round-trip exactly as given (not the [] placeholder)", () => {
    const { store } = freshStore();
    const realScopes = ["identity_core", "current_state", "project_history"];
    const lease = store.mint(fixtureMint({ readScopes: realScopes }));
    expect(lease.readScopes).toEqual(realScopes);
    expect(lease.readScopes).not.toEqual([]);
  });
});

describe("SC-16 locked-scope filtering at mint", () => {
  test("LOCKED_SCOPES never appear in writeScopes even if maliciously passed", () => {
    const { store } = freshStore();
    const lease = store.mint(
      fixtureMint({ writeScopes: ["scent", "identity", "private", "heartwood", "decision"] }),
    );
    expect(lease.writeScopes).toEqual(["scent", "decision"]);
  });
});

describe("SC-17 proposalScopes must be subset of LOCKED_SCOPES", () => {
  test("a non-locked scope in proposalScopes is rejected at mint", () => {
    const { store } = freshStore();
    expect(() =>
      store.mint(fixtureMint({ proposalScopes: ["episode" as never] })),
    ).toThrow(ProposalScopeNotLockedError);
  });

  test("LOCKED_SCOPES entries in proposalScopes are accepted", () => {
    const { store } = freshStore();
    const lease = store.mint(fixtureMint({ proposalScopes: ["identity", "private"] }));
    expect(lease.proposalScopes).toEqual(["identity", "private"]);
  });
});

describe("SC-18 expiry fail-closed", () => {
  test("an expired lease is not active", () => {
    const { store } = freshStore();
    const lease = store.mint(fixtureMint({ issuedAt: 1000, expiresAt: 2000 }));
    expect(store.isActive(lease, 1500)).toBe(true);
    expect(store.isActive(lease, 2500)).toBe(false);
  });

  test("a released lease is not active even before expiry", () => {
    const { store } = freshStore();
    const lease = store.mint(fixtureMint({ issuedAt: 1000, expiresAt: 5000 }));
    store.release(lease.leaseId, 1200);
    const reloaded = store.get(lease.leaseId)!;
    expect(store.isActive(reloaded, 1300)).toBe(false);
  });
});

describe("SC-19 concurrent surface leases", () => {
  test("multiple concurrent leases per agent are legal", () => {
    const { store } = freshStore();
    const a = store.mint(fixtureMint({ leaseId: "lease-a", surfaceId: "cc" }));
    const b = store.mint(fixtureMint({ leaseId: "lease-b", surfaceId: "anima" }));
    expect(store.get(a.leaseId)).toBeDefined();
    expect(store.get(b.leaseId)).toBeDefined();
    expect(store.isActive(store.get(a.leaseId)!, 1500)).toBe(true);
    expect(store.isActive(store.get(b.leaseId)!, 1500)).toBe(true);
  });
});

describe("SC-20 reopen restores leases + persisted stateHash/projectionId", () => {
  test("a fresh LeaseStore instance over the same db file sees previously minted leases", () => {
    const { store, dbPath } = freshStore();
    const manifest = fixtureManifest({ stateHash: "reopen-state", projectionId: "reopen-projection" });
    store.mint(fixtureMint({ leaseId: "lease-reopen", baseManifest: manifest }));
    store.close();

    const reopened = new LeaseStore(dbPath);
    const lease = reopened.get("lease-reopen");
    expect(lease).toBeDefined();
    expect(lease!.baseManifest.stateHash).toBe("reopen-state");
    expect(lease!.baseManifest.projectionId).toBe("reopen-projection");
    reopened.close();
  });
});
