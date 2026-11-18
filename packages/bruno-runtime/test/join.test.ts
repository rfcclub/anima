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

describe("BrunoRuntime join", () => {
  test("joins Bruno through remote continuity and returns a capability-bound projection", async () => {
    const runtime = createRuntime();
    const joined = await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });

    expect(joined).toMatchObject({
      projection: "Bruno projection", stateHash: "state-1", leaseId: "id-1", expiresAt: 2_000,
      writeScopes: ["scent"], scopeDeclarationStatus: "unimplemented",
    });
    expect(joined.capabilityToken).toBe("id-3");
    runtime.close();
  });

  test("mints the fixed thirty-minute pilot lease when ANIMA grant allows it", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const continuity = createContinuity();
    continuity.compile = async () => ({
      projection: { prompt: "Bruno projection", promptStaticHash: "static-1", kernelVersion: "kernel-1", cartridgeVersions: {}, substrateViewVersion: "view-1", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" },
      grant: { grantId: "grant-1", identity: "bruno", surfaceId: "cli-session", projectionId: "projection-1", stateHash: "state-1", writeScopes: ["scent"], issuedAt: 1_000, expiresAt: 9_000_000 },
    });
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity, now: () => 1_000 });
    const joined = await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });
    expect(joined.expiresAt).toBe(1_801_000);
    runtime.close();
  });

  test("fails closed when ANIMA compilation is unavailable", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const runtime = new BrunoRuntime({ dbPath: join(root, "bruno-runtime.db"), continuity: { compile: async () => { throw new Error("ANIMA unavailable"); }, remember: async () => ({ id: "never", createdAt: "never" }), recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }) } });
    await expect(runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." })).rejects.toThrow("ANIMA unavailable");
    runtime.close();
  });
});
