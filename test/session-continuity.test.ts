import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../src/agents/session";
import type { LoadedAgent } from "../src/agents/loader";
import { emptySubstratePair } from "./fixtures/substrate-pair";
import { JsonlStore } from "../src/memory/jsonl-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";
import { ManifestLogger } from "../src/agents/manifest-logger";
import { AnimaProjectionCompiler } from "../src/identity-runtime/anima-projection-compiler";
import { NullMemoryAdapter } from "../src/memory/null-adapter";

let tempDir: string;
let store: JsonlStore;
let continuityDbPath: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-session-continuity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlStore(tempDir);
  continuityDbPath = join(tempDir, "continuity.db");
});

function provider(query?: (req: ProviderRequest) => Promise<ProviderResponse>): Provider {
  return {
    name: "claude",
    query: query ?? (async () => response("hello")),
  };
}

function response(content: string): ProviderResponse {
  return { message: { role: "assistant", content } };
}

function agent(overrides: { incarnationPort: boolean; identityRuntime?: boolean }): LoadedAgent {
  return {
    name: "bruno",
    label: "Bruno",
    roomDir: join(tempDir, "rooms", "bruno"),
    geneContent: "Core instructions.",
    soulContent: "You are Bruno.",
    sessionContextFiles: [],
    additionalContent: [],
    config: {
      identity: { name: "bruno", label: "Bruno" },
      provider: { type: "claude" },
      policy: { allowedRoots: [] },
      session: { defaultMode: "plan", autoModeOptIn: false },
      boot: { gene: "PREFACE.md", sessionContext: [] },
      continuity: { incarnationPort: overrides.incarnationPort, identityRuntime: overrides.identityRuntime },
    },
    ...(overrides.identityRuntime ? emptySubstratePair("bruno") : {}),
  };
}

test("with the flag absent, behavior is byte-identical to before (SC-07)", async () => {
  const session = new AgentSession({ store, provider: provider(), log: () => {} });

  const result = await session.run({
    agent: agent({ incarnationPort: false }),
    message: "hello",
    mode: "plan",
    sessionId: "flag-off",
  });

  expect(result.response.message.content).toBe("hello");
  const events = store.readDate("bruno", new Date().toISOString().slice(0, 10));
  expect(events.map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
});

test("flag-on and flag-off produce the byte-identical system prompt end-to-end through the real pipeline (integration-level SC-03/SC-07)", async () => {
  let systemOff = "";
  let systemOn = "";

  const sessionOff = new AgentSession({
    store,
    provider: provider(async (req) => {
      systemOff = req.system ?? "";
      return response("hello");
    }),
    log: () => {},
  });
  await sessionOff.run({
    agent: agent({ incarnationPort: false }),
    message: "hello",
    mode: "plan",
    sessionId: "prompt-off",
  });

  const sessionOn = new AgentSession({
    store,
    provider: provider(async (req) => {
      systemOn = req.system ?? "";
      return response("hello");
    }),
    log: () => {},
  });
  await sessionOn.run({
    agent: agent({ incarnationPort: true }),
    message: "hello",
    mode: "plan",
    sessionId: "prompt-on",
    surfaceId: "cc",
    continuityDbPath,
  });

  expect(systemOn).toBe(systemOff);
});

test("identity-runtime opt-in joins before provider invocation and sends the compiled projection", async () => {
  let legacySystem = "";
  const baseline = new AgentSession({
    store,
    provider: provider(async (request) => { legacySystem = request.system ?? ""; return response("baseline"); }),
    log: () => {},
  });
  await baseline.run({ agent: agent({ incarnationPort: false }), message: "hello", mode: "plan", sessionId: "runtime-baseline" });

  const sequence: string[] = [];
  let receivedSystem = "";
  const runtimeAgent = agent({ incarnationPort: false, identityRuntime: true });
  const canonical = await new AnimaProjectionCompiler({ agent: runtimeAgent }).compile({
    identity: "bruno",
    surfaceId: "anima",
    mode: "plan",
    message: "hello",
  });
  const session = new AgentSession({
    store,
    provider: provider(async (request) => { sequence.push("provider"); receivedSystem = request.system ?? ""; return response("runtime"); }),
    log: () => {},
  });
  await session.run({
    agent: runtimeAgent,
    message: "hello",
    mode: "plan",
    sessionId: "runtime-on",
    identityRuntime: {
      async join(input) {
        sequence.push(`join:${input.surfaceId}`);
        expect(input.compile).toMatchObject({ identity: "bruno", surfaceId: "anima", mode: "plan", message: "hello" });
        return { projection: canonical.prompt, projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
      },
    },
  });

  expect(sequence).toEqual(["join:anima", "provider"]);
  // Requirement: the identity-runtime path is what matters, not byte parity with the old path.
  // The compiled projection groups the soul under its own headings, so we assert what the model must
  // receive, not that it equals the legacy prompt.
  expect(receivedSystem).toBe(canonical.prompt);
  expect(receivedSystem).toContain("Core instructions.");
  expect(receivedSystem).toContain("You are Bruno.");
  expect(legacySystem).toContain("You are Bruno.");
});

test("identity-runtime opt-in resolves the projection plan only in the compiler", async () => {
  let listCalls = 0;
  const runtimeAgent = agent({ incarnationPort: false, identityRuntime: true });
  runtimeAgent.memoryAdapter = new NullMemoryAdapter();
  (runtimeAgent.config as any).cartridges = { defaultRole: "programmer" };
  const registry = {
    async list() {
      listCalls += 1;
      return [{
        category: "craft", kind: "role", name: "programmer", path: "/tmp/programmer.md",
        content: "Use tests first.", scope: "agent", memory: { writeScopes: ["decision"] },
      }];
    },
    async expand(entry: { content: string }) { return entry.content; },
  };
  const compiler = new AnimaProjectionCompiler({
    agent: runtimeAgent,
    cartridgeRegistry: registry as any,
    cartridgeLoader: new (await import("../src/cartridge/loader")).CartridgeLoader(),
  });
  const canonical = await compiler.compile({ identity: "bruno", surfaceId: "anima", mode: "plan", message: "hello" });
  listCalls = 0;

  const session = new AgentSession({
    store,
    provider: provider(),
    cartridgeRegistry: registry as any,
    cartridgeLoader: new (await import("../src/cartridge/loader")).CartridgeLoader(),
    log: () => {},
  });
  await session.run({
    agent: runtimeAgent,
    message: "hello",
    mode: "plan",
    sessionId: "runtime-single-plan",
    identityRuntime: {
      async join() {
        return { projection: canonical.prompt, projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
      },
    },
  });

  expect(listCalls).toBe(1);
});

test("identity-runtime opt-in builds its substrate view only in the compiler", async () => {
  let buildViewCalls = 0;
  const runtimeAgent = agent({ incarnationPort: false, identityRuntime: true });
  runtimeAgent.substrateAdapter = {
    agentId: "bruno", substrateType: "fixture", listScopes: () => [], hasScope: () => true,
    resolve: () => ({ name: "fixture", description: "", required: false, files: [] }),
    validateMap: () => ({ valid: true, diagnostics: [] }), async retrieve() { return []; },
  };
  runtimeAgent.substrateViewLayer = {
    async buildView() {
      buildViewCalls += 1;
      return {
        turnContext: { agentId: "bruno", runtimeRequiredScopes: [], agentDefaults: { agentId: "bruno" }, cartridgePolicies: [], unifiedScopes: [], requireEvidence: false },
        results: [], estimatedTokens: 0, scopesCovered: [], scopesMissing: [], scopesEmpty: [], warnings: [],
      };
    },
  };
  const compiler = new AnimaProjectionCompiler({ agent: runtimeAgent });
  const canonical = await compiler.compile({ identity: "bruno", surfaceId: "anima", mode: "plan", message: "hello" });
  buildViewCalls = 0;
  const session = new AgentSession({ store, provider: provider(), log: () => {} });

  await session.run({
    agent: runtimeAgent, message: "hello", mode: "plan", sessionId: "runtime-single-view",
    identityRuntime: { async join() {
      return { projection: canonical.prompt, projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
    } },
  });

  expect(buildViewCalls).toBe(1);
});

test("identity-runtime opt-in fails closed when no remote client is configured", async () => {
  const session = new AgentSession({ store, provider: provider(), log: () => {} });
  await expect(session.run({
    agent: agent({ incarnationPort: false, identityRuntime: true }),
    message: "hello",
    mode: "plan",
    sessionId: "runtime-missing-client",
  })).rejects.toThrow("no remote runtime client");
});

test("identity-runtime compiler/runtime mismatch blocks provider invocation", async () => {
  let providerCalls = 0;
  const session = new AgentSession({
    store,
    provider: provider(async () => {
      providerCalls += 1;
      return response("must not run");
    }),
    log: () => {},
  });

  await expect(session.run({
    agent: agent({ incarnationPort: false, identityRuntime: true }),
    message: "hello",
    mode: "plan",
    sessionId: "runtime-mismatch",
    identityRuntime: {
      async join() {
        return { projection: "mismatched", projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
      },
    },
  })).rejects.toThrow("canonical compiler result");
  expect(providerCalls).toBe(0);
});

test("identity-runtime projection includes invocation memory recall and is the only projection passed to join", async () => {
  let receivedSystem = "";
  const runtimeAgent = agent({ incarnationPort: false, identityRuntime: true });
  const memoryAdapter = {
    async recall() { return [{ content: "Invocation memory is canonical." }]; },
  };
  const session = new AgentSession({
    store,
    provider: provider(async (request) => {
      receivedSystem = request.system ?? "";
      return response("ok");
    }),
    log: () => {},
  });

  await session.run({
    agent: runtimeAgent,
    message: "hello",
    mode: "plan",
    sessionId: "runtime-invocation-recall",
    memoryAdapter: memoryAdapter as any,
    identityRuntime: {
      async join(input: any) {
        expect(input.projection.prompt).toContain("Invocation memory is canonical.");
        return { projection: input.projection.prompt, projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
      },
    } as any,
  });

  expect(receivedSystem).toContain("Invocation memory is canonical.");
});

test("identity-runtime and incarnation-port cannot mint competing leases", async () => {
  let providerCalls = 0;
  let runtimeJoins = 0;
  const session = new AgentSession({
    store,
    provider: provider(async () => {
      providerCalls += 1;
      return response("must not run");
    }),
    log: () => {},
  });

  await expect(session.run({
    agent: agent({ incarnationPort: true, identityRuntime: true }),
    message: "hello",
    mode: "plan",
    sessionId: "competing-leases",
    identityRuntime: {
      async join() {
        runtimeJoins += 1;
        throw new Error("must not join");
      },
    },
  })).rejects.toThrow("cannot both be enabled");

  expect(runtimeJoins).toBe(0);
  expect(providerCalls).toBe(0);
});

test("identity-runtime keeps lifecycle context inside the compiler-owned projection", async () => {
  let receivedSystem = "";
  const runtimeAgent = agent({ incarnationPort: false, identityRuntime: true });
  const session = new AgentSession({
    store,
    provider: provider(async (request) => {
      receivedSystem = request.system ?? "";
      return response("ok");
    }),
    log: () => {},
  });

  await session.run({
    agent: runtimeAgent,
    message: "hello",
    mode: "plan",
    sessionId: "runtime-host-context",
    lifecycleContext: "[Lifecycle Context] resumed session",
    identityRuntime: {
      async join(input) {
        const canonical = await new AnimaProjectionCompiler({ agent: runtimeAgent }).compile(input.compile);
        return { projection: canonical.prompt, projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
      },
    },
  });

  expect(receivedSystem).toContain("[Lifecycle Context] resumed session");
  expect(receivedSystem.indexOf("[Lifecycle Context] resumed session"))
    .toBeLessThan(receivedSystem.indexOf("Bruno remains Bruno") === -1 ? receivedSystem.length : receivedSystem.indexOf("Bruno remains Bruno"));
});

test("with the flag on, prepareTurn() mints a manifest+lease and the completion hook logs exactly one row with outcome 'ok'", async () => {
  const session = new AgentSession({ store, provider: provider(), log: () => {} });
  const testAgent = agent({ incarnationPort: true });

  await session.run({
    agent: testAgent,
    message: "hello",
    mode: "plan",
    sessionId: "flag-on",
    surfaceId: "cc",
    continuityDbPath,
  });

  const logger = new ManifestLogger(continuityDbPath);
  const rows = logger.entriesFor(testAgent.name);
  expect(rows.length).toBe(1);
  expect(rows[0].outcome).toBe("ok");
  expect(rows[0].surfaceId).toBe("cc");
  expect(rows[0].projectionId).toBeTruthy();
  logger.close();
});

test("an entirely broken continuityDbPath (mint AND completion-write both fail) never masks an otherwise-successful turn result", async () => {
  // continuityDbPath backs both the mint step and the completion-write hook,
  // so a broken path fails both; this proves neither failure propagates out
  // of run() (mint failure is caught in prepareTurn(), completion-write
  // failure is caught in recordManifestLog() — see session.ts).
  const session = new AgentSession({ store, provider: provider(), log: () => {} });
  const testAgent = agent({ incarnationPort: true });

  const result = await session.run({
    agent: testAgent,
    message: "hello",
    mode: "plan",
    sessionId: "logger-write-fails",
    surfaceId: "cc",
    continuityDbPath: "/nonexistent-dir-xyz-abc/continuity.db",
  });

  expect(result.response.message.content).toBe("hello");
});

test("with the flag on, a turn that throws still logs exactly one row with outcome 'error'", async () => {
  const session = new AgentSession({
    store,
    provider: provider(async () => {
      throw new Error("provider exploded");
    }),
    log: () => {},
  });
  const testAgent = agent({ incarnationPort: true });

  await expect(
    session.run({
      agent: testAgent,
      message: "hello",
      mode: "plan",
      sessionId: "flag-on-error",
      surfaceId: "cc",
      continuityDbPath,
    }),
  ).rejects.toThrow();

  const logger = new ManifestLogger(continuityDbPath);
  const rows = logger.entriesFor(testAgent.name);
  expect(rows.length).toBe(1);
  expect(rows[0].outcome).toBe("error");
  logger.close();
});
