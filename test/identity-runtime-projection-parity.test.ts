import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agents/session";
import { AnimaProjectionCompiler } from "../src/identity-runtime/anima-projection-compiler";
import { CartridgeLoader } from "../src/cartridge/loader";
import type { CartridgeEntry, CartridgeRegistry } from "../src/cartridge/registry";
import type { RoomConfig } from "../src/config/types";
import type { LoadedAgent } from "../src/agents/loader";
import { emptySubstratePair } from "./fixtures/substrate-pair";
import { JsonlStore } from "../src/memory/jsonl-store";
import { NullMemoryAdapter } from "../src/memory/null-adapter";
import type { Provider, ProviderRequest } from "../src/providers/interface";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function agent(): LoadedAgent {
  return {
    name: "eli",
    label: "Eli",
    roomDir: "/tmp/eli",
    config: {
      identity: { name: "eli", label: "Eli", identityAnchor: "Eli remains Eli." },
      provider: { type: "openai", model: "gpt-4o" },
      policy: { allowedRoots: [], allowedTools: [] },
      session: { defaultMode: "edit", compactThreshold: 2_000 },
      boot: { gene: "gene.md", sessionContext: [] },
      cartridges: { defaultRole: "programmer" },
    } as RoomConfig,
    geneContent: "Protect continuity.",
    soulContent: "One Eli, many instances.",
    sessionContextFiles: [{ path: "BOOT.md", label: "Boot", content: "Boot context is canonical." }],
    additionalSessionContext: [{ path: "SESSION.md", label: "Session", content: "Additional session context is canonical." }],
    additionalContent: [{ name: "IDENTITY.md", content: "Additional boot material is canonical." }],
    memoryAdapter: new NullMemoryAdapter(),
    ...emptySubstratePair("eli"),
  };
}

function entries(): CartridgeEntry[] {
  return [
    {
      category: "think", kind: "persona", name: "warm", path: "/tmp/warm.md",
      content: "Be warm.", scope: "agent", memory: { writeScopes: ["scent", "decision"] },
    },
    {
      category: "craft", kind: "role", name: "programmer", path: "/tmp/programmer.md",
      content: "Use tests first.", scope: "agent", memory: { writeScopes: ["decision", "fact"] },
    },
  ];
}

function registry() {
  return {
    async list() { return entries(); },
    async expand(entry: CartridgeEntry) { return entry.content; },
  };
}

test("IHI-03 fixed invocation compiler projection is byte-identical to legacy ANIMA composition", async () => {
  root = mkdtempSync(join(tmpdir(), "identity-projection-parity-"));
  let legacyRequest: ProviderRequest | undefined;
  const provider: Provider = {
    name: "fixture",
    async query(request) {
      legacyRequest = request;
      return { message: { role: "assistant", content: "ok" } };
    },
  };
  const loaded = agent();
  const invocationMemoryAdapter = {
    async recall() { return [{ content: "Invocation recall parity fixture." }]; },
  };
  const legacyRegistry = registry();
  const session = new AgentSession({
    store: new JsonlStore(root),
    provider,
    cartridgeRegistry: legacyRegistry as unknown as CartridgeRegistry,
    cartridgeLoader: new CartridgeLoader(),
    log: () => {},
  });

  await session.run({
    agent: loaded,
    message: "implement the compiler",
    mode: "edit",
    sessionId: "parity",
    memoryAdapter: invocationMemoryAdapter as any,
  });
  const projection = await new AnimaProjectionCompiler({
    agent: loaded,
    cartridgeRegistry: registry(),
    cartridgeLoader: new CartridgeLoader(),
    memoryAdapter: invocationMemoryAdapter as any,
  }).compile({
    identity: "eli",
    surfaceId: "anima",
    mode: "edit",
    message: "implement the compiler",
  });

  expect(projection.prompt).toBe(legacyRequest?.system);
  expect(projection.promptStaticHash).toBe(legacyRequest?.staticHash);
  expect(projection.prompt).toContain("Additional session context is canonical.");
  expect(projection.prompt).toContain("Additional boot material is canonical.");
  expect(projection.prompt).toContain("Invocation recall parity fixture.");
});
