import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityRuntime } from "../src/runtime.ts";
import { IdentityRuntimeRegistry } from "../src/runtime-registry.ts";
import { VersionedIdentityTransport } from "../src/transport.ts";
import type { AgentMemoryEntry, AgentMemoryStore } from "../../../src/memory/contract.ts";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

class Store implements AgentMemoryStore {
  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    return { ...entry, id: "entry-1", createdAt: new Date().toISOString() };
  }
  async recall(): Promise<AgentMemoryEntry[]> { return []; }
  async bootstrap(): Promise<AgentMemoryEntry[]> { return []; }
  async forget(): Promise<void> {}
}

function fixture() {
  root = mkdtempSync(join(tmpdir(), "identity-transport-"));
  let now = Date.now();
  let compositionRequest: unknown;
  const runtime = new IdentityRuntime({
    agentId: "eli", dbPath: join(root, "continuity.db"), rawStore: new Store(),
    composeProjection: async (request) => {
      compositionRequest = request;
      return {
      prompt: "Eli projection", promptStaticHash: "static", kernelVersion: "kernel",
      cartridgeVersions: {}, substrateViewVersion: "view", readScopes: ["identity", "heartwood"],
      writeScopes: ["scent"], proposalScopes: ["identity"],
      declaredSubstrateScopes: ["identity_core"],
      scopeDeclarationStatus: "implemented",
      };
    },
    now: () => now,
    leaseTtlMs: 1_000_000,
  });
  const registry = new IdentityRuntimeRegistry();
  registry.register(runtime, join(root, "continuity.db"));
  return {
    runtime,
    transport: new VersionedIdentityTransport(registry, { token: "test-token", approverCredentials: { owner: "approval-token" } }),
    compositionRequest: () => compositionRequest,
    expireLease: () => { now += 1_000_001; },
  };
}

describe("versioned identity transport", () => {
  test("requires authentication and never exposes an authority implementation", async () => {
    const { runtime, transport } = fixture();
    const response = await transport.handle({ version: "v1", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    expect(response).toEqual({ status: 401, body: { error: "unauthorized" } });
    runtime.close();
  });

  test("joins through a versioned authenticated boundary without database details", async () => {
    const { runtime, transport } = fixture();
    const response = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ projection: "Eli projection", leaseId: expect.any(String), scopeDeclarationStatus: "implemented" });
    expect(JSON.stringify(response.body)).not.toContain("continuity.db");
    runtime.close();
  });

  test("passes an explicit compile envelope separately from lease metadata", async () => {
    const { runtime, transport, compositionRequest } = fixture();
    const compile = { identity: "eli", surfaceId: "claude", mode: "edit", message: "implement" };
    const response = await transport.handle({
      version: "v1",
      token: "test-token",
      operation: "join",
      body: { agentId: "eli", clientId: "windows", surfaceId: "claude", compile },
    });
    expect(response.status).toBe(200);
    expect(compositionRequest()).toEqual(compile);
    runtime.close();
  });

  test("rejects a supplied projection without the distinct trusted-compiler capability", async () => {
    const { runtime, transport } = fixture();
    const response = await transport.handle({
      version: "v1",
      token: "test-token",
      operation: "join",
      body: {
        agentId: "eli", clientId: "windows", surfaceId: "claude",
        projection: {
          prompt: "forged", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view",
          readScopes: [], writeScopes: [], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented",
        },
      },
    });
    expect(response).toEqual({ status: 403, body: { error: "untrusted_compiler" } });
    runtime.close();
  });

  test("does not return a projection for an identity identifier without a valid join request", async () => {
    const { runtime, transport } = fixture();
    const response = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli" } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("Eli projection");
    runtime.close();
  });

  test("replays a proposal with the same idempotency key", async () => {
    const { runtime, transport } = fixture();
    const joined = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    const body = joined.body as { leaseId: string; stateHash: string; capabilityToken: string };
    const input = { agentId: "eli", clientId: "windows", leaseId: body.leaseId, scope: "identity", content: "held", evidence: ["test"], stateHash: body.stateHash, idempotencyKey: "same" };
    const first = await transport.handle({ version: "v1", token: body.capabilityToken, operation: "propose", body: input });
    const second = await transport.handle({ version: "v1", token: body.capabilityToken, operation: "propose", body: input });
    expect(first).toEqual(second);
    runtime.close();
  });

  test("replays a non-locked remember with the same idempotency key", async () => {
    const { runtime, transport } = fixture();
    const joined = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    const body = joined.body as { leaseId: string; stateHash: string; capabilityToken: string };
    const input = { agentId: "eli", clientId: "windows", leaseId: body.leaseId, stateHash: body.stateHash, idempotencyKey: "remember-once", entry: { scope: "scent", content: "safe", tags: [], confidence: 1, source: "test" } };
    const first = await transport.handle({ version: "v1", token: body.capabilityToken, operation: "remember", body: input });
    const second = await transport.handle({ version: "v1", token: body.capabilityToken, operation: "remember", body: input });
    expect(first).toEqual(second);
    runtime.close();
  });

  test("binds every post-join request to its client and lease capability", async () => {
    const { runtime, transport } = fixture();
    const joined = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    const body = joined.body as { leaseId: string; capabilityToken: string };
    const response = await transport.handle({
      version: "v1", token: body.capabilityToken, operation: "events",
      body: { agentId: "eli", clientId: "other-client", leaseId: body.leaseId },
    });
    expect(response).toEqual({ status: 401, body: { error: "unauthorized" } });
    runtime.close();
  });

  test("rejects an unsupported transport version before resolving an authority", async () => {
    const { runtime, transport } = fixture();
    const response = await transport.handle({ version: "v2" as "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    expect(response).toEqual({ status: 400, body: { error: "unsupported_version" } });
    runtime.close();
  });

  test("rejects a capability after its persisted lease expires", async () => {
    const { runtime, transport, expireLease } = fixture();
    const joined = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    const body = joined.body as { leaseId: string; capabilityToken: string };
    expireLease();
    const response = await transport.handle({ version: "v1", token: body.capabilityToken, operation: "events", body: { agentId: "eli", clientId: "windows", leaseId: body.leaseId } });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Error" });
    runtime.close();
  });

  test("does not let a normal surface capability promote a locked proposal", async () => {
    const { runtime, transport } = fixture();
    const joined = await transport.handle({ version: "v1", token: "test-token", operation: "join", body: { agentId: "eli", clientId: "windows", surfaceId: "claude" } });
    const body = joined.body as { leaseId: string; stateHash: string; capabilityToken: string };
    const proposed = await transport.handle({
      version: "v1", token: body.capabilityToken, operation: "propose",
      body: { agentId: "eli", clientId: "windows", leaseId: body.leaseId, scope: "identity", content: "held", evidence: ["test"], stateHash: body.stateHash, idempotencyKey: "approval" },
    });
    expect(proposed.status).toBe(200);
    const proposalId = proposed.body.proposalId as string;
    const rejected = await transport.handle({ version: "v1", token: body.capabilityToken, operation: "promote", body: { agentId: "eli", proposalId, approver: "spoofed" } });
    expect(rejected).toEqual({ status: 401, body: { error: "unauthorized" } });
    const promoted = await transport.handle({ version: "v1", token: "approval-token", operation: "promote", body: { agentId: "eli", proposalId, approver: "spoofed" } });
    expect(promoted.status).toBe(200);
    expect(runtime.events({ limit: 10 }).find((event) => event.kind === "promotion")).toMatchObject({ sourceClient: "owner" });
    runtime.close();
  });
});
