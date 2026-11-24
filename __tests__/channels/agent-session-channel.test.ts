import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, type Provider, type ProviderResponse, type ProviderRequest } from "../../src/providers/interface";
import { CircuitBreaker } from "../../src/providers/circuit-breaker";
import { AgentSessionChannel } from "../../src/channels/agent-session-channel";
import { CartridgeLoader } from "../../src/cartridge/loader";
import { CartridgeRegistry } from "../../src/cartridge/registry";
import { SessionStore } from "../../src/memory/session-store";
import type { Store, JsonlEvent } from "../../src/memory/jsonl-store";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import type { LoadedAgent } from "../../src/agents/loader";
import { createMeshChannelTurn, createMeshSessionHandlers } from "../../src/continuity/mesh-session-handlers";
import type { ActivationCandidate } from "../../src/continuity/activation-candidate";
import type { BudgetGrant } from "../../src/continuity/activation-budget";

function makeTempDirs() {
  const base = mkdtempSync(join(tmpdir(), "agent-session-channel-"));
  const roomsDir = join(base, "rooms");
  const agentRoot = join(base, "agent");
  const stateDir = join(base, "state");
  mkdirSync(roomsDir, { recursive: true });
  mkdirSync(agentRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { base, roomsDir, agentRoot, stateDir };
}

function writeAgent(roomsDir: string, agentName: string) {
  const roomDir = join(roomsDir, agentName);
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(
    join(roomDir, "config.yaml"),
    `identity:\n  name: ${agentName}\n  label: Test Agent\nprovider:\n  type: claude\n  model: claude-sonnet\npolicy:\n  allowedRoots: []\n  allowedTools: []\nsession:\n  defaultMode: plan\n  compactThreshold: 60000\nboot:\n  gene: gene.md\n  sessionContext:\n    - path: ctx.md\n`);
  writeFileSync(join(roomDir, "gene.md"), "Core instructions.");
  writeFileSync(join(roomDir, "ctx.md"), "Context.");
}

function fakeStore(): { store: Store; events: JsonlEvent[] } {
  const events: JsonlEvent[] = [];
  const store: Store = {
    append(agent, event) {
      events.push(event);
    },
    readDate: () => [],
    readRecent: () => [],
    recover: () => null,
  };
  return { store, events };
}

function captureProvider(captured: { requests: ProviderRequest[] }) {
  const provider: Provider = {
    name: "fake",
    query(req: ProviderRequest) {
      captured.requests.push(req);
      const response: ProviderResponse = {
        message: { role: "assistant", content: "ok" },
      };
      return Promise.resolve(response);
    },
  };
  return provider;
}

afterEach(() => {
  // no global teardown needed; each test removes its own temp dir
});

test("handleMessage wires cartridges into AgentSession and emits activation event", async () => {
  const { roomsDir, agentRoot, stateDir } = makeTempDirs();
  const agentName = "testa";
  writeAgent(roomsDir, agentName);

  // a pluggable "think" cartridge that will be auto-selected in plan mode
  const pluggableDir = join(agentRoot, "cartridges", "pluggable");
  mkdirSync(pluggableDir, { recursive: true });
  writeFileSync(
    join(pluggableDir, "thinking.md"),
    "---\ntype: cartridge\nname: thinking\ncategory: think\n---\n\nTHINK CARTRIDGE BODY\n");

  const sessionStore = new SessionStore(join(stateDir, "sessions.db"));
  const { store, events } = fakeStore();
  const captured: { requests: ProviderRequest[] } = { requests: [] };
  const provider = captureProvider(captured);

  const channel = new AgentSessionChannel({
    roomsDir,
    provider,
    sessionStore,
  });

  // Inject test-local store and cartridge registry via private fields
  (channel as any).store = store;
  (channel as any).cartridgeLoader = new CartridgeLoader();
  (channel as any).cartridgeRegistry = new CartridgeRegistry({
    projectRoot: agentRoot,
    colonyRoot: join(agentRoot, "agora"),
  });

  const response = await channel.handleMessage({
    agentName,
    channelId: "test-channel",
    message: "hello",
  });

  expect(response.text).toBe("ok");
  expect(events.some((e) => (e as any).type === "cartridge_activated")).toBe(true);
  const activated = events.find((e) => (e as any).type === "cartridge_activated") as any;
  expect(activated.name).toBe("thinking");

  const req = captured.requests[0];
  expect(req.system).toContain("THINK CARTRIDGE BODY");
  expect(req.staticHash).toBeDefined();
  // active cartridge lives in full system but not in cache prefix
  expect(req.cachePrefix).not.toContain("THINK CARTRIDGE BODY");

  sessionStore.close();
  rmSync(agentRoot, { recursive: true, force: true });
  rmSync(roomsDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test("SC-3 aborting a mesh channel turn prevents a delayed tool and another provider call", async () => {
  const { base, roomsDir } = makeTempDirs();
  const agentName = "mesh-abort-test";
  const marker = join(base, "after-abort.txt");
  const controller = new AbortController();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "synthetic",
    async query(req) {
      requests.push(req);
      if (requests.length > 1) return { message: { role: "assistant", content: "finished" } };
      started();
      await gate;
      return {
        message: { role: "assistant", content: "" },
        tool_calls: [{ id: "write-late", name: "write", arguments: JSON.stringify({ path: marker, content: "late" }) }],
      };
    },
  };
  const channel = new AgentSessionChannel({ roomsDir, provider });
  (channel as any).store = fakeStore().store;
  (channel as any).cartridgeRegistry = new CartridgeRegistry({
    projectRoot: base, globalRoot: base, colonyRoot: base,
  });
  const agent: LoadedAgent = {
    name: agentName, label: "Test Agent", roomDir: base, geneContent: "Test instructions.",
    sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
    config: {
      identity: { name: agentName, label: "Test Agent" },
      provider: { type: "synthetic" },
      policy: { allowedRoots: [base], readOnlyRoots: [], allowedTools: ["write"] },
      session: { defaultMode: "edit", autoModeOptIn: false, compactThreshold: 60000 },
      boot: { gene: "gene.md", sessionContext: [] },
    },
  };
  (channel as any).agentCache.set(agentName, agent);
  const handlers = createMeshSessionHandlers({
    runTurn: createMeshChannelTurn(new Map([[agentName, channel]])),
    conversation: () => ({
      answered: async () => false,
      finish: async () => "replied",
    }),
    markReplied: () => {},
  });
  try {
    const pending = handlers.executeSession({
      candidate: { agentId: agentName, sourceRef: "mesh:test", summary: "test cancellation" } as ActivationCandidate,
      grant: { leaseId: "test" } as BudgetGrant,
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort();
    release();
    const effect = await pending;
    expect(existsSync(marker)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(effect).toBe("mesh-session:mesh:test:late");
  } finally {
    release();
    rmSync(base, { recursive: true, force: true });
  }
});

describe("AgentSessionChannel provider fallback", () => {
  type Seen = { ref: string; model?: string };

  function writeRoom(roomsDir: string, agentName: string, provider: string) {
    const roomDir = join(roomsDir, agentName);
    mkdirSync(roomDir, { recursive: true });
    writeFileSync(
      join(roomDir, "config.yaml"),
      `identity:\n  name: ${agentName}\n  label: Test Agent\nprovider:\n${provider}policy:\n  allowedRoots: []\n  allowedTools: []\nsession:\n  defaultMode: plan\n  compactThreshold: 60000\nboot:\n  gene: gene.md\n  sessionContext:\n    - path: ctx.md\n`,
    );
    writeFileSync(join(roomDir, "gene.md"), "Core instructions.");
    writeFileSync(join(roomDir, "ctx.md"), "Context.");
  }

  function registry(providers: Array<{ id: string; models: string[] }>) {
    const map = new Map(providers.map((p) => [p.id, {
      id: p.id, label: p.id, baseUrl: "https://mock.local/v1", api: "openai-completions" as const, apiKey: "mock-key",
      models: p.models.map((id) => ({ id })),
    }]));
    return {
      get: (id: string) => map.get(id),
      list: () => [...map.values()],
      resolve: (ref: string) => {
        const at = ref.lastIndexOf("@");
        const def = map.get(ref.slice(at + 1));
        if (!def) throw new Error(`unknown provider: ${ref}`);
        const model = def.models.find((m) => m.id === ref.slice(0, at));
        if (!model) throw new Error(`unknown model: ${ref}`);
        return { provider: def, model };
      },
    } as any;
  }

  function setup(provider: string, failing: (ref: string) => boolean, overrides: { provider?: Provider } = {}) {
    const { base, roomsDir } = makeTempDirs();
    writeRoom(roomsDir, "fbagent", provider);
    const seen: Seen[] = [];
    const direct: string[] = [];
    const reply = (ref: string): ProviderResponse => ({ message: { role: "assistant", content: `from ${ref}` } });
    const channel = new AgentSessionChannel({
      roomsDir,
      provider: overrides.provider,
      providerDeps: {
        registry: registry([
          { id: "primary", models: ["p-default", "p-other"] },
          { id: "backup", models: ["b1"] },
        ]),
        breaker: new CircuitBreaker(join(base, "breaker.json")),
        createDirect: async (name: string): Promise<Provider> => ({
          name: `direct:${name}`,
          async query(req: ProviderRequest) { direct.push(`${req.model}@${name}`); return reply(`direct ${name}`); },
        }),
        createProvider: (providerId: string): Provider => ({
          name: providerId,
          async query(req: ProviderRequest) {
            const ref = `${req.model}@${providerId}`;
            seen.push({ ref, model: req.model });
            if (failing(ref)) throw new ProviderError("SERVER_ERROR", providerId, "Upstream request failed: Endpoint is unavailable.");
            return reply(ref);
          },
        }),
      },
    });
    (channel as any).store = fakeStore().store;
    return { channel, seen, direct, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  const send = (channel: AgentSessionChannel) => channel.handleMessage({ agentName: "fbagent", channelId: "mesh:test", message: "review #16" });

  test("SF-1 a SERVER_ERROR from the primary is answered by the first fallback, with its model", async () => {
    const t = setup("  type: primary\n  model: p-default\n  fallback:\n    - type: backup\n      model: b1\n", (ref) => ref.endsWith("@primary"));
    const response = await send(t.channel);
    expect(response.text).toBe("from b1@backup");
    expect(t.seen.at(-1)?.ref).toBe("b1@backup");
    expect(t.seen.some((s) => s.ref === "p-default@primary")).toBe(true);
    expect(t.direct).toEqual([]);
    t.cleanup();
  });

  test("SF-2 without a fallback the configured provider is called directly", async () => {
    const t = setup("  type: primary\n  model: p-default\n", () => false);
    const response = await send(t.channel);
    expect(response.text).toBe("from direct primary");
    expect(t.seen).toEqual([]);
    t.cleanup();
  });

  test("SF-3 the room's model reaches the provider, direct and through the chain", async () => {
    const direct = setup("  type: primary\n  model: p-other\n", () => false);
    await send(direct.channel);
    expect(direct.direct).toEqual(["p-other@primary"]);
    direct.cleanup();

    const chained = setup("  type: primary\n  model: p-other\n  fallback:\n    - type: backup\n      model: b1\n", () => false);
    await send(chained.channel);
    expect(chained.seen.map((s) => s.ref)).toEqual(["p-other@primary"]);
    chained.cleanup();
  });

  test("SF-4 a provider-type or model override bypasses the chain", async () => {
    const config = "  type: primary\n  model: p-default\n  fallback:\n    - type: backup\n      model: b1\n";
    const typed = setup(config, () => true);
    typed.channel.providerTypeOverride = "backup";
    expect((await send(typed.channel)).text).toBe("from direct backup");
    expect(typed.seen).toEqual([]);
    typed.cleanup();

    const modelled = setup(config, () => true);
    modelled.channel.modelOverride = "p-other";
    expect((await send(modelled.channel)).text).toBe("from direct primary");
    expect(modelled.direct).toEqual(["p-other@primary"]);
    expect(modelled.seen).toEqual([]);
    modelled.cleanup();
  });

  test("SF-5 a provider object override is used as is", async () => {
    const captured: { requests: ProviderRequest[] } = { requests: [] };
    const t = setup("  type: primary\n  model: p-default\n  fallback:\n    - type: backup\n      model: b1\n", () => true, { provider: captureProvider(captured) });
    expect((await send(t.channel)).text).toBe("ok");
    expect(captured.requests).toHaveLength(1);
    expect(t.seen).toEqual([]);
    expect(t.direct).toEqual([]);
    t.cleanup();
  });

  test("SF-6 a model-less primary is called first, with its first registered model", async () => {
    const t = setup("  type: primary\n  fallback:\n    - type: backup\n      model: b1\n", () => false);
    expect((await send(t.channel)).text).toBe("from p-default@primary");
    expect(t.seen.map((s) => s.ref)).toEqual(["p-default@primary"]);
    t.cleanup();
  });

  test("SF-8 a same-provider fallback keeps answering across tool rounds with the breaker enabled", async () => {
    const { base, roomsDir } = makeTempDirs();
    writeRoom(roomsDir, "fbagent", "  type: primary\n  model: p-default\n  fallback:\n    - type: primary\n      model: p-other\n");
    const seen: string[] = [];
    let goodCalls = 0;
    const channel = new AgentSessionChannel({
      roomsDir,
      providerDeps: {
        registry: registry([{ id: "primary", models: ["p-default", "p-other"] }]),
        breaker: new CircuitBreaker(join(base, "breaker.json")),
        createDirect: async () => { throw new Error("direct provider must not be used when a fallback chain exists"); },
        createProvider: (providerId: string): Provider => ({
          name: providerId,
          async query(req: ProviderRequest): Promise<ProviderResponse> {
            seen.push(`${req.model}@${providerId}`);
            if (req.model === "p-default") throw new ProviderError("SERVER_ERROR", providerId, "Upstream request failed: Endpoint is unavailable.");
            goodCalls++;
            if (goodCalls === 1) {
              return { message: { role: "assistant", content: "" }, tool_calls: [{ id: "t1", name: "read", arguments: JSON.stringify({ path: "gene.md" }) }] };
            }
            return { message: { role: "assistant", content: "answer after tool round" } };
          },
        }),
      },
    });
    (channel as any).store = fakeStore().store;
    try {
      const response = await send(channel);
      expect(response.text).toBe("answer after tool round");
      expect(goodCalls).toBe(2);
      expect(seen.at(-1)).toBe("p-other@primary");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  async function withBreakerDisabled(breakerFile: string, contents: string, run: () => Promise<void>) {
    const previous = process.env.ANIMA_BREAKER_DISABLED;
    process.env.ANIMA_BREAKER_DISABLED = "true";
    writeFileSync(breakerFile, contents);
    try { await run(); } finally {
      if (previous === undefined) delete process.env.ANIMA_BREAKER_DISABLED; else process.env.ANIMA_BREAKER_DISABLED = previous;
    }
  }

  function disabledBreakerChannel(base: string, roomsDir: string, breakerFile: string) {
    writeRoom(roomsDir, "fbagent", "  type: primary\n  model: p-default\n  fallback:\n    - type: backup\n      model: b1\n");
    const channel = new AgentSessionChannel({
      roomsDir,
      providerDeps: {
        registry: registry([{ id: "primary", models: ["p-default"] }, { id: "backup", models: ["b1"] }]),
        breaker: new CircuitBreaker(breakerFile),
        createDirect: async () => { throw new Error("direct provider must not be used when a fallback chain exists"); },
        createProvider: (providerId: string): Provider => ({
          name: providerId,
          async query(req: ProviderRequest): Promise<ProviderResponse> { return { message: { role: "assistant", content: `from ${req.model}@${providerId}` } }; },
        }),
      },
    });
    (channel as any).store = fakeStore().store;
    return channel;
  }

  test("SF-9 with the breaker disabled, a success leaves an OPEN breaker entry untouched", async () => {
    const { base, roomsDir } = makeTempDirs();
    const breakerFile = join(base, "breaker.json");
    const now = new Date().toISOString();
    const open = JSON.stringify({ primary: { state: "open", failureCount: 2, openedAt: now, resetAt: new Date(Date.now() + 300_000).toISOString() } }, null, 2);
    try {
      await withBreakerDisabled(breakerFile, open, async () => {
        const response = await send(disabledBreakerChannel(base, roomsDir, breakerFile));
        expect(response.text).toBe("from p-default@primary");
        expect(readFileSync(breakerFile, "utf8")).toBe(open);
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("SF-10 with the breaker disabled, a malformed breaker file does not fail a successful turn", async () => {
    const { base, roomsDir } = makeTempDirs();
    const breakerFile = join(base, "breaker.json");
    try {
      await withBreakerDisabled(breakerFile, "{not json", async () => {
        const response = await send(disabledBreakerChannel(base, roomsDir, breakerFile));
        expect(response.text).toBe("from p-default@primary");
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("SF-7 a same-provider fallback answers with its own model", async () => {
    const t = setup("  type: primary\n  model: p-default\n  fallback:\n    - type: primary\n      model: p-other\n", (ref) => ref === "p-default@primary");
    expect((await send(t.channel)).text).toBe("from p-other@primary");
    expect(t.seen.at(-1)?.ref).toBe("p-other@primary");
    t.cleanup();
  });
});
