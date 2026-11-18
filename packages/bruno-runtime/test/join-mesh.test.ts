import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { BrunoRuntime, type MeshRegistrationPort } from "../src/runtime.ts";
import { slugifyInstanceId } from "../../eli-runtime/src/instance-id.ts";

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

describe("BrunoRuntime mesh registration", () => {
  test("SC-004: a successful join registers the derived instance_id exactly once", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const calls: Array<{ instance_id: string; agent_name?: string; platform?: string; active?: boolean }> = [];
    const mesh: MeshRegistrationPort = { registerRecipient: (reg) => { calls.push(reg); } };
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh, platform: "macos" });

    await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ instance_id: slugifyInstanceId("bruno", "cli-session"), platform: "macos", active: true });
    runtime.close();
  });

  test("SC-005: repeated joins with the same surfaceId register the identical instance_id every time (no first/subsequent branch)", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const calls: Array<{ instance_id: string }> = [];
    const mesh: MeshRegistrationPort = { registerRecipient: (reg) => { calls.push(reg); } };
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh });

    await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });
    await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall again." });

    expect(calls).toHaveLength(2);
    expect(calls[0].instance_id).toBe(calls[1].instance_id);
    runtime.close();
  });

  test("SC-006: a mesh registration failure never fails the join", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const mesh: MeshRegistrationPort = { registerRecipient: () => { throw new Error("mesh db locked"); } };
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh });

    const joined = await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });

    expect(joined.leaseId).toBeTruthy();
    runtime.close();
  });

  test("SC-006b: join() touches only registerRecipient on the mesh port, nothing else", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const accessed: string[] = [];
    const mesh = new Proxy({} as MeshRegistrationPort, {
      get(_t, prop: string) {
        accessed.push(prop);
        if (prop === "registerRecipient") return () => {};
        throw new Error(`unexpected mesh port access: ${String(prop)}`);
      },
    });
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh });

    await runtime.join({ clientId: "cli", surfaceId: "cli-session", message: "Recall." });

    expect(accessed).toEqual(["registerRecipient"]);
    runtime.close();
  });

  test("SC-005b: neither instance-id.ts nor runtime.ts's join() reads host/env for instance_id", () => {
    const instanceIdSrc = readFileSync(join(import.meta.dir, "../../eli-runtime/src/instance-id.ts"), "utf-8");
    const runtimeSrc = readFileSync(join(import.meta.dir, "../src/runtime.ts"), "utf-8");
    for (const src of [instanceIdSrc, runtimeSrc]) {
      expect(src).not.toMatch(/hostname\s*\(/);
      expect(src).not.toMatch(/Bun\.env/);
      expect(src).not.toMatch(/process\.env/);
    }
  });

  test("SC-010: two joins differing only in surfaceId register two distinct instance_ids", async () => {
    root = mkdtempSync(join(tmpdir(), "bruno-runtime-"));
    const calls: Array<{ instance_id: string }> = [];
    const mesh: MeshRegistrationPort = { registerRecipient: (reg) => { calls.push(reg); } };
    const continuity: RemoteContinuityPort = {
      compile: async (req) => ({
        projection: {
          prompt: "Bruno projection", promptStaticHash: "static-1", kernelVersion: "kernel-1",
          cartridgeVersions: {}, substrateViewVersion: "view-1", readScopes: [], writeScopes: ["scent"],
          proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented",
        },
        grant: {
          grantId: "grant-1", identity: "bruno", surfaceId: req.surfaceId, projectionId: "projection-1",
          stateHash: "state-1", writeScopes: ["scent"], issuedAt: 1_000, expiresAt: 2_000,
        },
      }),
      remember: async () => ({ id: "memory-1", createdAt: "2026-08-14T00:00:00.000Z" }),
      recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
    };
    const runtime = new BrunoRuntime({ dbPath: join(root, "runtime.db"), continuity, now: () => 1_000, mesh });

    await runtime.join({ clientId: "a", surfaceId: "example-heartbeat", message: "Recall." });
    await runtime.join({ clientId: "b", surfaceId: "cli-session", message: "Recall." });

    expect(calls).toHaveLength(2);
    expect(calls[0].instance_id).not.toBe(calls[1].instance_id);
    runtime.close();
  });
});
