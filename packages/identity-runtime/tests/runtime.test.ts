import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityRuntime, StaleMutationError } from "../src/runtime.ts";
import type { AgentMemoryEntry, AgentMemoryStore, RecallOptions } from "../../../src/memory/contract.ts";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

class MemoryStoreFixture implements AgentMemoryStore {
  readonly recalls: RecallOptions[] = [];
  readonly writes: Array<Omit<AgentMemoryEntry, "id" | "createdAt">> = [];

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    this.writes.push(entry);
    return { ...entry, id: `memory-${this.writes.length}`, createdAt: "2026-07-15T00:00:00.000Z" };
  }

  async recall(_query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    this.recalls.push(options ?? {});
    return [];
  }

  async bootstrap(): Promise<AgentMemoryEntry[]> { return []; }
  async forget(): Promise<void> {}
}

function createRuntime() {
  tempRoot = mkdtempSync(join(tmpdir(), "identity-runtime-"));
  const store = new MemoryStoreFixture();
  const runtime = new IdentityRuntime({
    agentId: "eli",
    dbPath: join(tempRoot, "continuity.db"),
    rawStore: store,
    now: () => Date.now(),
    idGenerator: (() => {
      let i = 0;
      return () => `id-${++i}`;
    })(),
    composeProjection: async () => ({
      prompt: "Eli projection.",
      promptStaticHash: "fixture-static-hash",
      kernelVersion: "kernel-v1",
      cartridgeVersions: { kernel: "v1" },
      substrateViewVersion: "view-v1",
      readScopes: ["identity", "heartwood", "project", "decision", "canopy", "growth_ring", "scent"],
      writeScopes: ["scent", "decision"],
      proposalScopes: ["identity", "heartwood"],
      declaredSubstrateScopes: ["current_state"],
      scopeDeclarationStatus: "implemented",
    }),
  });
  return { runtime, store };
}

describe("IdentityRuntime (IR-01, IR-03, IR-05)", () => {
  test("uses a separate compiler invocation and rejects a mismatched identity before leasing", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "identity-runtime-compiler-"));
    let received: unknown;
    const runtime = new IdentityRuntime({
      agentId: "eli",
      dbPath: join(tempRoot, "continuity.db"),
      rawStore: new MemoryStoreFixture(),
      composeProjection: async (request) => {
        received = request;
        return {
          prompt: "Eli projection.", promptStaticHash: "fixture-static-hash", kernelVersion: "kernel-v1",
          cartridgeVersions: {}, substrateViewVersion: "view-v1", readScopes: [], writeScopes: ["scent"],
          proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented",
        };
      },
    });
    const compile = { identity: "eli", surfaceId: "claude-code", mode: "edit" as const, message: "implement" };

    await runtime.join({ clientId: "windows", surfaceId: "claude-code" }, compile);
    expect(received).toEqual(compile);
    await expect(runtime.join({ clientId: "windows", surfaceId: "claude-code" }, {
      ...compile,
      identity: "bruno",
    })).rejects.toThrow("compile identity does not match runtime identity");
    runtime.close();
  });

  test("joins server-side and returns a lease-bound session without raw storage", async () => {
    const { runtime } = createRuntime();
    const joined = await runtime.join({ clientId: "windows-claude", surfaceId: "claude-code" });

    expect(joined.projection).toBe("Eli projection.");
    expect(joined.scopeDeclarationStatus).toBe("implemented");
    expect(joined.leaseId).toBe("id-1");
    expect(joined.session.leaseId).toBe("id-1");
    expect("rawStore" in joined.session).toBe(false);
    expect("promoter" in joined.session).toBe(false);
    expect(joined.stateHash).toMatch(/^[0-9a-f]{64}$/);
    runtime.close();
  });

  test("recall uses the lease-bound canonical scope mapping", async () => {
    const { runtime, store } = createRuntime();
    const { session } = await runtime.join({ clientId: "codex", surfaceId: "codex" });

    await session.recall({
      query: "what is active?",
      substrateScope: "current_state",
    });

    expect(store.recalls).toEqual([{ scopes: ["canopy", "growth_ring", "scent"] }]);
    runtime.close();
  });

  test("issues isolated leases with the same deterministic identity state to concurrent surfaces", async () => {
    const { runtime } = createRuntime();
    const [codex, remote] = await Promise.all([
      runtime.join({ clientId: "codex", surfaceId: "codex" }),
      runtime.join({ clientId: "windows", surfaceId: "claude-code" }),
    ]);

    expect(codex.leaseId).not.toBe(remote.leaseId);
    expect(codex.stateHash).toBe(remote.stateHash);
    expect(codex.projection).toBe(remote.projection);
    runtime.close();
  });

  test("records bounded scope-rejection events without memory content", async () => {
    const { runtime, store } = createRuntime();
    const { session } = await runtime.join({ clientId: "codex", surfaceId: "codex" });

    const result = await session.recall({
      query: "private input that must not be stored",
      substrateScope: "shared",
    });

    expect(result.results).toEqual([]);
    expect(store.recalls).toEqual([]);
    const event = runtime.events({ limit: 10 }).find((candidate) => candidate.kind === "scope_rejected");
    expect(event).toMatchObject({ kind: "scope_rejected", outcome: "unknown_scope" });
    expect(JSON.stringify(event)).not.toContain("private input");
    runtime.close();
  });

  test("rejects mutations derived from a stale state hash", async () => {
    const { runtime } = createRuntime();
    const { session } = await runtime.join({ clientId: "codex", surfaceId: "codex" });

    await expect(session.remember({
      stateHash: "superseded",
      idempotencyKey: "invalid",
      entry: { scope: "scent", content: "must not write", tags: [], confidence: 1, source: "test" },
    })).rejects.toBeInstanceOf(StaleMutationError);
    runtime.close();
  });

  test("rejects a second surface after another surface advances runtime state", async () => {
    const { runtime } = createRuntime();
    const first = await runtime.join({ clientId: "first", surfaceId: "codex" });
    const second = await runtime.join({ clientId: "second", surfaceId: "claude-code" });
    await first.session.remember({
      stateHash: first.stateHash,
      idempotencyKey: "first",
      entry: { scope: "scent", content: "fresh", tags: [], confidence: 1, source: "test" },
    });
    await expect(second.session.remember({
      stateHash: second.stateHash,
      idempotencyKey: "second",
      entry: { scope: "scent", content: "stale", tags: [], confidence: 1, source: "test" },
    })).rejects.toBeInstanceOf(StaleMutationError);
    runtime.close();
  });

  test("holds locked writes as proposals and emits metadata-only events", async () => {
    const { runtime, store } = createRuntime();
    const { session, stateHash } = await runtime.join({ clientId: "remote", surfaceId: "claude-code" });

    const proposal = await session.propose({
      scope: "identity",
      content: "locked proposal content",
      evidence: ["session:fixture"],
      idempotencyKey: "proposal-1",
      stateHash,
    });

    expect(proposal.status).toBe("held");
    expect(store.writes).toEqual([]);
    const event = runtime.events({ limit: 10 }).find((candidate) => candidate.kind === "proposal_held");
    expect(event).toMatchObject({ kind: "proposal_held", outcome: "held" });
    expect(JSON.stringify(event)).not.toContain("locked proposal content");
    runtime.close();
  });

  test("promotes a held proposal with an auditable metadata-only receipt", async () => {
    const { runtime, store } = createRuntime();
    const { session, stateHash, leaseId } = await runtime.join({ clientId: "remote", surfaceId: "claude-code" });
    const proposal = await session.propose({ scope: "identity", content: "approved", evidence: ["fixture"], idempotencyKey: "promote", stateHash });

    const receipt = await runtime.promote(proposal.proposalId, "owner");

    expect(receipt.proposalId).toBe(proposal.proposalId);
    expect(store.writes).toHaveLength(1);
    const event = runtime.events({ limit: 10 }).find((candidate) => candidate.kind === "promotion");
    expect(event).toMatchObject({ leaseId, outcome: "promoted" });
    expect(JSON.stringify(event)).not.toContain("approved");
    runtime.close();
  });
});
