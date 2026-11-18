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
    },
  };
}

function writeCall(path: string) {
  return { id: "call_1", name: "write", arguments: JSON.stringify({ path, content: "x" }) };
}

async function drain(gen: AsyncGenerator<ProviderChunk>): Promise<string> {
  let text = "";
  try {
    for await (const chunk of gen) if (chunk.type === "text" && chunk.content) text += chunk.content;
  } catch (err) {
    text += `[error:${err instanceof Error ? err.message : String(err)}]`;
  }
  return text;
}

// a client that leaves must be able to stop the provider call. AgentSession takes an optional
// signal and hands it to every provider.query; a turn that has been aborted starts no further provider call.
test("runStream hands the signal to provider.query", async () => {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      return { message: { role: "assistant", content: "hello" } };
    },
  };
  const controller = new AbortController();
  const session = new AgentSession({ store, provider });
  await drain(session.runStream({ agent: agent(), message: "hi", signal: controller.signal }));
  expect(requests.length).toBe(1);
  expect(requests[0]!.signal).toBe(controller.signal);
});

test("run() hands the signal to provider.query too", async () => {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      return { message: { role: "assistant", content: "hello" } };
    },
  };
  const controller = new AbortController();
  const session = new AgentSession({ store, provider });
  await session.run({ agent: agent(), message: "hi", signal: controller.signal });
  expect(requests[0]!.signal).toBe(controller.signal);
});

test("without a signal nothing changes: the request carries none", async () => {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      return { message: { role: "assistant", content: "hello" } };
    },
  };
  const session = new AgentSession({ store, provider });
  await drain(session.runStream({ agent: agent(), message: "hi" }));
  expect(requests[0]!.signal).toBeUndefined();
});

test("an aborted turn starts no further provider call after its tool run", async () => {
  const requests: ProviderRequest[] = [];
  const controller = new AbortController();
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      if (requests.length === 1) {
        controller.abort(); // the client leaves while the first answer is being used
        return { message: { role: "assistant", content: "before tool" }, tool_calls: [writeCall(join(roomDir, "staging", "x.txt"))] };
      }
      return { message: { role: "assistant", content: "after tool" } };
    },
  };
  const session = new AgentSession({ store, provider });
  const text = await drain(session.runStream({ agent: agent(), message: "hi", signal: controller.signal }));
  expect(requests.length).toBe(1);
  expect(text).not.toContain("after tool");
});

// Regression: the abort check ran only right after a provider answer. A client that leaves while a
// tool is running must not get another provider call, nor the tools queued behind the running one.
const bashCall = (id: string, command: string) => ({ id, name: "bash", arguments: JSON.stringify({ command }) });

test("regression: an abort during a tool starts no further provider call (runStream)", async () => {
  const requests: ProviderRequest[] = [];
  const controller = new AbortController();
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      if (requests.length === 1) {
        setTimeout(() => controller.abort(), 40); // the client leaves while `sleep` runs
        return { message: { role: "assistant", content: "before tool" }, tool_calls: [bashCall("call_1", "sleep 0.2")] };
      }
      return { message: { role: "assistant", content: "after tool" } };
    },
  };
  const session = new AgentSession({ store, provider });
  const text = await drain(session.runStream({ agent: agent(), message: "hi", signal: controller.signal }));
  expect(requests.length).toBe(1);
  expect(text).not.toContain("after tool");
});

test("regression: an abort during a tool starts no further provider call (run)", async () => {
  const requests: ProviderRequest[] = [];
  const controller = new AbortController();
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      if (requests.length === 1) {
        setTimeout(() => controller.abort(), 40);
        return { message: { role: "assistant", content: "before tool" }, tool_calls: [bashCall("call_1", "sleep 0.2")] };
      }
      return { message: { role: "assistant", content: "after tool" } };
    },
  };
  const session = new AgentSession({ store, provider });
  await session.run({ agent: agent(), message: "hi", signal: controller.signal });
  expect(requests.length).toBe(1);
});

test("regression: the tools queued behind a running tool do not start once the client left", async () => {
  const marker = join(roomDir, "staging", "second.txt");
  const controller = new AbortController();
  let calls = 0;
  const provider: Provider = {
    name: "claude",
    query: async (): Promise<ProviderResponse> => {
      calls++;
      setTimeout(() => controller.abort(), 40);
      return { message: { role: "assistant", content: "x" }, tool_calls: [bashCall("call_1", "sleep 0.2"), writeCall(marker)] };
    },
  };
  const session = new AgentSession({ store, provider });
  await drain(session.runStream({ agent: agent(), message: "hi", signal: controller.signal }));
  expect(calls).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

// Regression: the guard skipped the first provider call, so a turn aborted while it was being
// prepared (MCP startup) still asked the provider.
function slowMcp(stopped: { n: number }) {
  return () => ({
    start: async () => { await new Promise((r) => setTimeout(r, 150)); },
    stop: async () => { stopped.n++; },
    getTools: () => [],
    callTool: async () => ({}),
  });
}
function agentWithMcp(): LoadedAgent {
  const a = agent();
  a.config.mcp = { servers: [{ name: "slow", command: "x", args: [] }] };
  return a;
}

test("regression: an abort while the turn is prepared starts no provider call (runStream)", async () => {
  const requests: ProviderRequest[] = [];
  const stopped = { n: 0 };
  const controller = new AbortController();
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      return { message: { role: "assistant", content: "late answer" } };
    },
  };
  const session = new AgentSession({ store, provider, mcpManagerFactory: slowMcp(stopped) });
  setTimeout(() => controller.abort(), 40); // the client leaves while the MCP server starts
  const text = await drain(session.runStream({ agent: agentWithMcp(), message: "hi", signal: controller.signal }));
  expect(requests.length).toBe(0);
  expect(text).toContain("aborted"); // an explicit cancellation outcome, not an empty answer
  expect(stopped.n).toBe(1); // and the MCP manager is still cleaned up
});

test("regression: an abort while the turn is prepared starts no provider call (run)", async () => {
  const requests: ProviderRequest[] = [];
  const stopped = { n: 0 };
  const controller = new AbortController();
  const provider: Provider = {
    name: "claude",
    query: async (req: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(req);
      return { message: { role: "assistant", content: "late answer" } };
    },
  };
  const session = new AgentSession({ store, provider, mcpManagerFactory: slowMcp(stopped) });
  setTimeout(() => controller.abort(), 40);
  await expect(session.run({ agent: agentWithMcp(), message: "hi", signal: controller.signal })).rejects.toThrow("aborted");
  expect(requests.length).toBe(0);
  expect(stopped.n).toBe(1);
});
