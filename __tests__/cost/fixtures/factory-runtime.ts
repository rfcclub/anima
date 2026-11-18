/**
 * One factory per process: proxy.test.ts mocks model-resolver process-wide.
 * The factories, router, wire provider and ledger are real. Boot/memory and
 * consumers unrelated to factory selection are fixtures, named below.
 */
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest } from "../../../src/providers/interface";
import type { LoadedAgent } from "../../../src/agents/loader";
import { TokenLedger } from "../../../src/cost/ledger";
import { setDefaultLedger } from "../../../src/cost/logger";

// Never echo values on refusal: an accidental inherited credential must not
// become assertion/log output. The launcher supplies only fixture credentials.
for (const key of ["ANIMA_FACTORY_FORBIDDEN_CANARY", "ANTHROPIC_API_KEY", "GH_TOKEN"]) {
  assert(!Object.hasOwn(process.env, key), "unauthorized parent environment reached fixture: " + key);
}
const site = process.argv[2];
const nativeClaude = site.endsWith("-claude");
const builtinGemini = site.endsWith("-gemini");
const providerType = nativeClaude ? "claude" : builtinGemini ? "gemini" : "fixture";
const modelId = builtinGemini ? "gemini-2.0-flash" : "fixture-model";
let sdkCalls = 0;
if (nativeClaude) {
  // Exercise the real AnthropicProvider and factory, replacing only the SDK
  // transport. Starting a native carrier or contacting a real account is forbidden.
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__fixture_boundary__",
    query: () => {
      sdkCalls++;
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "fixture answer" }] } };
        yield { type: "result", subtype: "success", result: "fixture answer",
          usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: {} };
      })();
    },
  }));
}
const root = process.env.ANIMA_FACTORY_TEST_ROOT!;
assert(root && process.env.ANIMA_HOME === root, "isolated process environment required");
assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()), "fixture root must be an OS-temp child");
assert(basename(root).startsWith("anima-factory-"), "fixture root must be a dedicated test directory");
assert.equal(realpathSync(process.cwd()), realpathSync(root), "run fixture in its owned temp root");
const rooms = join(root, "rooms");
const room = join(rooms, "fixture-agent");
const providers = join(root, "providers.d");
mkdirSync(room, { recursive: true });
mkdirSync(providers, { recursive: true });
const api = site.endsWith("-responses") ? "openai-responses" : "openai-completions";
const def = {
  id: "fixture", label: "Fixture", api, apiKey: "fixture-key",
  baseUrl: "http://fixture.invalid/v1", models: [{ id: "fixture-model" }], sharedSafe: true,
};
writeFileSync(join(providers, "fixture.yaml"), JSON.stringify(def));
writeFileSync(join(room, "config.yaml"), JSON.stringify({
  identity: { name: "fixture-agent", label: "Fixture" },
  provider: { type: providerType, model: modelId },
  policy: { allowedRoots: [room] },
  session: { defaultMode: "plan" },
  boot: { gene: "SOUL.md", sessionContext: ["SOUL.md"] },
}));
const agent = {
  name: "fixture-agent", label: "Fixture", roomDir: room, soulPath: "SOUL.md",
  soulContent: "A test agent.", geneContent: "Answer the fixture.",
  sessionContextFiles: [], additionalContent: [],
  memoryAdapter: { recall: async () => [] },
  config: {
    identity: { name: "fixture-agent", label: "Fixture" },
    provider: {
      type: providerType, model: modelId,
      ...(site.endsWith("-router") ? { fallback: [{ type: "fixture", model: "fixture-model" }] } : {}),
    },
    policy: { allowedRoots: [room], allowedTools: [] },
    session: { defaultMode: "plan", compactThreshold: 100_000, autoModeOptIn: false },
    boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
  },
} as unknown as LoadedAgent;
// No real substrate, recall, lifecycle hooks or cartridges are needed to select
// a provider. Do not substitute the provider factory itself.
mock.module("../../../src/agents/loader", () => ({
  AgentLoader: class { async load() { return agent; } },
  SubstrateNotMountedError: class extends Error {},
}));
mock.module("../../../src/memory/store-registry", () => ({
  createAgentMemoryStore: async () => undefined,
}));
mock.module("../../../src/meeting/daemon", () => ({
  MailChecker: class { async check() { return []; } },
}));

const db = new Database(":memory:");
setDefaultLedger(new TokenLedger(db));
let wireCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.hostname, builtinGemini ? "generativelanguage.googleapis.com" : "fixture.invalid", "only the fixture transport is allowed");
  wireCalls++;
  return Response.json({
    model: "fixture-served",
    choices: [{ message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });
}) as typeof fetch;
const request: ProviderRequest = {
  agent: agent.name, mode: "plan", model: modelId,
  messages: [{ role: "user", content: "fixture question" }],
};
let expectedPath: string | null;
let expectedAgent = agent.name;
let sessionExpected = false;
const { ProviderRegistry } = await import("../../../src/providers/registry");
const registry = await ProviderRegistry.load(providers);

if (site.startsWith("proxy-")) {
  expectedPath = "proxy";
  if (site.startsWith("proxy-override")) {
    const inline = site === "proxy-override-inline";
    writeFileSync(process.env.ANIMA_PROXY_OVERRIDES!, JSON.stringify({
      providers: { inline: { ...def } },
      overrides: [{ match: "*", provider: inline ? "inline" : "fixture", model: "fixture-model" }],
    }));
    const { resolveOverride } = await import("../../../src/proxy/model-override");
    const resolved = await resolveOverride("requested-model", registry);
    assert(resolved);
    await resolved.provider.query(request);
  } else {
    const { resolveModel } = await import("../../../src/proxy/model-resolver");
    const resolved = resolveModel(site === "proxy-explicit" ? "fixture/fixture-model" : "fixture-model", registry);
    assert(resolved);
    await resolved.provider.query(request);
  }
} else if (["reflection", "shared-speech", "expedition"].includes(site)) {
  expectedPath = "reflection";
  const { createReflectionProvider } = await import("../../../src/continuity/reflection-engine");
  const provider = await createReflectionProvider({ name: agent.name, provider: agent.config.provider }, { providersDir: providers });
  assert(provider);
  if (site === "shared-speech") {
    expectedPath = null;
    sessionExpected = true;
    const { generateSharedSpeech } = await import("../../../src/conversation/speech");
    const result = await generateSharedSpeech({
      provider, agentId: agent.name,
      invocation: { conversationId: "conv", branchId: "branch", speakerId: agent.name, requestId: "req", beatIndex: 0 },
      context: { systemText: "Public fixture identity.", historyBlockJson: "[]", userText: "fixture question" } as never,
    });
    assert.equal(result.kind, "spoken");
  } else if (site === "expedition") {
    const { SharedNarrativeStore } = await import("../../../src/narrative/shared-store");
    const { JsonlGardenEventStore } = await import("../../../src/garden/event-store");
    const { ExpeditionDispatcher } = await import("../../../src/garden/expedition-dispatcher");
    const store = new SharedNarrativeStore(join(root, "narrative.db"));
    store.seedPlacesFromRoster([agent.name]);
    store.claimExpedition({ id: "fixture-expedition", agentId: agent.name, target: "machine", now: 1_000 });
    await new ExpeditionDispatcher({
      resolveProvider: async (name) => { assert.equal(name, agent.name); return provider; },
      store, eventStore: new JsonlGardenEventStore(join(root, "events.jsonl")),
      roomsDir: rooms, projectRoot: root, now: () => 2_000,
    }).tick();
    assert.equal(store.claimedExpeditions().length, 0);
  } else {
    await provider.query(request);
  }
} else if (site === "talk-router") {
  expectedPath = "talk";
  const { createTalkProvider } = await import("../../../src/agents/talk-runtime");
  const provider = await createTalkProvider(
    { ...agent.config.provider, fallback: [{ type: "fixture", model: "fixture-model" }] },
    { providerName: "fixture", providerFlag: false, modelFlag: false, taskMode: "chatting" },
    { registry, loadModeMap: async () => ({ chatting: [], programming: [], image: [], private: [], philosophy: [], creative: [] }),
      createDirect: async () => { throw new Error("router test unexpectedly chose direct path"); } },
  );
  await provider.query(request);
} else if (site.startsWith("meeting-")) {
  expectedPath = "meeting";
  // Meeting's private loader hard-codes homedir(). Redirect only its registry
  // read to this already-loaded fixture, with no access to the user's registry.
  ProviderRegistry.load = async () => registry;
  const { MeetingRoom } = await import("../../../src/meeting/room");
  const transcript = await new MeetingRoom({ roomsDir: rooms }).runWithAgents([agent], "factory-fixture", { turns: 1 });
  assert(transcript.includes("fixture answer"));
} else if (site.startsWith("cli-")) {
  expectedPath = null;
  sessionExpected = true;
  const { main } = await import("../../../src/cli");
  await main(["talk", agent.name, "fixture question", "--mode", "chatting"]);
} else if (site.startsWith("channel-")) {
  expectedPath = site === "channel-router" ? "talk" : "channel";
  // A minimal session consumer queries the factory result once. Session runtime
  // semantics have their own session-metering suite; this probe tests selection.
  mock.module("../../../src/agents/session", () => ({
    AgentSession: class {
      constructor(private options: { provider: Provider }) {}
      async run() { return { response: await this.options.provider.query(request) }; }
    },
  }));
  const { AgentSessionChannel } = await import("../../../src/channels/agent-session-channel");
  const result = await new AgentSessionChannel({ roomsDir: rooms }).handleMessage({
    agentName: agent.name, channelId: "fixture-channel", message: "fixture question",
  });
  assert.equal(result.text, "fixture answer");
} else if (site.startsWith("server")) {
  expectedPath = "server";
  // /dream reaches the private server factory. LucidDream is a fixture consumer,
  // avoiding unrelated dream reads and writes while querying the real provider.
  mock.module("../../../src/dream/lucid-dream", () => ({
    LucidDream: class {
      async run(options: { provider: Provider }) { return options.provider.query(request); }
    },
  }));
  const { handleRequest } = await import("../../../src/server");
  const response = await handleRequest(new Request("http://127.0.0.1:3700/dream", {
    method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3700" },
    body: JSON.stringify({ agent: agent.name }),
  }));
  assert.equal(response.status, 200, await response.text());
} else {
  expectedPath = "castle-ui";
  const { createProviderForType } = await import("../../../src/ui/services/providers");
  const provider = await createProviderForType(
    site === "castle-direct" ? { type: "fixture" } : agent.config.provider,
    { registry, breakerPath: process.env.ANIMA_BREAKER_FILE },
  );
  if (site === "castle-summary" || site === "castle-summarizer") {
    expectedAgent = "compactor";
    if (site === "castle-summary") {
      const { Compactor } = await import("../../../src/session/compactor");
      const summary = await new Compactor({ provider, sessionId: "summary-fixture" }).summarize([
        { timestamp: "2026-10-29T00:00:00Z", role: "user", content: "fixture question" } as never,
      ]);
      assert.equal(summary?.summary, "fixture answer");
    } else {
      const { providerSummarizer } = await import("../../../src/session/castle-compaction");
      const summary = await providerSummarizer(provider)({
        turns: [{ role: "user", content: "fixture question" } as never],
        signal: new AbortController().signal,
      });
      assert.equal(summary, "fixture answer");
    }
  } else if (site === "castle-session" || site === "castle-stream") {
    expectedPath = null;
    sessionExpected = true;
    const { AgentSession } = await import("../../../src/agents/session");
    const { JsonlStore } = await import("../../../src/memory/jsonl-store");
    const session = new AgentSession({ provider, store: new JsonlStore(root) });
    if (site === "castle-stream") {
      let content = "";
      for await (const chunk of session.runStream({ agent, message: "fixture question", disableTools: true })) {
        if (chunk.type === "text") content += chunk.content ?? "";
      }
      assert.equal(content, "fixture answer");
    } else {
      const result = await session.run({ agent, message: "fixture question", disableTools: true });
      assert.equal(result.response.message.content, "fixture answer");
    }
  } else {
    await provider.query(request);
  }
}

assert.equal(wireCalls + sdkCalls, 1, `${site}: exactly one leaf transport call`);
assert.equal(sdkCalls, nativeClaude ? 1 : 0, `${site}: expected SDK fixture transport`);
const rows = db.query("SELECT * FROM provider_calls").all() as Array<Record<string, unknown>>;
assert.equal(rows.length, 1, `${site}: exactly one parent, no outer-router duplicate`);
assert.equal(rows[0].agent_id, expectedAgent, `${site}: originating agent is retained`);
assert.equal(rows[0].backend, nativeClaude ? "claude" : builtinGemini ? "gemini" : site === "proxy-override-inline" ? "inline" : "fixture", `${site}: leaf backend, not router`);
assert.equal(rows[0].status, "ok", `${site}: successful call`);
assert.equal(rows[0].path_id, expectedPath, `${site}: meaningful construction path`);
if (sessionExpected) assert(typeof rows[0].session_id === "string" && rows[0].session_id.length > 0, `${site}: nonempty invocation session id`);
else assert(rows[0].path_id || rows[0].session_id, `${site}: nonempty attribution`);
assert.equal(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM token_usage").get()!.n, 1);
console.log(JSON.stringify({ site, leafCalls: wireCalls + sdkCalls, wireCalls, sdkCalls, parents: rows.length, agent: rows[0].agent_id, path: rows[0].path_id, session: !!rows[0].session_id }));
db.close();
