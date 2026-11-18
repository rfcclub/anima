import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityRuntime } from "../packages/identity-runtime/src/runtime.ts";
import { beginCodexTurn, createCodexIdentityRuntimeClient, runCodexTurn } from "../integrations/codex-identity-runtime/index.ts";
import { beginClaudeCodeTurn, createClaudeCodeIdentityRuntimeClient, runClaudeCodeTurn } from "../integrations/claude-code-identity-runtime/index.ts";
import { IdentityRuntimeClient, VersionedIdentityTransport } from "../packages/identity-runtime/src/transport.ts";
import { IdentityRuntimeRegistry } from "../packages/identity-runtime/src/runtime-registry.ts";
import type { AgentMemoryEntry, AgentMemoryStore } from "../src/memory/contract.ts";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

class Store implements AgentMemoryStore {
  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> { return { ...entry, id: "id", createdAt: "now" }; }
  async recall(): Promise<AgentMemoryEntry[]> { return []; }
  async bootstrap(): Promise<AgentMemoryEntry[]> { return []; }
  async forget(): Promise<void> {}
}

test("Codex and Claude Code join before their turns and receive capability-only context", async () => {
  root = mkdtempSync(join(tmpdir(), "surface-runtime-"));
  const runtime = new IdentityRuntime({
    agentId: "eli", dbPath: join(root, "continuity.db"), rawStore: new Store(),
    composeProjection: async () => ({ prompt: "Eli projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: ["identity"], writeScopes: ["scent"], proposalScopes: ["identity"], declaredSubstrateScopes: ["identity_core"], scopeDeclarationStatus: "implemented" }),
  });
  const registry = new IdentityRuntimeRegistry();
  registry.register(runtime, join(root, "continuity.db"));
  const transport = new VersionedIdentityTransport(registry, { token: "bootstrap" });
  const server = transport.listen({ hostname: "127.0.0.1", port: 0 });
  const [codex, claude] = await Promise.all([
    beginCodexTurn(new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "codex", bootstrapToken: "bootstrap" })),
    beginClaudeCodeTurn(new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "claude-code", bootstrapToken: "bootstrap" })),
  ]);
  expect(codex.projection).toBe("Eli projection");
  expect(claude.projection).toBe("Eli projection");
  expect(JSON.stringify(codex)).not.toContain("continuity.db");
  expect(JSON.stringify(claude)).not.toContain("continuity.db");
  expect(JSON.stringify(codex)).not.toContain("capabilityToken");
  expect(JSON.stringify(claude)).not.toContain("capabilityToken");
  server.stop();
  runtime.close();
});

test("opted-in surface adapters fail closed when their local endpoint credential is absent", () => {
  expect(() => createCodexIdentityRuntimeClient({ agentId: "eli", env: {} })).toThrow("IDENTITY_RUNTIME_ENDPOINT");
  expect(() => createClaudeCodeIdentityRuntimeClient({ agentId: "eli", env: {} })).toThrow("IDENTITY_RUNTIME_ENDPOINT");
});

test("surface lifecycle hooks inject the server projection before model invocation and retain only the remote capability", async () => {
  root = mkdtempSync(join(tmpdir(), "surface-lifecycle-runtime-"));
  const runtime = new IdentityRuntime({ agentId: "eli", dbPath: join(root, "continuity.db"), rawStore: new Store(), composeProjection: async () => ({ prompt: "Eli projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: ["identity"], writeScopes: ["scent"], proposalScopes: ["identity"], declaredSubstrateScopes: ["identity_core"], scopeDeclarationStatus: "implemented" }) });
  const registry = new IdentityRuntimeRegistry(); registry.register(runtime, join(root, "continuity.db"));
  const server = new VersionedIdentityTransport(registry, { token: "bootstrap" }).listen({ hostname: "127.0.0.1", port: 0 });
  const codex = new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "codex", bootstrapToken: "bootstrap" });
  const claude = new IdentityRuntimeClient({ endpoint: `http://127.0.0.1:${server.port}`, agentId: "eli", clientId: "claude", bootstrapToken: "bootstrap" });
  const seen: string[] = [];
  await runCodexTurn(codex, async ({ system, identityRuntime }) => { seen.push(`codex:${system}`); expect(identityRuntime).toBe(codex); return undefined; });
  await runClaudeCodeTurn(claude, async ({ system, identityRuntime }) => { seen.push(`claude:${system}`); expect(identityRuntime).toBe(claude); return undefined; });
  expect(seen).toEqual(["codex:Eli projection", "claude:Eli projection"]);
  server.stop(); runtime.close();
});
