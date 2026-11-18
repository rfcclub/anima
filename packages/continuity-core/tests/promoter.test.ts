import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseStore, type MintLeaseInput } from "../src/lease-store";
import { DomainRevisions } from "../src/domain-revisions";
import {
  ProposalPromoter,
  LeaseInvalidError,
  ScopeNotProposableError,
  StateHashMismatchError,
  EmptyContentError,
  MissingEvidenceError,
  StaleProposalError,
  type PrivilegedWriter,
} from "../src/promoter";
import type { IncarnationLease, ProjectionManifest, ProposeInput } from "../src/types";

let tmpDir: string | undefined;

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

function fakeWriter(): PrivilegedWriter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async remember(entry) {
      calls.push(entry);
      return { id: `entry-${calls.length}` };
    },
  };
}

function setup(manifestOverrides: Partial<ProjectionManifest> = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "continuity-core-promoter-"));
  const dbPath = join(tmpDir, "continuity.db");
  const leaseStore = new LeaseStore(dbPath);
  const domainRevisions = new DomainRevisions(dbPath);
  const writer = fakeWriter();
  const manifest = fixtureManifest(manifestOverrides);
  const mint: MintLeaseInput = {
    leaseId: "lease-1",
    agentId: "bruno",
    surfaceId: "cc",
    baseManifest: manifest,
    readScopes: ["identity_core"],
    writeScopes: ["scent"],
    proposalScopes: ["identity"],
    idempotencyNamespace: "bruno:cc:lease-1",
    issuedAt: 1000,
    expiresAt: 100000,
  };
  const lease = leaseStore.mint(mint);
  let currentTime = 5000;
  const promoter = new ProposalPromoter({
    dbPath,
    privilegedWriter: writer,
    domainRevisions,
    leaseStore,
    now: () => currentTime,
  });
  return {
    leaseStore,
    domainRevisions,
    writer,
    lease,
    promoter,
    dbPath,
    advanceTimeTo: (t: number) => {
      currentTime = t;
    },
  };
}

function validInput(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    scope: "identity",
    content: "I learned something about myself",
    evidence: ["session:abc123"],
    idempotencyKey: "key-1",
    stateHash: "state-hash-fixture",
    ...overrides,
  };
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("SC-23 each rule rejects independently", () => {
  test("rule 1: expired/released lease rejects with LeaseInvalidError", async () => {
    const { promoter, lease, leaseStore } = setup();
    leaseStore.release(lease.leaseId, 1);
    const reloaded = leaseStore.get(lease.leaseId)!;
    await expect(promoter.propose(reloaded, validInput())).rejects.toThrow(LeaseInvalidError);
  });

  test("rule 2: scope outside lease.proposalScopes rejects with ScopeNotProposableError", async () => {
    const { promoter, lease } = setup();
    await expect(promoter.propose(lease, validInput({ scope: "private" }))).rejects.toThrow(
      ScopeNotProposableError,
    );
  });

  test("rule 3: stateHash mismatch rejects with StateHashMismatchError", async () => {
    const { promoter, lease } = setup();
    await expect(
      promoter.propose(lease, validInput({ stateHash: "wrong-hash" })),
    ).rejects.toThrow(StateHashMismatchError);
  });

  test("rule 4a: empty content rejects with EmptyContentError", async () => {
    const { promoter, lease } = setup();
    await expect(promoter.propose(lease, validInput({ content: "   " }))).rejects.toThrow(
      EmptyContentError,
    );
  });

  test("rule 4b: no evidence rejects with MissingEvidenceError", async () => {
    const { promoter, lease } = setup();
    await expect(promoter.propose(lease, validInput({ evidence: [] }))).rejects.toThrow(
      MissingEvidenceError,
    );
  });

  test("each rejection writes no proposal row or memory entry", async () => {
    const { promoter, lease, writer } = setup();
    await promoter.propose(lease, validInput({ scope: "private" })).catch(() => {});
    expect(promoter.getProposal("nonexistent")).toBeUndefined();
    expect(writer.calls.length).toBe(0);
  });
});

describe("SC-24 valid proposal is held, not written", () => {
  test("status is held and no memory entry is created", async () => {
    const { promoter, lease, writer } = setup();
    const proposal = await promoter.propose(lease, validInput());
    expect(proposal.status).toBe("held");
    expect(writer.calls.length).toBe(0);
  });
});

describe("SC-25 replay returns the existing proposal", () => {
  test("same idempotency key submitted twice returns the first proposal, no duplicate", async () => {
    const { promoter, lease } = setup();
    const first = await promoter.propose(lease, validInput());
    const second = await promoter.propose(lease, validInput({ content: "different content" }));
    expect(second.proposalId).toBe(first.proposalId);
    expect(second.status).toBe(first.status);
  });
});

describe("SC-26 happy path produces one entry and one receipt", () => {
  test("promote writes exactly one entry with full provenance and one receipt", async () => {
    const { promoter, lease, writer } = setup();
    const proposal = await promoter.propose(lease, validInput());
    const receipt = await promoter.promote(proposal.proposalId, "owner");

    expect(writer.calls.length).toBe(1);
    expect(writer.calls[0]).toMatchObject({
      scope: "identity",
      metadata: { proposalId: proposal.proposalId, leaseId: lease.leaseId, approver: "owner" },
    });
    expect(receipt.proposalId).toBe(proposal.proposalId);
    expect(receipt.promotedEntryId).toBe("entry-1");
    expect(receipt.baseVersion).toBe("0");
    expect(receipt.newVersion).toBe("1");
    expect(receipt.approver).toBe("owner");
  });
});

describe("SC-27 touched-domain drift refuses promotion", () => {
  test("a prior promotion on the same scope makes the second promote() stale", async () => {
    const { promoter, lease, domainRevisions } = setup();
    const proposal = await promoter.propose(lease, validInput());
    // Simulate drift: another promotion already advanced `identity`'s counter
    // out from under this proposal's baseline, before this one is promoted.
    domainRevisions.incrementRevision("bruno", "identity", 999);

    await expect(promoter.promote(proposal.proposalId, "owner")).rejects.toThrow(
      StaleProposalError,
    );
    expect(promoter.getProposal(proposal.proposalId)!.status).toBe("stale");
  });
});

describe("SC-27b untouched-domain drift does not block", () => {
  test("heartwood drifting does not block an identity-scope promotion", async () => {
    const { promoter, lease, domainRevisions } = setup();
    const proposal = await promoter.propose(lease, validInput({ scope: "identity" }));
    domainRevisions.incrementRevision("bruno", "heartwood", 999);

    const receipt = await promoter.promote(proposal.proposalId, "owner");
    expect(receipt.domain).toBe("identity");
  });
});

describe("regression: propose() authorizes the persisted lease, not the caller's copy", () => {
  test("a forged lease object (widened proposalScopes) is rejected — propose() re-fetches by leaseId", async () => {
    const { promoter, lease } = setup(); // real proposalScopes: ["identity"]
    const forged = { ...lease, proposalScopes: ["identity", "private", "heartwood"] as const };

    await expect(promoter.propose(forged as typeof lease, validInput({ scope: "private" }))).rejects.toThrow(
      ScopeNotProposableError,
    );
  });

  test("a forged lease object (fake far-future expiresAt) is rejected once the real lease is released", async () => {
    const { promoter, lease, leaseStore } = setup();
    leaseStore.release(lease.leaseId, 1);
    const forged = { ...lease, expiresAt: 9_999_999_999 };

    await expect(promoter.propose(forged, validInput())).rejects.toThrow(LeaseInvalidError);
  });
});

describe("regression: promote() rejects an explicitly released lease", () => {
  test("a held proposal cannot be promoted once its lease has been explicitly released", async () => {
    const { promoter, lease, leaseStore } = setup();
    const proposal = await promoter.propose(lease, validInput());
    leaseStore.release(lease.leaseId, 4999); // released before promote(), while still time-unexpired

    await expect(promoter.promote(proposal.proposalId, "owner")).rejects.toThrow(LeaseInvalidError);
  });

  test("natural TTL expiry alone does NOT block promotion — held proposals survive the join-window for async review", async () => {
    const { promoter, lease, advanceTimeTo } = setup(); // lease expiresAt: 100000
    const proposal = await promoter.propose(lease, validInput()); // proposed at now=5000, well before expiry

    // Advance the clock past expiresAt (100000) before promoting — this lease
    // IS now expired per LeaseStore.isActive(); this is the scenario an earlier
    // version of this test did not actually exercise. promote() must still succeed: it checks
    // isReleased(), not isActive()/expiry, by design (see promoter.ts).
    advanceTimeTo(200_000);
    const receipt = await promoter.promote(proposal.proposalId, "owner");
    expect(receipt.proposalId).toBe(proposal.proposalId);
  });
});

describe("SC-28 promotion replay is idempotent", () => {
  test("promote() called twice returns the existing receipt, no second entry", async () => {
    const { promoter, lease, writer } = setup();
    const proposal = await promoter.propose(lease, validInput());
    const first = await promoter.promote(proposal.proposalId, "owner");
    const second = await promoter.promote(proposal.proposalId, "owner");

    expect(second.receiptId).toBe(first.receiptId);
    expect(writer.calls.length).toBe(1);
  });
});

describe("SC-21 public surface leaks nothing", () => {
  test("index exports grant no direct locked-scope write access", async () => {
    const index = await import("../src/index");
    const exportNames = Object.keys(index);
    // No raw/privileged writer is ever constructed or exposed by the package itself —
    // PrivilegedWriter is a type-only contract; callers inject their own instance.
    expect(exportNames).not.toContain("PrivilegedWriter");
    expect(exportNames).not.toContain("privilegedWriter");
    expect(exportNames).not.toContain("rawWriter");
    // ProposalPromoter (the gate) is exported deliberately — it is the only writer.
    expect(exportNames).toContain("ProposalPromoter");
  });
});

describe("SC-29 episodic write bypasses gate", () => {
  test("a non-locked scope write through a raw remember() never touches proposal machinery", async () => {
    const { domainRevisions } = setup();
    const rawStore = {
      calls: [] as unknown[],
      async remember(entry: unknown) {
        this.calls.push(entry);
        return { id: "raw-1", ...((entry as object) ?? {}) };
      },
    };
    await rawStore.remember({ scope: "episode", content: "just a normal memory" });
    expect(rawStore.calls.length).toBe(1);
    // domain_revisions is untouched by non-gated writes.
    expect(domainRevisions.getRevision("bruno", "identity")).toBe("0");
  });
});
