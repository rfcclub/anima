import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityAdapter, defaultContinuityDbPath } from "./continuity-adapter";
import { MemoryScopeViolationError } from "./scoped-store";
import type { AgentMemoryEntry, AgentMemoryStore, BootstrapOptions, RecallOptions } from "./contract";
import { LeaseStore, DomainRevisions, LeaseInvalidError, type MintLeaseInput } from "@anima/continuity-core";

class FakeMemoryStore implements AgentMemoryStore {
  public entries: AgentMemoryEntry[] = [];
  public recallCalls: Array<{ query: string; options?: RecallOptions }> = [];

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    const stored: AgentMemoryEntry = {
      ...entry,
      id: `entry-${this.entries.length + 1}`,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(stored);
    return stored;
  }

  async recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    this.recallCalls.push({ query, options });
    return this.entries.filter((e) => !options?.scopes || options.scopes.includes(e.scope));
  }

  async bootstrap(_options?: BootstrapOptions): Promise<AgentMemoryEntry[]> {
    return [];
  }

  async forget(_id: string): Promise<void> {}
}

let tmpDir: string | undefined;

function freshDbPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "continuity-adapter-"));
  return join(tmpDir, "continuity.db");
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function fixtureMint(dbPath: string, leaseStore: LeaseStore): ReturnType<LeaseStore["mint"]> {
  const mint: MintLeaseInput = {
    leaseId: "lease-1",
    agentId: "bruno",
    surfaceId: "cc",
    baseManifest: {
      agentId: "bruno",
      kernelVersion: "k",
      cartridgeVersions: {},
      substrateViewVersion: "v",
      memoryDomainVersions: { identity: "0", private: "0", heartwood: "0" },
      stateHash: "state-hash",
      surfaceId: "cc",
      compiledAt: 0,
      promptStaticHash: "prompt-hash",
      projectionId: "projection-id",
    },
    // readScopes intersects against AgentMemoryStore's MemoryScope vocabulary at
    // recall() time (see ContinuityAdapter.recall) — use valid MemoryScope values here.
    readScopes: ["fact"],
    writeScopes: ["scent", "decision"],
    proposalScopes: ["identity"],
    idempotencyNamespace: "bruno:cc:lease-1",
    issuedAt: 0,
    expiresAt: 1_000_000,
  };
  return leaseStore.mint(mint);
}

describe("SC-05 read-scope filtering", () => {
  test("recall restricts to the intersection of requested scopes and lease.readScopes", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore);

    await adapter.recall(lease, "query", ["fact", "observation"]);

    expect(rawStore.recallCalls[0].options?.scopes).toEqual(["fact"]);
  });

  test("with no scopes argument, defaults to exactly lease.readScopes", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore);

    await adapter.recall(lease, "query");

    expect(rawStore.recallCalls[0].options?.scopes).toEqual(["fact"]);
  });

  test("SC-05: entries of a scope excluded from readScopes are not returned end-to-end", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore); // readScopes: ["fact"]

    await rawStore.remember({ content: "allowed", scope: "fact", tags: [], confidence: 1, source: "test" });
    await rawStore.remember({ content: "excluded", scope: "observation", tags: [], confidence: 1, source: "test" });

    const results = (await adapter.recall(lease, "query", ["fact", "observation"])) as Array<{
      content: string;
    }>;

    expect(results.map((r) => r.content)).toEqual(["allowed"]);
  });
});

describe("SC-06 guarded-write violation via existing MemoryScopeViolationError", () => {
  test("ContinuityAdapter.remember() with a scope outside writeScopes throws MemoryScopeViolationError and writes nothing", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore); // writeScopes: ["scent", "decision"]

    await expect(
      adapter.remember(lease, { content: "x", scope: "fact", tags: [], confidence: 1, source: "test" }),
    ).rejects.toThrow(MemoryScopeViolationError);
    expect(rawStore.entries.length).toBe(0);
  });

  test("a write outside lease.writeScopes throws the existing MemoryScopeViolationError", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore);

    const guarded = adapter.guardedStore(lease);

    await expect(
      guarded.remember({ content: "x", scope: "fact", tags: [], confidence: 1, source: "test" }),
    ).rejects.toThrow(MemoryScopeViolationError);
  });

  test("a write within lease.writeScopes succeeds", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore);

    const guarded = adapter.guardedStore(lease);
    const entry = await guarded.remember({
      content: "x",
      scope: "scent",
      tags: [],
      confidence: 1,
      source: "test",
    });

    expect(entry.id).toBeTruthy();
    expect(rawStore.entries.length).toBe(1);
  });

  test("locked scopes are never writable through the guarded store, even if writeScopes were tampered", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    // writeScopes filtered by LeaseStore.mint already strips LOCKED_SCOPES —
    // this proves that filtering held even if a caller tried to widen it.
    const lease = leaseStore.mint({
      leaseId: "lease-tamper",
      agentId: "bruno",
      surfaceId: "cc",
      baseManifest: fixtureMint(dbPath, new LeaseStore(dbPath)).baseManifest,
      readScopes: [],
      writeScopes: ["scent", "identity"],
      proposalScopes: [],
      idempotencyNamespace: "bruno:cc:lease-tamper",
      issuedAt: 0,
      expiresAt: 1_000_000,
    });
    const guarded = adapter.guardedStore(lease);

    await expect(
      guarded.remember({ content: "x", scope: "identity", tags: [], confidence: 1, source: "test" }),
    ).rejects.toThrow(MemoryScopeViolationError);
  });
});

describe("Codex review major fix: remember() actually stamps SC-37 provenance", () => {
  test("a write through ContinuityAdapter.remember() carries baseManifest.projectionId in its metadata", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const lease = fixtureMint(dbPath, leaseStore);

    await adapter.remember(lease, { content: "x", scope: "scent", tags: [], confidence: 1, source: "test" });

    expect(rawStore.entries.length).toBe(1);
    const stamped = rawStore.entries[0].metadata as { baseManifest?: { projectionId: string } };
    expect(stamped.baseManifest?.projectionId).toBe(lease.baseManifest.projectionId);
  });
});

describe("Codex review blocker fix: caller-supplied lease is never trusted directly", () => {
  test("a forged lease object (fake writeScopes, real leaseId) is rejected — authorization uses the persisted record", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const realLease = fixtureMint(dbPath, leaseStore); // real writeScopes: ["scent", "decision"]

    const forged = { ...realLease, writeScopes: ["identity", "private", "heartwood"] };

    // Even though the forged object claims write access to locked scopes,
    // guardedStore() re-fetches by leaseId and uses the PERSISTED writeScopes.
    const guarded = adapter.guardedStore(forged);
    await expect(
      guarded.remember({ content: "x", scope: "identity", tags: [], confidence: 1, source: "test" }),
    ).rejects.toThrow(MemoryScopeViolationError);
  });

  test("an expired lease (per the persisted record) is rejected even if the caller's copy claims otherwise", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    // now() = 2_000_000, well past the fixture's expiresAt: 1_000_000.
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 2_000_000);
    const realLease = fixtureMint(dbPath, leaseStore);
    const forgedFresh = { ...realLease, expiresAt: 9_999_999 };

    await expect(adapter.recall(forgedFresh, "query")).rejects.toThrow(LeaseInvalidError);
  });

  test("a released lease is rejected even if the caller's copy has no releasedAt", async () => {
    const dbPath = freshDbPath();
    const leaseStore = new LeaseStore(dbPath);
    const domainRevisions = new DomainRevisions(dbPath);
    const rawStore = new FakeMemoryStore();
    const adapter = new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath, () => 500_000);
    const realLease = fixtureMint(dbPath, leaseStore);
    leaseStore.release(realLease.leaseId, 400_000);

    expect(realLease.releasedAt).toBeUndefined(); // caller's copy is stale
    await expect(adapter.recall(realLease, "query")).rejects.toThrow(LeaseInvalidError);
  });
});

describe("defaultContinuityDbPath", () => {
  test("resolves beside the per-agent memory.db under ~/.anima/agents/<agent>/", () => {
    expect(defaultContinuityDbPath("bruno")).toContain("/.anima/agents/bruno/continuity.db");
  });
});
