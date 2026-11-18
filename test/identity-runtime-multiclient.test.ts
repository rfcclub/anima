import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityRuntime } from "../packages/identity-runtime/src/runtime.ts";
import { IdentityRuntimeRegistry } from "../packages/identity-runtime/src/runtime-registry.ts";
import { IdentityRuntimeClient, VersionedIdentityTransport } from "../packages/identity-runtime/src/transport.ts";
import type { AgentMemoryEntry, AgentMemoryStore } from "../src/memory/contract.ts";
import { joinAnimaIdentityRuntime } from "../src/identity-runtime/anima-adapter.ts";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
class Store implements AgentMemoryStore {
  writes: AgentMemoryEntry[] = [];
  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> { const written = { ...entry, id: crypto.randomUUID(), createdAt: "now" }; this.writes.push(written); return written; }
  async recall(): Promise<AgentMemoryEntry[]> { return []; }
  async bootstrap(): Promise<AgentMemoryEntry[]> { return []; }
  async forget(): Promise<void> {}
}

test("ANIMA, Codex, and a remote Windows client share one authority while the remote receives no database capability", async () => {
  root = mkdtempSync(join(tmpdir(), "identity-multiclient-"));
  const dbPath = join(root, "continuity.db");
  const store = new Store();
  const runtime = new IdentityRuntime({ agentId: "eli", dbPath, rawStore: store, composeProjection: async () => ({ prompt: "Eli", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: ["identity"], writeScopes: ["scent"], proposalScopes: ["identity"], declaredSubstrateScopes: ["identity_core"], scopeDeclarationStatus: "implemented" }) });
  const registry = new IdentityRuntimeRegistry(); registry.register(runtime, dbPath);
  const transport = new VersionedIdentityTransport(registry, { token: "bootstrap", trustedCompilerToken: "compiler" });
  const server = transport.listen({ hostname: "127.0.0.1", port: 0 });
  const animaClient = new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "anima:eli", bootstrapToken: "bootstrap", compilerToken: "compiler" });
  const localClient = new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "codex", bootstrapToken: "bootstrap" });
  const remoteClient = new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "windows-claude", bootstrapToken: "bootstrap" });
  const [anima, local, remote] = await Promise.all([
    joinAnimaIdentityRuntime(animaClient, {
      clientId: "anima:eli",
      surfaceId: "anima",
      compile: { identity: "eli", surfaceId: "anima", mode: "edit", message: "fixture" },
      projection: {
        prompt: "Eli", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view",
        readScopes: ["identity"], writeScopes: ["scent"], proposalScopes: ["identity"],
        declaredSubstrateScopes: ["identity_core"], scopeDeclarationStatus: "implemented",
      },
    }),
    localClient.join("codex"),
    remoteClient.join("claude-code"),
  ]);
  expect(local.stateHash).toBe(remote.stateHash);
  expect(anima.stateHash).toBe(remote.stateHash);
  expect(local.leaseId).not.toBe(remote.leaseId);
  expect(JSON.stringify(remote)).not.toContain(dbPath);
  await localClient.recall("private input", "shared");
  const events = await localClient.events();
  expect(JSON.stringify(events)).toContain("scope_rejected");
  expect(JSON.stringify(events)).not.toContain("private input");
  const held = await remoteClient.propose({ scope: "identity", content: "locked", evidence: ["test"], stateHash: remote.stateHash, idempotencyKey: "held" });
  expect(held).toMatchObject({ status: "held" });
  expect(store.writes).toEqual([]);
  await localClient.remember(local.stateHash, "fresh", { scope: "scent", content: "fresh", tags: [], confidence: 1, source: "test" });
  await expect(remoteClient.remember(remote.stateHash, "stale", { scope: "scent", content: "stale", tags: [], confidence: 1, source: "test" })).rejects.toThrow("StaleMutationError");
  expect(store.writes).toHaveLength(1);
  server.stop();
  runtime.close();
});
