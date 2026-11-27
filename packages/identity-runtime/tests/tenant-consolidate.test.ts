import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConsolidateRejectedError,
  REMOTE_CONSOLIDATE_LIMITS,
  type ActiveJoinIntent,
  type RemoteCompileResult,
  type RemoteConsolidateRequest,
  type RemoteConsolidateResult,
  type RemoteContinuityPort,
  type RemoteRecallRequest,
  type RemoteRememberRequest,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { TenantIdentityRuntime } from "../src/tenant-runtime.ts";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function batch(overrides: Partial<RemoteConsolidateRequest["batch"]> = {}): RemoteConsolidateRequest["batch"] {
  return {
    sessionId: "session-1",
    sequence: 0,
    summary: "Refactored the ingestion path and fixed a flaky test.",
    candidates: [{ claim: "the ingestion path is now streaming", evidence: "one test went green", confidence: 0.7 }],
    ...overrides,
  };
}

/** A continuity port whose consolidate records calls and answers like ANIMA would. */
function createContinuity(options: {
  writeScopes?: string[];
  consolidate?: (request: RemoteConsolidateRequest) => Promise<RemoteConsolidateResult>;
} = {}) {
  const calls: RemoteConsolidateRequest[] = [];
  const compile = async (input: ActiveJoinIntent): Promise<RemoteCompileResult> => ({
    projection: {
      prompt: "eli projection",
      promptStaticHash: "static",
      kernelVersion: "kernel",
      cartridgeVersions: {},
      substrateViewVersion: "view",
      readScopes: ["episode", "observation"],
      writeScopes: options.writeScopes ?? ["episode"],
      proposalScopes: [],
      declaredSubstrateScopes: ["episodic_memory"],
      scopeDeclarationStatus: "implemented",
    },
    grant: {
      grantId: "grant",
      identity: input.identity,
      surfaceId: input.surfaceId,
      projectionId: "projection",
      stateHash: "state",
      writeScopes: options.writeScopes ?? ["episode"],
      expiresAt: 10_000,
    },
  });
  const port: RemoteContinuityPort = {
    compile,
    remember: async (_request: RemoteRememberRequest) => ({ id: "memory", createdAt: "now" }),
    recall: async (request: RemoteRecallRequest) => ({
      resolution: { ok: true, requestedScope: request.substrateScope, memoryScopes: ["episode"] },
      results: [],
    }),
    consolidate: async (request) => {
      calls.push(request);
      if (options.consolidate) return options.consolidate(request);
      return { episodeId: "episode-1", proposals: request.batch.candidates?.length ?? 0, duplicates: 0 };
    },
  };
  return { port, calls };
}

async function joined(port: RemoteContinuityPort) {
  root = mkdtempSync(join(tmpdir(), "tenant-consolidate-"));
  const runtime = new TenantIdentityRuntime({
    dbPath: join(root, "runtime.db"),
    tenants: new Map([["eli", { continuity: port }]]),
    now: () => 1_000,
  });
  const admission = await runtime.join("eli", { clientId: "eli-cli", surfaceId: "codex", message: "hello" });
  const auth = { leaseId: admission.leaseId, clientId: "eli-cli", sessionToken: admission.sessionToken };
  return { runtime, auth, stateHash: admission.stateHash };
}

describe("remote session-end consolidate", () => {
  test("a batch sent twice with the same idempotency key is stored once", async () => {
    const { port, calls } = createContinuity();
    const { runtime, auth, stateHash } = await joined(port);
    const input = { ...auth, stateHash, idempotencyKey: "session-1:0", batch: batch() };

    const first = await runtime.consolidate(input);
    const second = await runtime.consolidate(input);

    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    runtime.close();
  });

  test("a batch outside the lease's scopes is refused and writes nothing", async () => {
    const { port, calls } = createContinuity({ writeScopes: ["scent"] });
    const { runtime, auth, stateHash } = await joined(port);

    await expect(runtime.consolidate({ ...auth, stateHash, idempotencyKey: "k", batch: batch() }))
      .rejects.toBeInstanceOf(ConsolidateRejectedError);
    expect(calls).toEqual([]);
    runtime.close();
  });

  test("a batch over the size cap or with an expired lease is refused and writes nothing", async () => {
    const { port, calls } = createContinuity();
    const { runtime, auth, stateHash } = await joined(port);

    await expect(runtime.consolidate({
      ...auth, stateHash, idempotencyKey: "k",
      batch: batch({ summary: "x".repeat(REMOTE_CONSOLIDATE_LIMITS.summaryChars + 1) }),
    })).rejects.toBeInstanceOf(ConsolidateRejectedError);
    await expect(runtime.consolidate({
      ...auth, stateHash, idempotencyKey: "k2", batch: batch({ sessionId: "" }),
    })).rejects.toBeInstanceOf(ConsolidateRejectedError);
    expect(calls).toEqual([]);

    // An unknown session token proves no lease is held and writes nothing either.
    await expect(runtime.consolidate({
      ...auth, sessionToken: "not-the-session", stateHash, idempotencyKey: "k3", batch: batch(),
    })).rejects.toBeInstanceOf(ConsolidateRejectedError);
    expect(calls).toEqual([]);
    runtime.close();
  });

  test("an unknown-outcome write stays pending and a retry completes without a duplicate", async () => {
    let failNext = true;
    const { port, calls } = createContinuity({
      consolidate: async (request) => {
        if (failNext) { failNext = false; throw new Error("fetch failed"); }
        return { episodeId: "episode-1", proposals: request.batch.candidates?.length ?? 0, duplicates: 0 };
      },
    });
    const { runtime, auth, stateHash } = await joined(port);
    const input = { ...auth, stateHash, idempotencyKey: "session-1:0", batch: batch() };

    await expect(runtime.consolidate(input)).rejects.toThrow("fetch failed");
    // The unknown outcome stays pending, so admission is blocked until recovery.
    expect(runtime.pendingMutations("eli")).toEqual([
      { leaseId: auth.leaseId, operation: "consolidate", idempotencyKey: "session-1:0", createdAt: 1_000 },
    ]);
    // Releasing the stuck row lets the same client retry and complete exactly once.
    runtime.abandonPendingMutation("eli", auth.leaseId, "consolidate", "session-1:0");
    await expect(runtime.consolidate(input)).resolves.toMatchObject({ episodeId: "episode-1" });
    await expect(runtime.consolidate(input)).resolves.toMatchObject({ episodeId: "episode-1" });
    expect(calls).toHaveLength(2);
    runtime.close();
  });

  test("a proven refusal releases the pending row so admission is not blocked", async () => {
    const { port } = createContinuity({
      consolidate: async () => { throw new ConsolidateRejectedError("remote consolidate summary is invalid"); },
    });
    const { runtime, auth, stateHash } = await joined(port);

    await expect(runtime.consolidate({ ...auth, stateHash, idempotencyKey: "k", batch: batch() }))
      .rejects.toBeInstanceOf(ConsolidateRejectedError);
    expect(runtime.pendingMutations("eli")).toEqual([]);
    runtime.close();
  });
});
