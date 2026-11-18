import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { EliRuntime } from "../src/runtime.ts";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function continuity(): RemoteContinuityPort {
  return {
    compile: async () => ({ projection: { prompt: "Eli", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" }, grant: { grantId: "grant", identity: "eli", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], issuedAt: 1, expiresAt: 10_000 } }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
  };
}

test("rejects stale state and widened scope before forwarding a remember", async () => {
  root = mkdtempSync(join(tmpdir(), "eli-remember-"));
  const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: continuity(), now: () => 1 });
  const joined = await runtime.join({ clientId: "client", surfaceId: "surface", message: "hello" });
  const base = { leaseId: joined.leaseId, clientId: "client", capabilityToken: joined.capabilityToken, idempotencyKey: "key", entry: { scope: "scent", content: "memory", tags: [], confidence: 1, source: "test" } };
  await expect(runtime.remember({ ...base, stateHash: "stale" })).rejects.toThrow("stateHash is stale");
  await expect(runtime.remember({ ...base, stateHash: joined.stateHash, idempotencyKey: "scope", entry: { ...base.entry, scope: "identity" } })).rejects.toThrow("scope is not granted");
  runtime.close();
});

test("returns the completed result for a duplicate idempotency key without a second canonical call", async () => {
  root = mkdtempSync(join(tmpdir(), "eli-remember-"));
  let writes = 0;
  const remote = continuity();
  remote.remember = async () => { writes += 1; return { id: "memory", createdAt: "now" }; };
  const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: remote, now: () => 1 });
  const joined = await runtime.join({ clientId: "client", surfaceId: "surface", message: "hello" });
  const request = { leaseId: joined.leaseId, clientId: "client", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "same", entry: { scope: "scent", content: "memory", tags: [], confidence: 1, source: "test" } };
  await expect(runtime.remember(request)).resolves.toEqual({ id: "memory", createdAt: "now" });
  await expect(runtime.remember(request)).resolves.toEqual({ id: "memory", createdAt: "now" });
  expect(writes).toBe(1);
  runtime.close();
});
