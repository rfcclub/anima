import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityRuntime } from "../packages/identity-runtime/src/runtime.ts";
import { IdentityRuntimeRegistry } from "../packages/identity-runtime/src/runtime-registry.ts";
import { IdentityRuntimeClient, type IdentityRuntimeServer, VersionedIdentityTransport } from "../packages/identity-runtime/src/transport.ts";
import type { AgentMemoryEntry, AgentMemoryStore } from "../src/memory/contract.ts";
import type { LoadedAgent } from "../src/agents/loader";
import { emptySubstratePair } from "./fixtures/substrate-pair";
import type { RoomConfig } from "../src/config/types";
import { AnimaProjectionCompiler } from "../src/identity-runtime/anima-projection-compiler";
import { AgentSession } from "../src/agents/session";
import { JsonlStore } from "../src/memory/jsonl-store";
import type { ProviderRequest } from "../src/providers/interface";

let root: string | undefined;
let server: IdentityRuntimeServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

class FixtureStore implements AgentMemoryStore {
  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    return { ...entry, id: "fixture", createdAt: "2026-07-16T00:00:00.000Z" };
  }
  async recall(): Promise<AgentMemoryEntry[]> { return []; }
  async bootstrap(): Promise<AgentMemoryEntry[]> { return []; }
  async forget(): Promise<void> {}
}

function canaryAgent(): LoadedAgent {
  return {
    name: "eli",
    label: "Eli",
    roomDir: "/tmp/eli-canary",
    geneContent: "Fixture instructions.",
    soulContent: "Fixture continuity.",
    sessionContextFiles: [],
    additionalContent: [],
    config: {
      identity: { name: "eli", label: "Eli" },
      provider: { type: "openai" },
      policy: { allowedRoots: [] },
      session: { defaultMode: "edit" },
      boot: { gene: "GENE.md", sessionContext: [] },
    } as RoomConfig,
    ...emptySubstratePair("eli"),
  };
}

test("IHI canary trace joins a compiler-owned projection over HTTP without prompt or substrate disclosure", async () => {
  root = mkdtempSync(join(tmpdir(), "identity-host-canary-"));
  const agent = canaryAgent();
  const compiler = new AnimaProjectionCompiler({ agent });
  let composeCalls = 0;
  let generatedIds = 0;
  const runtime = new IdentityRuntime({
    agentId: "eli",
    dbPath: join(root, "continuity.db"),
    rawStore: new FixtureStore(),
    composeProjection: async (request) => {
      composeCalls += 1;
      return compiler.compile(request as import("../packages/continuity-core/src/projection").ProjectionCompileRequest);
    },
    now: () => 1_784_000_000_000,
    idGenerator: () => `canary-${++generatedIds}`,
  });
  const registry = new IdentityRuntimeRegistry();
  registry.register(runtime, join(root, "continuity.db"));
  server = new VersionedIdentityTransport(registry, { token: "canary-bootstrap", trustedCompilerToken: "canary-compiler" })
    .listen({ hostname: "127.0.0.1", port: 0 });
  const client = new IdentityRuntimeClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    agentId: "eli",
    clientId: "anima:eli",
    bootstrapToken: "canary-bootstrap",
    compilerToken: "canary-compiler",
  });

  const projection = await compiler.compile({ identity: "eli", surfaceId: "anima", mode: "edit", message: "fixture task" });
  const joined = await client.join({
    clientId: "anima:eli",
    surfaceId: "anima",
    compile: { identity: "eli", surfaceId: "anima", mode: "edit", message: "fixture task" },
    projection,
  });
  const safeTrace = {
    identity: "eli",
    surface: "anima",
    projectionId: joined.projectionId,
    stateHash: joined.stateHash,
    leaseId: joined.leaseId,
    expiresAt: joined.expiresAt,
  };

  expect(safeTrace).toMatchObject({ identity: "eli", surface: "anima" });
  expect(safeTrace.leaseId).toMatch(/^canary-/);
  expect(safeTrace.projectionId).toMatch(/^[0-9a-f]{64}$/);
  expect(safeTrace.stateHash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(safeTrace)).not.toContain("Fixture continuity.");
  expect(JSON.stringify(safeTrace)).not.toContain("continuity.db");
  expect(composeCalls).toBe(0);

  (agent.config as RoomConfig).continuity = { identityRuntime: true };
  let providerRequest: ProviderRequest | undefined;
  const session = new AgentSession({
    store: new JsonlStore(root),
    provider: {
      name: "canary-provider",
      async query(request) {
        providerRequest = request;
        return { message: { role: "assistant", content: "canary response" } };
      },
    },
    log: () => {},
  });
  const result = await session.run({
    agent,
    message: "fixture task",
    mode: "edit",
    identityRuntime: client,
  });
  expect(result.response.message.content).toBe("canary response");
  expect(providerRequest?.system).toContain("Fixture continuity.");
  expect(composeCalls).toBe(0);
  runtime.close();
});
