import { beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession, AutoModeNotEnabledError } from "../src/agents/session";
import type { LoadedAgent } from "../src/agents/loader";
import { JsonlStore } from "../src/memory/jsonl-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";
import { MappedFilesystemAdapter } from "../src/substrate/mapped-filesystem-adapter";
import { DefaultSubstrateViewLayer } from "../src/substrate/default-view-layer";
import { CartridgeLoader } from "../src/cartridge/loader";
import { CartridgeRegistry } from "../src/cartridge/registry";

let tempDir: string;
let store: JsonlStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlStore(tempDir);
});

test("auto mode refuses to run unless the room opts in", async () => {
  const session = new AgentSession({ store, provider: provider() });

  await expect(
    session.run({
      agent: agent({ autoModeOptIn: false }),
      message: "do it",
      mode: "auto",
      sessionId: "s1",
    }),
  ).rejects.toThrow(AutoModeNotEnabledError);
});

test("auto mode blocks tools outside allowedTools and appends an audit event", async () => {
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      const decision = await req.canUseTool?.("Bash", { command: "rm -rf rooms/cleo/mount" });
      expect(decision?.allow).toBe(false);
      expect(decision?.message).toContain("not in allowedTools");
      return response("blocked");
    }),
    log: () => {},
  });

  await session.run({
    agent: agent({ autoModeOptIn: true, allowedTools: ["Read"] }),
    message: "try a tool",
    mode: "auto",
    sessionId: "s2",
  });

  const events = store.readDate("cleo", new Date().toISOString().slice(0, 10));
  expect(events.some((event) => event.type === "tool_blocked" && event.tool === "Bash")).toBe(true);
});

test("auto mode emits completion log even when no tools are called", async () => {
  const logs: Record<string, unknown>[] = [];
  const session = new AgentSession({
    store,
    provider: provider(),
    log: (_level, _msg, fields) => logs.push(fields ?? {}),
  });

  await session.run({
    agent: agent({ autoModeOptIn: true, allowedTools: ["Read"] }),
    message: "hello",
    mode: "auto",
    sessionId: "s3",
  });

  expect(logs).toContainEqual(expect.objectContaining({
    type: "auto_execution_complete",
    tools: [],
    count: 0,
  }));
});

test("talk flow appends user and assistant JSONL events", async () => {
  const session = new AgentSession({
    store,
    provider: provider(),
    log: () => {},
  });

  await session.run({
    agent: agent({ autoModeOptIn: false }),
    message: "hello",
    mode: "plan",
    sessionId: "s4",
  });

  const events = store.readDate("cleo", new Date().toISOString().slice(0, 10));
  expect(events.map((event) => event.type)).toEqual(["user_message", "assistant_message"]);
});

test("agent session preserves the conversation session ID for the provider", async () => {
  const requests: ProviderRequest[] = [];
  const session = new AgentSession({
    store,
    provider: provider(async (request) => {
      requests.push(request);
      return response("ok");
    }),
    log: () => {},
  });

  await session.run({
    agent: agent({ autoModeOptIn: false }),
    message: "hello from Telegram",
    mode: "plan",
    sessionId: "telegram-session-1",
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.sessionId).toBe("telegram-session-1");
});

test("session starts and stops MCP manager when agent has MCP config", async () => {
  const lifecycle: string[] = [];
  const session = new AgentSession({
    store,
    provider: provider(),
    log: () => {},
    mcpManagerFactory: (configs) => {
      expect(configs).toEqual([{ name: "mock", command: "bun", args: ["mock.ts"] }]);
      return {
        start: async () => { lifecycle.push("start"); },
        stop: async () => { lifecycle.push("stop"); },
        getTools: () => [],
        callTool: async () => {
          throw new Error("not called");
        },
      };
    },
  });

  await session.run({
    agent: agent({ autoModeOptIn: false, mcpServers: [{ name: "mock", command: "bun", args: ["mock.ts"] }] }),
    message: "hello",
    mode: "plan",
    sessionId: "s5",
  });

  expect(lifecycle).toEqual(["start", "stop"]);
});

test("session handles MCP tool calls and re-enters provider inference", async () => {
  const requests: ProviderRequest[] = [];
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      requests.push(req);
      if (requests.length === 1) {
        return {
          message: { role: "assistant", content: "Reading file" },
          tool_calls: [{ id: "toolu_1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) }],
        };
      }
      expect(req.messages.at(-1)).toEqual({
        role: "tool",
        tool_call_id: "toolu_1",
        content: "mcp contents",
      });
      return response("done");
    }),
    log: () => {},
    mcpManagerFactory: () => ({
      start: async () => {},
      stop: async () => {},
      getTools: () => [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
      callTool: async (name, input) => {
        expect(name).toBe("read_file");
        expect(input).toEqual({ path: "note.txt" });
        return { content: [{ type: "text", text: "mcp contents" }] };
      },
    }),
  });

  const result = await session.run({
    agent: agent({ autoModeOptIn: false, mcpServers: [{ name: "mock", command: "bun", args: ["mock.ts"] }] }),
    message: "read it",
    mode: "plan",
    sessionId: "s6",
  });

  expect(result.response.message.content).toBe("done");
  expect(requests).toHaveLength(2);
  expect(requests[0].tools).toContainEqual({ name: "read_file", description: "Read", input_schema: { type: "object" } });
});

function provider(query?: (req: ProviderRequest) => Promise<ProviderResponse>): Provider {
  return {
    name: "claude",
    query: query ?? (async () => response("hello from cleo")),
  };
}

function response(content: string): ProviderResponse {
  return {
    message: { role: "assistant", content },
  };
}

test("substrate view layer injects scoped SOUL context into system prompt", async () => {
  const requests: ProviderRequest[] = [];
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      requests.push(req);
      return response("ok");
    }),
    log: () => {},
  });

  const tmp = join(tempDir, "substrate-room");
  mkdirSync(tmp, { recursive: true });
  const map = JSON.stringify({
    version: 1,
    agent_id: "cleo",
    substrate_type: "test",
    root: tmp,
    required_scopes: ["identity_core"],
    scopes: {
      identity_core: {
        description: "Identity",
        required: true,
        sources: [{ type: "soul", paths: ["SOUL.md"], trust: "high", weight: 1.0 }],
      },
    },
  });
  await Bun.write(join(tmp, "SOUL.md"), "# SOUL\n\n## Identity\nSoul line.\n");

  const substrateAdapter = new MappedFilesystemAdapter(map);
  const substrateViewLayer = new DefaultSubstrateViewLayer();

  await session.run({
    agent: {
      ...agent({ autoModeOptIn: false }),
      substrateAdapter,
      substrateViewLayer,
    },
    message: "hello",
    mode: "plan",
    sessionId: "s-soul",
  });

  expect(requests).toHaveLength(1);
  expect(requests[0].system).toContain("Soul line.");
});

test("Phase 6 E2E: cartridge retrieval reaches the prompt dynamic suffix and identity summary replaces raw SOUL", async () => {
  const requests: ProviderRequest[] = [];
  const recalls: Array<Record<string, unknown>> = [];
  const cartridgesDir = join(tempDir, "cartridges", "shared");
  mkdirSync(cartridgesDir, { recursive: true });
  await Bun.write(join(cartridgesDir, "programming.md"), `---
type: cartridge
category: craft
kind: role
name: programming
retrieval:
  scopes: [project, episode]
  top_k: 8
  max_tokens: 2000
  require_evidence: true
  allow_unverified_fallback: false
triggers:
  task: [code, fix]
---
# Programming`);

  const session = new AgentSession({
    store,
    provider: provider(async (request) => {
      requests.push(request);
      return response("ok");
    }),
    cartridgeLoader: new CartridgeLoader(),
    cartridgeRegistry: new CartridgeRegistry({
      projectRoot: tempDir,
      globalRoot: "/nonexistent",
      colonyRoot: "/nonexistent",
    }),
    log: () => {},
  });

  const loaded = agent({ autoModeOptIn: false });
  loaded.soulContent = "## Identity Core\nSteady core.\n\n## Current State\nTransient raw state.";
  (loaded.config as any).cartridges = {
    defaults: ["programming"],
    defaultRole: "programming",
  };

  await session.run({
    agent: loaded,
    message: "fix this code",
    mode: "plan",
    sessionId: "substrate-e2e",
    memoryAdapter: {
      async store() {},
      async recall(_message, options) {
        recalls.push(options as Record<string, unknown>);
        return [{
          id: "project-memory-1",
          namespace: "cleo",
          content: "The project uses cartridge-driven retrieval.",
          type: "fact",
          timestamp: new Date().toISOString(),
          confidence: 0.9,
          provenance: "test-fixture",
        }];
      },
    },
  });

  expect(recalls[0]).toEqual({ scopes: ["project", "episode"], topK: 8 });
  expect(recalls[1]).toEqual(expect.objectContaining({
    namespace: "cleo",
    topK: 5,
    sessionId: "substrate-e2e",
  }));
  expect(requests).toHaveLength(1);
  expect(requests[0].system).toContain("## Trusted Memory");
  expect(requests[0].system).toContain("cartridge-driven retrieval");
  expect(requests[0].cachePrefix).not.toContain("Trusted Memory");
  expect(requests[0].cachePrefix).toContain("Steady core.");
  expect(requests[0].cachePrefix).not.toContain("## Identity Core");
  expect(requests[0].cachePrefix).not.toContain("## Current State");
});

function agent(overrides: { autoModeOptIn: boolean; allowedTools?: string[]; mcpServers?: Array<{ name: string; command: string; args: string[] }>; substrateAdapter?: MappedFilesystemAdapter; substrateViewLayer?: DefaultSubstrateViewLayer }): LoadedAgent {
  return {
    name: "cleo",
    label: "Bodega Owner",
    roomDir: join(tempDir, "rooms", "cleo"),
    soulPath: "PREFACE.md",
    geneContent: "Core instructions.",
    soulContent: "You are Cleo.",
    sessionContextFiles: [{ path: "AGENTS.md", content: "Session context." }],
    additionalContent: [],
    config: {
      identity: { name: "cleo", label: "Bodega Owner" },
      provider: { type: "claude" },
      policy: {
        allowedRoots: [join(tempDir, "rooms", "cleo", "staging")],
        readOnlyRoots: [join(tempDir, "rooms", "cleo", "mount")],
        allowedTools: overrides.allowedTools,
      },
      session: { defaultMode: "plan", autoModeOptIn: overrides.autoModeOptIn },
      boot: { gene: "PREFACE.md", soul: "PREFACE.md", sessionContext: [{ path: "AGENTS.md" }] },
      mcp: overrides.mcpServers ? { servers: overrides.mcpServers } : undefined,
    },
    substrateAdapter: overrides.substrateAdapter,
    substrateViewLayer: overrides.substrateViewLayer,
  };
}
