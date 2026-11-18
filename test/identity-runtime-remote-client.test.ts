import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityRuntime } from "../packages/identity-runtime/src/runtime.ts";
import { IdentityRuntimeRegistry } from "../packages/identity-runtime/src/runtime-registry.ts";
import { IdentityRuntimeClient, VersionedIdentityTransport, type IdentityRuntimeServer } from "../packages/identity-runtime/src/transport.ts";
import type { AgentMemoryEntry, AgentMemoryStore } from "../src/memory/contract.ts";

let root: string | undefined;
let server: IdentityRuntimeServer | undefined;
afterEach(() => { server?.stop(); server = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

class Store implements AgentMemoryStore {
  writes: AgentMemoryEntry[] = [];
  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    const written = { ...entry, id: `memory-${this.writes.length + 1}`, createdAt: "2026-07-15T00:00:00.000Z" };
    this.writes.push(written);
    return written;
  }
  async recall(): Promise<AgentMemoryEntry[]> { return []; }
  async bootstrap(): Promise<AgentMemoryEntry[]> { return []; }
  async forget(): Promise<void> {}
}

test("a simulated remote Windows client joins the HTTP authority without a SQLite or locked-writer capability", async () => {
  root = mkdtempSync(join(tmpdir(), "identity-remote-client-"));
  const dbPath = join(root, "eli-continuity.db");
  const store = new Store();
  const runtime = new IdentityRuntime({
    agentId: "eli", dbPath, rawStore: store,
    composeProjection: async () => ({
      prompt: "Eli projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view",
      readScopes: ["identity"], writeScopes: ["scent"], proposalScopes: ["identity"], declaredSubstrateScopes: ["identity_core"], scopeDeclarationStatus: "implemented",
    }),
  });
  const registry = new IdentityRuntimeRegistry();
  registry.register(runtime, dbPath);
  server = new VersionedIdentityTransport(registry, { token: "remote-bootstrap", approvers: ["owner"] }).listen({ hostname: "127.0.0.1", port: 0 });

  const windows = new IdentityRuntimeClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    agentId: "eli",
    clientId: "windows-claude",
    bootstrapToken: "remote-bootstrap",
  });
  const joined = await windows.join({
    clientId: "windows-claude",
    surfaceId: "claude-code",
    compile: { identity: "eli", surfaceId: "claude-code", mode: "edit", message: "remote request" },
  });
  const proposal = await windows.propose({
    scope: "identity", content: "remote request", evidence: ["fixture"], stateHash: joined.stateHash, idempotencyKey: "remote-held",
  });

  expect(joined.projection).toBe("Eli projection");
  expect(proposal).toMatchObject({ status: "held" });
  expect(store.writes).toEqual([]);
  await expect(windows.remember(joined.stateHash, "locked-bypass", {
    scope: "identity", content: "bypass attempt", tags: [], confidence: 1, source: "windows",
  })).rejects.toThrow("MemoryScopeViolationError");
  expect(store.writes).toEqual([]);
  expect(JSON.stringify({ joined, windows })).not.toContain(dbPath);
  expect("rawStore" in windows).toBe(false);
  runtime.close();
});
