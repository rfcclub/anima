import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { AgentSession } from "../../src/agents/session";
import type { LoadedAgent } from "../../src/agents/loader";
import type { Store } from "../../src/memory/jsonl-store";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import { McpManager } from "../../src/mcp/manager";
import type { Provider } from "../../src/providers/interface";

test("SC-10 abort during recall prevents MCP startup and clears the active session", async () => {
  const controller = new AbortController();
  let entered = () => {};
  let release = () => {};
  const recalling = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let mcpStarts = 0;
  let providerCalls = 0;
  class DelayedMemory extends NullMemoryAdapter {
    override async recall() { entered(); await gate; return []; }
  }
  const agent: LoadedAgent = {
    name: "prepare-abort-test", label: "Test", roomDir: tmpdir(), geneContent: "Instructions.",
    sessionContextFiles: [], additionalContent: [],
    config: {
      identity: { name: "prepare-abort-test", label: "Test" },
      provider: { type: "synthetic" },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 60000 },
      boot: { gene: "gene.md", sessionContext: [] },
      mcp: { servers: [{ name: "first", command: "unused", args: [] }] },
    },
  };
  const store: Store = { append: () => {}, readDate: () => [], readRecent: () => [], recover: () => null };
  const provider: Provider = {
    name: "synthetic",
    async query() { providerCalls++; return { message: { role: "assistant", content: "unused" } }; },
  };
  const session = new AgentSession({
    store, provider, log: () => {},
    mcpManagerFactory: () => ({
      start: async () => { mcpStarts++; },
      stop: async () => {},
      getTools: () => [],
      callTool: async () => ({}),
    }),
  });
  const pending = session.run({
    agent, message: "test", signal: controller.signal, memoryAdapter: new DelayedMemory(),
  }).then(() => "resolved", (error) => error.name);
  try {
    await recalling;
    controller.abort();
    release();
    const outcome = await pending;
    const active = AgentSession.isActive(agent.name);
    expect({ outcome, mcpStarts, providerCalls, active }).toEqual({
      outcome: "AbortError", mcpStarts: 0, providerCalls: 0, active: false,
    });
  } finally {
    release();
  }
});

test("session abort during MCP discovery stops the active client and never starts the next one", async () => {
  const controller = new AbortController();
  let entered = () => {};
  let release = () => {};
  const discovering = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const stopped: string[] = [];
  let providerCalls = 0;
  const agent: LoadedAgent = {
    name: "mcp-discovery-abort-test", label: "Test", roomDir: tmpdir(), geneContent: "Instructions.",
    sessionContextFiles: [], additionalContent: [],
    config: {
      identity: { name: "mcp-discovery-abort-test", label: "Test" },
      provider: { type: "synthetic" },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 60000 },
      boot: { gene: "gene.md", sessionContext: [] },
      mcp: { servers: [
        { name: "first", command: "unused", args: [] },
        { name: "second", command: "unused", args: [] },
      ] },
    },
  };
  const store: Store = { append: () => {}, readDate: () => [], readRecent: () => [], recover: () => null };
  const provider: Provider = {
    name: "synthetic",
    async query() { providerCalls++; return { message: { role: "assistant", content: "unused" } }; },
  };
  const session = new AgentSession({
    store, provider, log: () => {},
    mcpManagerFactory: (configs) => new McpManager(configs, {
      clientFactory: ({ name }) => ({
        async start() { started.push(name); return true; },
        async listTools() { if (name === "first") { entered(); await gate; } return []; },
        async stop() { stopped.push(name); },
        async callTool() { return {}; },
      }),
    }),
  });
  const pending = session.run({
    agent, message: "test", signal: controller.signal, memoryAdapter: new NullMemoryAdapter(),
  }).then(() => "resolved", (error) => error.name);
  try {
    await discovering;
    controller.abort();
    const stoppedBeforeRelease = [...stopped];
    release();
    const outcome = await pending;
    expect({ outcome, started, stopped, stoppedBeforeRelease, providerCalls, active: AgentSession.isActive(agent.name) })
      .toEqual({
        outcome: "AbortError", started: ["first"], stopped: ["first"],
        stoppedBeforeRelease: ["first"], providerCalls: 0, active: false,
      });
  } finally {
    release();
  }
});
