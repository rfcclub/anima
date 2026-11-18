import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../../src/agents/session";
import type { LoadedAgent } from "../../src/agents/loader";
import { JsonlStore } from "../../src/memory/jsonl-store";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

let tempDir: string;
let roomDir: string;
let store: JsonlStore;
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-disable-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roomDir = join(tempDir, "rooms", "jade");
  mkdirSync(join(roomDir, "staging"), { recursive: true });
  store = new JsonlStore(tempDir);
  originalHome = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function agent(): LoadedAgent {
  return {
    name: "jade",
    label: "Jade",
    roomDir,
    soulPath: "SOUL.md",
    geneContent: "Core instructions.",
    soulContent: "You are Jade.",
    sessionContextFiles: [],
    additionalContent: [],
    config: {
      identity: { name: "jade", label: "Jade" },
      provider: { type: "claude" },
      policy: {
        allowedRoots: [roomDir],
        readOnlyRoots: [],
        allowedTools: ["bash", "write"],
      },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 0 },
      boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
      mcp: { servers: [{ name: "mock", command: "bun", args: ["mock.ts"] }] },
    },
  };
}

function writeCall(path: string) {
  return { id: "call_1", name: "write", arguments: JSON.stringify({ path, content: "pwned" }) };
}

/** Non-streaming provider: first answer carries a tool call, later answers are plain text. */
function queryProvider(requests: ProviderRequest[], sentinel: string): Provider {
  return {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      if (requests.length === 1) {
        return { message: { role: "assistant", content: "before tool" }, tool_calls: [writeCall(sentinel)] };
      }
      return { message: { role: "assistant", content: "after tool" } };
    },
  };
}

/** Streaming provider: yields text, then a tool_call chunk. */
function streamingProvider(requests: ProviderRequest[], sentinel: string): Provider {
  return {
    name: "claude",
    query: ((req: ProviderRequest) => {
      requests.push(req);
      return (async function* (): AsyncGenerator<ProviderChunk> {
        yield { type: "text", content: "before tool" };
        if (requests.length === 1) yield { type: "tool_call", tool_call: writeCall(sentinel) };
      })();
    }) as unknown as Provider["query"],
  };
}

async function collect(session: AgentSession, disableTools: boolean | undefined): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of session.runStream({
    agent: agent(),
    message: "hi",
    mode: "plan",
    sessionId: "s1",
    continuityDbPath: join(tempDir, "continuity.db"),
    ...(disableTools === undefined ? {} : { disableTools }),
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

for (const [label, makeProvider] of [["query", queryProvider], ["streaming", streamingProvider]] as const) {
  test(`${label} provider: disableTools offers no tools, starts no MCP, and does not execute or yield a returned tool call`, async () => {
    const requests: ProviderRequest[] = [];
    const sentinel = join(roomDir, "sentinel.txt");
    let mcpStarts = 0;
    const session = new AgentSession({
      store,
      provider: makeProvider(requests, sentinel),
      log: () => {},
      mcpManagerFactory: () => {
        mcpStarts++;
        return { start: async () => {}, stop: async () => {}, getTools: () => [], callTool: async () => ({ content: [] }) };
      },
    });

    const chunks = await collect(session, true);

    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toBeUndefined();
    expect(mcpStarts).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(0);
    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.content).join("")).toContain("before tool");
  });
}

test("regression: without disableTools a returned write call still runs", async () => {
  const requests: ProviderRequest[] = [];
  const sentinel = join(roomDir, "sentinel.txt");
  const session = new AgentSession({
    store,
    provider: queryProvider(requests, sentinel),
    log: () => {},
    mcpManagerFactory: () => ({ start: async () => {}, stop: async () => {}, getTools: () => [], callTool: async () => ({ content: [] }) }),
  });

  const chunks = await collect(session, undefined);

  expect(requests[0].tools?.map((tool) => ("name" in tool ? tool.name : ""))).toContain("write");
  expect(existsSync(sentinel)).toBe(true);
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(1);
});
