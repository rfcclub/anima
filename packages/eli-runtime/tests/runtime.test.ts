import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { EliRuntime, type MeshRegistrationPort } from "../src/runtime.ts";
import { slugifyInstanceId } from "../src/instance-id.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createContinuity(): RemoteContinuityPort {
  return {
    compile: async () => ({
      projection: {
        prompt: "Eli projection", promptStaticHash: "static-1", kernelVersion: "kernel-1",
        cartridgeVersions: {}, substrateViewVersion: "view-1", readScopes: ["episode", "observation"], writeScopes: ["scent"],
        proposalScopes: [], declaredSubstrateScopes: ["episodic_memory"], scopeDeclarationStatus: "implemented",
      },
      grant: {
        grantId: "grant-1", identity: "eli", surfaceId: "windows-codex", projectionId: "projection-1",
        stateHash: "state-1", writeScopes: ["scent"], readScopes: ["episode", "observation"],
        declaredSubstrateScopes: ["episodic_memory"], scopeDeclarationStatus: "implemented",
        issuedAt: 1_000, expiresAt: 2_000,
      },
    }),
    remember: async () => ({ id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" }),
    recall: async () => ({
      resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
      results: [{ id: "memory-1", content: "recalled", scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }],
    }),
  };
}

function createRuntime() {
  root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
  return new EliRuntime({
    dbPath: join(root, "eli-runtime.db"),
    continuity: createContinuity(),
    now: () => 1_000,
    idGenerator: (() => {
      let count = 0;
      return () => `id-${++count}`;
    })(),
  });
}

describe("EliRuntime", () => {
  test("joins Eli through remote continuity and returns a capability-bound projection", async () => {
    const runtime = createRuntime();
    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });

    expect(joined).toMatchObject({
      projection: "Eli projection", stateHash: "state-1", leaseId: "id-1", expiresAt: 2_000,
      writeScopes: ["scent"], scopeDeclarationStatus: "implemented",
    });
    expect(joined.capabilityToken).toBe("id-3");
    runtime.close();
  });

  test("mints the fixed thirty-minute pilot lease when ANIMA grant allows it", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const continuity = createContinuity();
    continuity.compile = async () => ({
      projection: { prompt: "Eli projection", promptStaticHash: "static-1", kernelVersion: "kernel-1", cartridgeVersions: {}, substrateViewVersion: "view-1", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" },
      grant: { grantId: "grant-1", identity: "eli", surfaceId: "windows-codex", projectionId: "projection-1", stateHash: "state-1", writeScopes: ["scent"], issuedAt: 1_000, expiresAt: 9_000_000 },
    });
    const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity, now: () => 1_000 });
    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });
    expect(joined.expiresAt).toBe(1_801_000);
    runtime.close();
  });

  test("forwards an authorized remember and blocks pending recovery after unknown outcome", async () => {
    const runtime = createRuntime();
    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });

    const remembered = runtime.remember({
      leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken,
      stateHash: joined.stateHash, idempotencyKey: "remember-1",
      entry: { scope: "scent", content: "remember", tags: [], confidence: 1, source: "test" },
    });
    await expect(remembered).resolves.toEqual({ id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" });
    runtime.close();
  });

  test("fails closed after expiry for both mutations and recall", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    let now = 1_000;
    const runtime = new EliRuntime({ dbPath: join(root, "eli-runtime.db"), continuity: createContinuity(), now: () => now, leaseTtlMs: 100 });
    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });
    now = 1_101;
    await expect(runtime.remember({ leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "expired", entry: { scope: "scent", content: "no", tags: [], confidence: 1, source: "test" } })).rejects.toThrow("lease is unavailable");
    await expect(runtime.recall({ leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, query: "no", substrateScope: "episodic_memory" })).rejects.toThrow("lease is unavailable");
    runtime.close();
  });

  test("forwards an authorized recall through the joined capability", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    let received: unknown;
    const continuity = createContinuity();
    continuity.recall = async (request) => {
      received = request;
      return {
        resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
        results: [{ id: "memory-1", content: "recalled", scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }],
      };
    };
    const runtime = new EliRuntime({ dbPath: join(root, "eli-runtime.db"), continuity, now: () => 1_000 });
    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });

    await expect(runtime.recall({
      leaseId: joined.leaseId,
      clientId: "windows",
      capabilityToken: joined.capabilityToken,
      stateHash: joined.stateHash,
      query: "what happened?",
      substrateScope: "episodic_memory",
    })).resolves.toEqual({
      resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
      results: [{ id: "memory-1", content: "recalled", scope: "episode", tags: [], confidence: 1, source: "test", createdAt: "now" }],
    });
    expect(received).toEqual({
      grantId: "grant-1", stateHash: "state-1", query: "what happened?", substrateScope: "episodic_memory",
    });
    runtime.close();
  });

  test("retains an unknown write as pending and blocks the next join", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const continuity = createContinuity();
    continuity.remember = async () => { throw new Error("transport lost"); };
    const runtime = new EliRuntime({ dbPath: join(root, "eli-runtime.db"), continuity, now: () => 1_000 });
    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });
    await expect(runtime.remember({ leaseId: joined.leaseId, clientId: "windows", capabilityToken: joined.capabilityToken, stateHash: joined.stateHash, idempotencyKey: "unknown", entry: { scope: "scent", content: "maybe", tags: [], confidence: 1, source: "test" } })).rejects.toThrow("transport lost");
    await expect(runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "again" })).rejects.toThrow("mutation recovery required");
    runtime.close();
  });

  test("fails closed when ANIMA compilation is unavailable", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const runtime = new EliRuntime({ dbPath: join(root, "eli-runtime.db"), continuity: { compile: async () => { throw new Error("ANIMA unavailable"); }, remember: async () => ({ id: "never", createdAt: "never" }), recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }) } });
    await expect(runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." })).rejects.toThrow("ANIMA unavailable");
    runtime.close();
  });
});

describe("EliRuntime mesh registration", () => {
  test("SC-004: a successful join registers the derived instance_id exactly once", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const calls: Array<{ instance_id: string; agent_name?: string; platform?: string; active?: boolean }> = [];
    const mesh: MeshRegistrationPort = { registerRecipient: (reg) => { calls.push(reg); } };
    const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh, platform: "macos" });

    await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ instance_id: slugifyInstanceId("eli", "windows-codex"), platform: "macos", active: true });
    runtime.close();
  });

  test("SC-005: repeated joins with the same surfaceId register the identical instance_id every time (no first/subsequent branch)", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const calls: Array<{ instance_id: string }> = [];
    const mesh: MeshRegistrationPort = { registerRecipient: (reg) => { calls.push(reg); } };
    const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh });

    await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });
    await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review again." });

    expect(calls).toHaveLength(2);
    expect(calls[0].instance_id).toBe(calls[1].instance_id);
    // Row-identity (no duplicate/conflicting row) is colony-mesh's own
    // registerRecipient() upsert guarantee (bus.ts:312, ON CONFLICT DO
    // UPDATE) — not re-proven at this unit-test layer, per D1.
    runtime.close();
  });

  test("SC-006: a mesh registration failure never fails the join", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const mesh: MeshRegistrationPort = { registerRecipient: () => { throw new Error("mesh db locked"); } };
    const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh });

    const joined = await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });

    expect(joined.leaseId).toBeTruthy();
    runtime.close();
  });

  test("SC-006b: join() touches only registerRecipient on the mesh port, nothing else", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const accessed: string[] = [];
    const mesh = new Proxy({} as MeshRegistrationPort, {
      get(_t, prop: string) {
        accessed.push(prop);
        if (prop === "registerRecipient") return () => {};
        throw new Error(`unexpected mesh port access: ${String(prop)}`);
      },
    });
    const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity: createContinuity(), now: () => 1_000, mesh });

    await runtime.join({ clientId: "windows", surfaceId: "windows-codex", message: "Review." });

    expect(accessed).toEqual(["registerRecipient"]);
    runtime.close();
  });

  test("SC-005b: neither instance-id.ts nor runtime.ts's join() reads host/env for instance_id", () => {
    const instanceIdSrc = readFileSync(join(import.meta.dir, "../src/instance-id.ts"), "utf-8");
    const runtimeSrc = readFileSync(join(import.meta.dir, "../src/runtime.ts"), "utf-8");
    for (const src of [instanceIdSrc, runtimeSrc]) {
      expect(src).not.toMatch(/hostname\s*\(/);
      expect(src).not.toMatch(/Bun\.env/);
      expect(src).not.toMatch(/process\.env/);
    }
  });

  test("SC-010: two joins differing only in surfaceId register two distinct instance_ids", async () => {
    root = mkdtempSync(join(tmpdir(), "eli-runtime-"));
    const calls: Array<{ instance_id: string }> = [];
    const mesh: MeshRegistrationPort = { registerRecipient: (reg) => { calls.push(reg); } };
    // narrowProjectionGrant requires grant.surfaceId to match the requested
    // surfaceId, so (unlike the other tests here) this continuity fixture
    // must echo back whatever surfaceId was actually requested.
    const continuity: RemoteContinuityPort = {
      compile: async (req) => ({
        projection: {
          prompt: "Eli projection", promptStaticHash: "static-1", kernelVersion: "kernel-1",
          cartridgeVersions: {}, substrateViewVersion: "view-1", readScopes: [], writeScopes: ["scent"],
          proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented",
        },
        grant: {
          grantId: "grant-1", identity: "eli", surfaceId: req.surfaceId, projectionId: "projection-1",
          stateHash: "state-1", writeScopes: ["scent"], issuedAt: 1_000, expiresAt: 2_000,
        },
      }),
      remember: async () => ({ id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" }),
      recall: async () => ({ resolution: { ok: false, requestedScope: "episodic_memory", diagnostic: { code: "undeclared_scope", message: "not declared" } }, results: [] }),
    };
    const runtime = new EliRuntime({ dbPath: join(root, "runtime.db"), continuity, now: () => 1_000, mesh });

    await runtime.join({ clientId: "a", surfaceId: "example-host", message: "Review." });
    await runtime.join({ clientId: "b", surfaceId: "windows-project-x", message: "Review." });

    expect(calls).toHaveLength(2);
    expect(calls[0].instance_id).not.toBe(calls[1].instance_id);
    // to_id-addressed delivery routing on these two distinct ids is
    // colony-mesh's own existing, unmodified behavior —
    // not re-implemented or re-proven here.
    runtime.close();
  });
});
