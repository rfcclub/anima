import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { BrunoRuntime } from "../src/runtime.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createContinuity(): RemoteContinuityPort {
  return {
    compile: async () => ({
      projection: {
        prompt: "Bruno projection", promptStaticHash: "static-1", kernelVersion: "kernel-1",
        cartridgeVersions: {}, substrateViewVersion: "view-1", readScopes: [], writeScopes: ["scent"],
        proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented",
      },
      grant: {
        grantId: "grant-1", identity: "bruno", surfaceId: "cli-session", projectionId: "projection-1",
        stateHash: "state-1", writeScopes: ["scent"], issuedAt: 1_000, expiresAt: 2_000,
      },
    }),
    remember: async () => ({ id: "memory-1", createdAt: "2026-08-14T00:00:00.000Z" }),
    recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
  };
}

function createRuntime() {
  root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
  return new BrunoRuntime({
    dbPath: join(root, "bruno-runtime.db"),
    continuity: createContinuity(),
    now: () => 1_000,
    idGenerator: (() => {
      let count = 0;
      return () => `id-${++count}`;
    })(),
  });
}

describe("BrunoRuntime", () => {
  test("forwards an authorized remember and blocks pending recovery after unknown outcome", async () => {
    const runtime = createRuntime();
    const joined = await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });

    const remembered = runtime.remember({
      leaseId: joined.leaseId, clientId: "cli", capabilityToken: joined.capabilityToken,
      stateHash: joined.stateHash, idempotencyKey: "remember-1",
      entry: { scope: "scent", content: "remember", tags: [], confidence: 1, source: "test" },
    });
    await expect(remembered).resolves.toEqual({ id: "memory-1", createdAt: "2026-08-14T00:00:00.000Z" });
    runtime.close();
  });

  test("fails closed after expiry", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    let now = 1_000;
    const runtime = new BrunoRuntime({ dbPath: join(root, "bruno-runtime.db"), continuity: createContinuity(), now: () => now, leaseTtlMs: 100 });
    const joined = await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });
    now = 1_101;
    await expect(runtime.remember({ leaseId: joined.leaseId, clientId: "cli", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "expired", entry: { scope: "scent", content: "no", tags: [], confidence: 1, source: "test" } })).rejects.toThrow("lease is unavailable");
    runtime.close();
  });

  test("retains an unknown write as pending and blocks the next join", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const continuity = createContinuity();
    continuity.remember = async () => { throw new Error("transport lost"); };
    const runtime = new BrunoRuntime({ dbPath: join(root, "bruno-runtime.db"), continuity, now: () => 1_000 });
    const joined = await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });
    await expect(runtime.remember({ leaseId: joined.leaseId, clientId: "cli", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "unknown", entry: { scope: "scent", content: "maybe", tags: [], confidence: 1, source: "test" } })).rejects.toThrow("transport lost");
    await expect(runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "again" })).rejects.toThrow("mutation recovery required");
    runtime.close();
  });
});
