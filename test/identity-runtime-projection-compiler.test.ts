import { describe, expect, test } from "bun:test";
import { AnimaProjectionCompiler } from "../src/identity-runtime/anima-projection-compiler";
import type { LoadedAgent } from "../src/agents/loader";
import type { RoomConfig } from "../src/config/types";
import type { CartridgeEntry } from "../src/cartridge/registry";
import { CartridgeLoader } from "../src/cartridge/loader";
import { NullMemoryAdapter } from "../src/memory/null-adapter";
import { emptySubstratePair } from "./fixtures/substrate-pair";

function makeAgent(): LoadedAgent {
  return {
    name: "eli",
    label: "Eli",
    roomDir: "/tmp/eli",
    config: {
      identity: {
        name: "eli",
        label: "Eli",
        identityAnchor: "Eli remains Eli.",
      },
      provider: { type: "openai", model: "gpt-4o" },
      policy: { allowedRoots: [], allowedTools: [] },
      session: { defaultMode: "edit", compactThreshold: 2_000 },
      boot: { gene: "gene.md", sessionContext: [] },
      cartridges: { defaultRole: "programmer" },
    } as RoomConfig,
    geneContent: "Protect continuity.",
    soulContent: "One Eli, many instances.",
    sessionContextFiles: [{ path: "BOOT.md", label: "Boot", content: "Boot context is canonical." }],
    additionalContent: [],
    memoryAdapter: new NullMemoryAdapter(),
    ...emptySubstratePair("eli"),
  };
}

function entries(): CartridgeEntry[] {
  return [
    {
      category: "think",
      kind: "persona",
      name: "warm",
      path: "/tmp/warm.md",
      content: "Be warm.",
      scope: "agent",
      memory: { writeScopes: ["scent", "decision"] },
    },
    {
      category: "craft",
      kind: "role",
      name: "programmer",
      path: "/tmp/programmer.md",
      content: "Use tests first.",
      scope: "agent",
      memory: { writeScopes: ["decision", "fact"] },
    },
    {
      category: "operate",
      kind: "task",
      name: "continue-work",
      path: "/tmp/continue-work.md",
      content: "Continue the prior task.",
      scope: "agent",
      memory: { writeScopes: ["decision", "scent"] },
    },
  ];
}

describe("IHI-02 AnimaProjectionCompiler", () => {
  test("compiles boot context and identity anchor with intersected write scopes without writes", async () => {
    let listCalls = 0;
    let expandCalls = 0;
    const registry = {
      async list(identity: string) {
        listCalls += 1;
        expect(identity).toBe("eli");
        return entries();
      },
      async expand(entry: CartridgeEntry) {
        expandCalls += 1;
        return entry.content;
      },
    };
    const compiler = new AnimaProjectionCompiler({
      agent: makeAgent(),
      cartridgeRegistry: registry,
      cartridgeLoader: new CartridgeLoader(),
    });

    const projection = await compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the compiler",
    });

    expect(projection.prompt).toContain("Boot context is canonical.");
    expect(projection.prompt).toContain("Eli remains Eli.");
    expect(projection.writeScopes).toEqual(["decision"]);
    expect(projection.scopeDeclarationStatus).toBe("unimplemented");
    expect(projection.declaredSubstrateScopes).toEqual([]);
    expect(listCalls).toBe(1);
    expect(expandCalls).toBe(2);
  });

  test("fails closed when the request identity does not match the loaded identity", async () => {
    const compiler = new AnimaProjectionCompiler({ agent: makeAgent() });

    await expect(compiler.compile({
      identity: "bruno",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the compiler",
    })).rejects.toThrow("does not match loaded identity");
  });

  test("fails closed instead of substituting an empty soul", async () => {
    const compiler = new AnimaProjectionCompiler({
      agent: { ...makeAgent(), soulContent: "" },
    });

    await expect(compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the compiler",
    })).rejects.toThrow("loaded soul content is required");
  });

  test("takes recent task history as an explicit read input", async () => {
    const compiler = new AnimaProjectionCompiler({
      agent: makeAgent(),
      recentEvents: [{ type: "cartridge_activated", kind: "task", name: "continue-work" }],
      cartridgeRegistry: {
        async list() { return entries(); },
        async expand(entry: CartridgeEntry) { return entry.content; },
      },
      cartridgeLoader: new CartridgeLoader(),
    });

    const projection = await compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "continue",
    });

    expect(projection.prompt).toContain("## Task: continue-work");
  });

  test("uses the invocation memory adapter for cartridge retrieval plans", async () => {
    const invocationAdapter = {
      async recall(_message: string, options: Record<string, unknown>) {
        if (Array.isArray(options.scopes) && options.scopes.includes("fact")) {
          return [{ id: "invocation", content: "Invocation cartridge retrieval.", scope: "fact", confidence: 1 }];
        }
        return [];
      },
    };
    const compiler = new AnimaProjectionCompiler({
      agent: makeAgent(),
      memoryAdapter: invocationAdapter as any,
      cartridgeRegistry: {
        async list() {
          return entries().map((entry) => entry.name === "programmer"
            ? { ...entry, retrieval: { scopes: ["fact"], top_k: 1 } }
            : entry);
        },
        async expand(entry: CartridgeEntry) { return entry.content; },
      },
      cartridgeLoader: new CartridgeLoader(),
    });

    const projection = await compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the compiler",
    });

    expect(projection.prompt).toContain("Invocation cartridge retrieval.");
  });

  test("keeps host context inside the canonical projection before the identity anchor", async () => {
    const compiler = new AnimaProjectionCompiler({
      agent: makeAgent(),
      cartridgeRegistry: {
        async list() { return entries(); },
        async expand(entry: CartridgeEntry) { return entry.content; },
      },
      cartridgeLoader: new CartridgeLoader(),
    });

    const projection = await compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "continue",
      hostContext: ["[Lifecycle Context] resumed session"],
    });

    expect(projection.prompt).toContain("[Lifecycle Context] resumed session");
    expect(projection.prompt.indexOf("[Lifecycle Context] resumed session"))
      .toBeLessThan(projection.prompt.indexOf("Eli remains Eli."));
  });

  test("includes current identity material read from the configured substrate", async () => {
    const agent = makeAgent();
    agent.substrateAdapter = {
      agentId: "eli",
      substrateType: "fixture",
      listScopes: () => [],
      hasScope: () => true,
      resolve: () => ({ name: "fixture", description: "", required: false, files: [] }),
      validateMap: () => ({ valid: true, diagnostics: [] }),
      async retrieve({ scopes }) {
        if (scopes[0] !== "current_state") return [];
        return [{
          id: "current",
          absolutePath: "/tmp/current.md",
          relativePath: "CURRENT.md",
          content: "The current state is deliberate.",
          scopesMatched: ["current_state"],
          sourceIds: ["fixture"],
          trust: "high",
          weight: 1,
          status: "ok",
        }];
      },
    };
    agent.substrateViewLayer = {
      async buildView() {
        return {
          turnContext: {
            agentId: "eli",
            runtimeRequiredScopes: [],
            agentDefaults: { agentId: "eli" },
            cartridgePolicies: [],
            unifiedScopes: [],
            requireEvidence: false,
          },
          results: [],
          estimatedTokens: 0,
          scopesCovered: [],
          scopesMissing: [],
          scopesEmpty: [],
          warnings: [],
        };
      },
    };
    const compiler = new AnimaProjectionCompiler({
      agent,
      cartridgeRegistry: {
        async list() { return entries(); },
        async expand(entry: CartridgeEntry) { return entry.content; },
      },
      cartridgeLoader: new CartridgeLoader(),
    });

    const projection = await compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the compiler",
    });

    expect(projection.prompt).toContain("The current state is deliberate.");
  });

  test("fails closed when a configured substrate view cannot be read", async () => {
    const agent = makeAgent();
    agent.substrateAdapter = {
      agentId: "eli",
      substrateType: "fixture",
      listScopes: () => [],
      hasScope: () => true,
      resolve: () => ({ name: "fixture", description: "", required: false, files: [] }),
      validateMap: () => ({ valid: true, diagnostics: [] }),
      async retrieve() { return []; },
    };
    agent.substrateViewLayer = {
      async buildView() {
        throw new Error("substrate unavailable");
      },
    };
    const compiler = new AnimaProjectionCompiler({
      agent,
      cartridgeRegistry: {
        async list() { return []; },
        async expand(entry: CartridgeEntry) { return entry.content; },
      },
      cartridgeLoader: new CartridgeLoader(),
    });

    await expect(compiler.compile({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the compiler",
    })).rejects.toThrow("substrate unavailable");
  });
});
