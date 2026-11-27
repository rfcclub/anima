/**
 * castle-work-loop: host-executed tools in runLoopMode. The provider is asked for tool
 * calls, the host runs them (sandboxed by the caller), and the next iteration sees their results. A fake
 * provider and fake tools; real SessionStore.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoopMode, type LoopHost, type LoopHostTools } from "../../src/agents/loop";
import type { LoadedAgent } from "../../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse, ProviderToolCall } from "../../src/providers/interface";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";

let dir: string;
let store: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-loop-tools-"));
  store = new SessionStore(join(dir, "sessions.db"));
  manager = new SessionManager({ store, maxTokens: 200_000 });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function agent(): LoadedAgent {
  return {
    name: "finn", label: "Finn", roomDir: dir, geneContent: "Core.", soulContent: "Soul.", soulPath: join(dir, "soul.md"),
    sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
    config: {
      provider: { type: "agnes", model: "agnes-3.0-flash", modeMap: {} },
      policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "auto", compactThreshold: 60000 },
      memory: undefined,
    },
  } as unknown as LoadedAgent;
}

const call = (id: string, name: string, args: Record<string, unknown>): ProviderToolCall => ({ id, name, arguments: JSON.stringify(args) });

type Step = { text: string; tools?: ProviderToolCall[] } | Error;
function provider(steps: Step[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    name: "agnes",
    requests,
    async query(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      const step = steps[i++] ?? { text: '<DONE reason="no more steps" />' };
      if (step instanceof Error) throw step;
      return { message: { role: "assistant", content: step.text }, ...(step.tools ? { tool_calls: step.tools } : {}) };
    },
  };
}

const lastUser = (r: ProviderRequest) => {
  const u = [...r.messages].reverse().find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};

function host(tools: LoopHostTools) {
  const log: string[] = [];
  let n = 0;
  const h: LoopHost = {
    workId: "wabc",
    beginStep: (info) => { const id = `st${++n}`; log.push(`begin:${info.kind}`); return id; },
    endStep: (id, outcome) => { log.push(`end:${id}:${outcome}`); },
    openSteps: () => [],
    reconcile: async () => "",
    tools,
  };
  return { h, log };
}

const definitions = [{ name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];

describe("host tools", () => {
  test("the provider is offered the tool definitions and a tool call is run by the host", async () => {
    const executed: string[] = [];
    const tools: LoopHostTools = { definitions, execute: async (c) => { executed.push(`${c.name}:${c.arguments}`); return "hello from the tool"; } };
    const { h } = host(tools);
    const p = provider([{ text: '<LOOP reason="ran a command" />', tools: [call("t1", "bash", { command: "echo hi" })] }, { text: '<DONE reason="ok" />' }]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(p.requests[0]!.tools?.map((t) => (t as { name: string }).name)).toEqual(["bash"]);
    expect(executed).toEqual(['bash:{"command":"echo hi"}']);
    expect(r.exitReason).toBe("done");
  });

  test("the next iteration sees the tool results", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => "OUTPUT-SENTINEL-42" };
    const { h } = host(tools);
    const p = provider([{ text: '<LOOP reason="x" />', tools: [call("t1", "bash", { command: "ls" })] }, { text: '<DONE reason="ok" />' }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(lastUser(p.requests[1]!)).toContain("OUTPUT-SENTINEL-42");
    expect(lastUser(p.requests[1]!)).toContain("bash");
  });

  test("several tool calls in one response are all run, in order, in one iteration", async () => {
    const order: string[] = [];
    const tools: LoopHostTools = { definitions, execute: async (c) => { order.push(c.id); return `r-${c.id}`; } };
    const { h } = host(tools);
    const p = provider([{ text: "go", tools: [call("a", "bash", { command: "1" }), call("b", "bash", { command: "2" })] }, { text: '<DONE reason="ok" />' }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(order).toEqual(["a", "b"]);
    expect(p.requests.length).toBe(2);
    expect(lastUser(p.requests[1]!)).toContain("r-a");
    expect(lastUser(p.requests[1]!)).toContain("r-b");
  });

  test("a done signal in the same response as tool calls does not end the run before the tools ran and were seen", async () => {
    let ran = 0;
    const tools: LoopHostTools = { definitions, execute: async () => { ran++; return "ran"; } };
    const { h } = host(tools);
    const p = provider([{ text: '<DONE reason="premature" />', tools: [call("a", "bash", { command: "x" })] }, { text: '<DONE reason="ok" />' }]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(ran).toBe(1);
    expect(p.requests.length).toBe(2);
    expect(r.iterations).toBe(2);
  });

  test("each tool call has its own step marker, opened before it runs and closed after", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => "ok" };
    const { h, log } = host(tools);
    const p = provider([{ text: "go", tools: [call("a", "bash", { command: "x" })] }, { text: '<DONE reason="ok" />' }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(log).toEqual(["begin:provider", "end:st1:completed", "begin:tool", "end:st2:completed", "begin:provider", "end:st3:completed"]);
  });

  test("a tool that throws becomes an error result for the model and an open marker, and the run goes on", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => { throw new Error("sandbox refused"); } };
    const { h, log } = host(tools);
    const p = provider([{ text: "go", tools: [call("a", "bash", { command: "x" })] }, { text: '<DONE reason="ok" />' }]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(lastUser(p.requests[1]!)).toContain("sandbox refused");
    expect(log).toContain("end:st2:unknown");
    expect(r.exitReason).toBe("done");
  });

  test("tool output is capped before it goes back to the model", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => "x".repeat(200_000) };
    const { h } = host(tools);
    const p = provider([{ text: "go", tools: [call("a", "bash", { command: "x" })] }, { text: '<DONE reason="ok" />' }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(lastUser(p.requests[1]!).length).toBeLessThan(20_000);
    expect(lastUser(p.requests[1]!)).toContain("truncated");
  });

  test("an abort during a tool call stops the run without another provider call", async () => {
    const controller = new AbortController();
    const tools: LoopHostTools = { definitions, execute: async () => { controller.abort(); return "late"; } };
    const { h } = host(tools);
    const p = provider([{ text: "go", tools: [call("a", "bash", { command: "x" })] }, { text: '<DONE reason="ok" />' }]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host: h, signal: controller.signal });
    expect(p.requests.length).toBe(1);
    expect(r.exitReason).toBe("interrupted");
    expect(r.checkpoint?.workId).toBe("wabc");
  });

  test("tool iterations count against the iteration limit", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => "ok" };
    const { h } = host(tools);
    const p = provider(Array.from({ length: 20 }, (_, i) => ({ text: `step ${i}`, tools: [call(`c${i}`, "bash", { command: "x" })] })));
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host: h });
    expect(p.requests.length).toBe(5);
    expect(r.exitReason).toBe("max_reached");
  });

  test("a progress warning reaches the next model turn before a later completed tool stops the loop", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => "same" };
    const { h, log } = host(tools);
    let observed = 0;
    (h as LoopHost & { observeTool: unknown }).observeTool = async () =>
      ++observed === 1 ? { warning: "Progress guard: repeated unchanged call", stop: false } : { stop: true };
    const p = provider([
      { text: "first", tools: [call("a", "bash", { command: "x" })] },
      { text: "second", tools: [call("b", "bash", { command: "x" })] },
      { text: '<DONE reason="should not run" />' },
    ]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host: h });
    expect(lastUser(p.requests[1]!)).toContain("Progress guard: repeated unchanged call");
    expect(r.exitReason).toBe("blocked");
    expect(p.requests.length).toBe(2);
    expect(log).toEqual(["begin:provider", "end:st1:completed", "begin:tool", "end:st2:completed", "begin:provider", "end:st3:completed", "begin:tool", "end:st4:completed"]);
  });

  test("same-turn repeats do not stop before the warning can reach the model", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => "same" };
    const { h } = host(tools);
    let observed = 0;
    (h as LoopHost & { observeTool: unknown }).observeTool = async () =>
      ++observed === 1 ? { warning: "Progress guard: repeated unchanged call", stop: false } : { stop: true };
    const p = provider([
      { text: "first", tools: [call("a", "bash", { command: "x" }), call("b", "bash", { command: "x" })] },
      { text: '<DONE reason="ok" />' },
    ]);
    const r = await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, checkpoints: true, host: h });
    expect(lastUser(p.requests[1]!)).toContain("Progress guard: repeated unchanged call");
    expect(r.exitReason).toBe("done");
  });

  test("progress observation leaves an uncertain tool marker open", async () => {
    const tools: LoopHostTools = { definitions, execute: async () => { throw new Error("uncertain"); } };
    const { h, log } = host(tools);
    const observed: boolean[] = [];
    (h as LoopHost & { observeTool: unknown }).observeTool = async (entry: { completed: boolean }) => {
      observed.push(entry.completed);
      return {};
    };
    const p = provider([{ text: "go", tools: [call("a", "bash", { command: "x" })] }, { text: '<DONE reason="ok" />' }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5, host: h });
    expect(observed).toEqual([false]);
    expect(log).toContain("end:st2:unknown");
  });

  test("without host tools no tools are offered and a response with tool calls changes nothing", async () => {
    const p = provider([{ text: '<DONE reason="ok" />', tools: [call("a", "bash", { command: "x" })] }]);
    await runLoopMode(agent(), "goal", p, manager, store, { maxIterations: 5 });
    expect(p.requests[0]!.tools).toBeUndefined();
    expect(p.requests.length).toBe(1);
  });
});
