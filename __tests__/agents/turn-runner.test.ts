import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner, type TurnContext, type TurnEvent } from "../../src/agents/turn-runner";
import { createAutoGuard } from "../../src/agents/auto-guard";
import { AgentSession } from "../../src/agents/session";
import type { LoadedAgent } from "../../src/agents/loader";
import { JsonlStore } from "../../src/memory/jsonl-store";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import type { ProviderRequest, ProviderResponse, ProviderToolCall } from "../../src/providers/interface";

const call = (id: string, name = "read", input: unknown = { path: "one.txt" }): ProviderToolCall =>
  ({ id, name, arguments: JSON.stringify(input) });
const response = (text: string, calls?: ProviderToolCall[]): ProviderResponse =>
  ({ message: { role: "assistant", content: text }, ...(calls ? { tool_calls: calls } : {}) });

async function fixture(
  script: (request: ProviderRequest, n: number) => ProviderResponse | Promise<ProviderResponse>,
  check: (ctx: TurnContext, requests: ProviderRequest[], root: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "anima-turn-runner-"));
  writeFileSync(join(root, "one.txt"), "one");
  writeFileSync(join(root, "two.txt"), "two");
  const requests: ProviderRequest[] = [];
  const ctx: TurnContext = {
    provider: { name: "fixture", query: async (req) => {
      // Capture each request as it was sent, rather than a later mutation of messages.
      requests.push({ ...req, messages: structuredClone(req.messages) });
      return script(req, requests.length);
    } },
    agentName: "runner-fixture", sessionId: "session-fixture", cwd: root, mode: "edit",
    model: "model-fixture", system: "system-fixture", cachePrefix: "cache", staticHash: "hash",
    messages: [{ role: "user", content: "start" }],
    tools: [{ name: "read", description: "read fixture", parameters: {} }],
    policy: { allowedTools: ["read"], allowedRoots: [root], readOnlyRoots: [], deniedPatterns: [] },
    limits: { maxIterations: 64 },
  };
  try { await check(ctx, requests, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

async function collect(ctx: TurnContext): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of new TurnRunner().run(ctx)) events.push(event);
  return events;
}
const results = (events: TurnEvent[]) => events.filter((e) => e.type === "tool-result");

describe("TurnRunner", () => {
  test("no tool calls: request fields, typed events, usage and initial messages are preserved", async () => {
    const final = { ...response("finished"), usage: { input_tokens: 3, output_tokens: 2 } };
    await fixture(() => final, async (ctx, requests) => {
      const signal = new AbortController().signal;
      const guard = () => ({ allow: true });
      ctx.signal = signal; ctx.guard = guard;
      const observed: TurnEvent[] = [];
      ctx.onEvent = (event) => { observed.push(event); };
      const events = await collect(ctx);
      expect(events).toEqual([{ type: "text-delta", content: "finished" }, { type: "done", response: final }]);
      expect(observed).toEqual(events);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        agent: ctx.agentName, sessionId: ctx.sessionId, mode: "edit", cwd: ctx.cwd,
        model: ctx.model, system: ctx.system, cachePrefix: "cache", staticHash: "hash",
        tools: ctx.tools, signal, canUseTool: guard,
      });
      expect(ctx.messages).toEqual([{ role: "user", content: "start" }]);
    });
  });

  test("N sequential tools retain assistant/call/result order and exact call IDs", async () => {
    await fixture((_req, n) => n === 1
      ? response("first", [call("a"), call("b", "read", { path: "two.txt" })])
      : n === 2 ? response("second", [call("c")]) : response("done"), async (ctx, requests) => {
      const events = await collect(ctx);
      expect(results(events).map((e) => [e.call.id, e.result, e.iteration])).toEqual([
        ["a", "1\tone", 0], ["b", "1\ttwo", 0], ["c", "1\tone", 1],
      ]);
      expect(requests[2]!.messages.map((m) => [m.role, m.tool_call_id])).toEqual([
        ["user", undefined], ["assistant", undefined], ["tool", "a"], ["tool", "b"],
        ["assistant", undefined], ["tool", "c"],
      ]);
      expect(requests[1]!.messages[1]!.tool_calls?.map((c) => c.id)).toEqual(["a", "b"]);
      expect(events.at(-1)?.type).toBe("done");
      expect(ctx.messages).toHaveLength(1);
    });
  });

  test("malformed arguments and actual execution error feed back; later tool succeeds", async () => {
    await fixture((_req, n) => n === 1 ? response("try", [
      { ...call("bad"), arguments: "{" }, call("missing", "read", { path: "missing.txt" }), call("ok"),
    ]) : response("done"), async (ctx, requests) => {
      const events = await collect(ctx);
      const feedback = results(events);
      expect(feedback.map((e) => e.call.id)).toEqual(["bad", "missing", "ok"]);
      expect(feedback[0]!.result).toStartWith("Error:");
      expect(feedback[1]!.result).toContain("ENOENT");
      expect(feedback[2]!.result).toBe("1\tone");
      expect(requests[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content))
        .toEqual(feedback.map((e) => e.result));
    });
  });

  test("memoryStore and contextEngine reach the real executor", async () => {
    await fixture((_req, n) => n === 1 ? response("lookup", [
      call("memory", "anima_recall", { query: "memory-query" }),
      call("context", "anima_context_search", { query: "context-query", limit: 2 }),
    ]) : response("done"), async (ctx) => {
      const calls: unknown[] = [];
      ctx.policy = { ...ctx.policy!, allowedTools: ["anima_recall", "anima_context_search"] };
      ctx.memoryStore = {
        remember: async () => { throw Error("unexpected write"); }, bootstrap: async () => [],
        forget: async () => { throw Error("unexpected delete"); },
        recall: async (query) => { calls.push(["memory", query]); return []; },
      };
      ctx.contextEngine = {
        search: (query: string, limit: number) => { calls.push(["context", query, limit]); return ["context-result"]; },
      } as unknown as TurnContext["contextEngine"];
      const events = await collect(ctx);
      expect(calls).toEqual([["memory", "memory-query"], ["context", "context-query", 2]]);
      expect(results(events).map((e) => e.result)).toEqual(["[]", '{"results":["context-result"]}']);
    });
  });

  test("public run forwards memory/context and records successful memory-tool bookkeeping only", async () => {
    await fixture((_req, n) => n === 1 ? response("lookup", [
      call("memory", "anima_recall", { query: "ok" }),
      call("context", "anima_context_search", { query: "context-query" }),
      call("failed", "anima_recall", { query: "fail" }),
    ]) : response("done"), async (ctx, requests, root) => {
      const lookups: string[] = [];
      const memoryStore = {
        remember: async () => { throw Error("unexpected write"); }, bootstrap: async () => [],
        forget: async () => { throw Error("unexpected delete"); },
        recall: async (query: string) => {
          lookups.push(query);
          if (query === "fail") throw Error("fixture failure");
          return [];
        },
      };
      const contextEngine = {
        search: (query: string) => { lookups.push(query); return []; },
      } as unknown as TurnContext["contextEngine"];
      const agent: LoadedAgent = {
        name: ctx.agentName, label: "Runner fixture", roomDir: root, soulPath: "SOUL.md",
        memoryAdapter: new NullMemoryAdapter(),
        geneContent: "Fixture instructions.", soulContent: "Fixture identity.",
        sessionContextFiles: [], additionalContent: [],
        config: {
          identity: { name: ctx.agentName, label: "Runner fixture" }, provider: { type: "fixture" },
          policy: { allowedRoots: [root], readOnlyRoots: [], allowedTools: ["anima_recall", "anima_context_search"] },
          session: { defaultMode: "edit", autoModeOptIn: false, compactThreshold: 0 },
          boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
        },
      };
      const store = new JsonlStore(root);
      const executed: unknown[] = [];
      const session = new AgentSession({
        store, provider: ctx.provider,
        log: (_level, message, fields) => { if (message === "tool executed") executed.push(fields); },
      });
      await session.run({
        agent, message: "start", sessionId: ctx.sessionId, memoryStore, contextEngine,
        continuityDbPath: join(root, "continuity.db"),
      });
      expect(lookups).toContain("ok");
      expect(lookups).toContain("context-query");
      expect(lookups).toContain("fail");
      expect(requests[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content))
        .toEqual(["[]", '{"results":[]}', "Error: fixture failure"]);
      expect(executed).toHaveLength(3);
      expect(store.readRecent(ctx.agentName, 100).filter((e) => e.type === "memory_tool_call").map((e) => e.tool).sort())
        .toEqual(["anima_context_search", "anima_recall"]);
    });
  });

  test("iteration limit stops at the exact query and execution count with the existing error", async () => {
    await fixture((_req, n) => response("again", [call(String(n))]), async (ctx, requests) => {
      ctx.limits = { maxIterations: 3 };
      const events = await collect(ctx);
      expect(requests).toHaveLength(3);
      expect(results(events)).toHaveLength(3);
      expect(events.filter((e) => e.type === "done")).toHaveLength(0);
      const last = events.at(-1);
      expect(last?.type).toBe("error");
      if (last?.type === "error") expect(String(last.error)).toBe("Error: tool loop exceeded 3 iterations");
    });
  });

  test("unauthorized tool refused by auto guard: no write, explicit feedback, no execution log event", async () => {
    await fixture((_req, n) => n === 1
      ? response("write", [call("forged", "write", { path: "sentinel.txt", content: "leak" })])
      : response("done"), async (ctx, requests, root) => {
      const receipts: unknown[] = [];
      ctx.guard = createAutoGuard((e) => { receipts.push(e); }, ["read"], () => {}).handler;
      const events = await collect(ctx);
      const feedback = results(events);
      expect(feedback).toHaveLength(1);
      expect(feedback[0]).toMatchObject({ blocked: true, call: { id: "forged" } });
      expect(feedback[0]!.result).toContain("tool blocked");
      expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "forged" });
      expect(() => readFileSync(join(root, "sentinel.txt"))).toThrow();
      expect(receipts).toEqual([{
        type: "tool_blocked", tool: "write", reason: "not_in_allowedTools",
        message: "tool 'write' not in allowedTools for this agent",
      }]);
    });
  });

  test("original provider and MCP errors remain observable by identity", async () => {
    for (const source of ["provider", "mcp"]) {
      const failure = new Error(source);
      await fixture(() => {
        if (source === "provider") throw failure;
        return response("mcp", [call("remote", "fixture_mcp")]);
      }, async (ctx) => {
        ctx.mcpManager = {
          getTools: () => [{ name: "fixture_mcp", description: "", input_schema: {} }],
          callTool: async () => { throw failure; },
        };
        const events = await collect(ctx);
        expect(events.at(-1)).toEqual({ type: "error", error: failure });
        if (events.at(-1)?.type === "error") expect((events.at(-1) as { error: unknown }).error).toBe(failure);
      });
    }
  });

  test("MCP result formatting and guard input retain the existing dispatch contract", async () => {
    await fixture((_req, n) => n === 1 ? response("mcp", [call("remote", "fixture_mcp", { x: 3 })])
      : response("done"), async (ctx, requests) => {
      const calls: unknown[] = [];
      ctx.guard = (name, input) => { calls.push(["guard", name, input]); return { allow: true }; };
      ctx.mcpManager = {
        getTools: () => [{ name: "fixture_mcp", description: "", input_schema: {} }],
        callTool: async (name, input) => {
          calls.push(["mcp", name, input]);
          return { content: [{ type: "text", text: "alpha" }, { type: "image", data: "ignored" }, { type: "text", text: "beta" }] };
        },
      };
      const events = await collect(ctx);
      expect(calls).toEqual([["guard", "fixture_mcp", { x: 3 }], ["mcp", "fixture_mcp", { x: 3 }]]);
      expect(results(events)[0]!.result).toBe("alpha\nbeta");
      expect(requests[1]!.messages.at(-1)!.content).toBe("alpha\nbeta");
    });
  });

  test("regression: guard input mutation cannot rewrite the separately parsed MCP arguments", async () => {
    await fixture((_req, n) => n === 1 ? response("mcp", [call("remote", "fixture_mcp", { x: 3 })])
      : response("done"), async (ctx) => {
      ctx.guard = (_name, input) => { input.x = 999; return { allow: true }; };
      const inputs: unknown[] = [];
      ctx.mcpManager = {
        getTools: () => [{ name: "fixture_mcp", description: "", input_schema: {} }],
        callTool: async (_name, input) => { inputs.push(input); return "done"; },
      };
      await collect(ctx);
      expect(inputs).toEqual([{ x: 3 }]);
    });
  });

  test("abort before query starts no provider work", async () => {
    await fixture(() => response("unexpected"), async (ctx, requests) => {
      const controller = new AbortController(); controller.abort(); ctx.signal = controller.signal;
      const events = await collect(ctx);
      expect(requests).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("error");
      if (events[0]?.type === "error") expect(String(events[0].error)).toContain("aborted before");
    });
  });

  test("abort after query returns the response without executing its tools", async () => {
    const controller = new AbortController();
    const final = response("cancelled", [call("a")]);
    await fixture(() => { controller.abort(); return final; }, async (ctx, requests) => {
      ctx.signal = controller.signal;
      const events = await collect(ctx);
      expect(requests).toHaveLength(1);
      expect(results(events)).toHaveLength(0);
      expect(events.at(-1)).toEqual({ type: "done", response: final });
    });
  });

  test("abort between tools starts no later tool or query", async () => {
    const controller = new AbortController();
    const final = response("two", [call("a", "fixture_mcp"), call("b", "fixture_mcp")]);
    await fixture(() => final, async (ctx, requests) => {
      ctx.signal = controller.signal;
      let executions = 0;
      ctx.mcpManager = {
        getTools: () => [{ name: "fixture_mcp", description: "", input_schema: {} }],
        callTool: async () => { executions++; controller.abort(); return "one"; },
      };
      const events = await collect(ctx);
      expect(executions).toBe(1);
      expect(requests).toHaveLength(1);
      expect(results(events).map((e) => e.call.id)).toEqual(["a"]);
      expect(events.at(-1)).toEqual({ type: "done", response: final });
    });
  });

  test("abort during dispatch after the tool event starts no tool", async () => {
    const controller = new AbortController();
    await fixture(() => response("tool", [call("a")]), async (ctx, requests) => {
      ctx.signal = controller.signal;
      let executions = 0;
      ctx.execute = async () => { executions += 1; return "unexpected"; };
      const runner = new TurnRunner().run(ctx);
      let event = await runner.next();
      while (!event.done && event.value.type !== "tool-call") event = await runner.next();
      expect(event.done).toBe(false);
      controller.abort();
      for await (const _event of runner) { /* drain the aborted turn */ }
      expect(executions).toBe(0);
      expect(requests).toHaveLength(1);
    });
  });

  test("abort during dispatch while permission is pending starts no tool", async () => {
    const controller = new AbortController();
    await fixture(() => response("tool", [call("a")]), async (ctx, requests) => {
      ctx.signal = controller.signal;
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const checking = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let executions = 0;
      ctx.guard = async () => { entered(); await gate; return { allow: true }; };
      ctx.execute = async () => { executions += 1; return "unexpected"; };
      const pending = collect(ctx);
      await checking;
      controller.abort();
      release();
      await pending;
      expect(executions).toBe(0);
      expect(requests).toHaveLength(1);
    });
  });

  test("response runner refuses a streaming provider as runToolLoop did", async () => {
    await fixture(() => response("unused"), async (ctx) => {
      ctx.provider = { name: "fixture", query: async function* () { yield { type: "text", content: "unexpected" }; } };
      const events = await collect(ctx);
      expect(events).toHaveLength(1);
      if (events[0]?.type !== "error") throw new Error("expected runner error");
      expect(String(events[0].error)).toContain("streaming provider responses are not supported by AgentSession.runToolLoop");
    });
  });
});

describe("shared auto guard", () => {
  test("allowlist, unauthorized refusal and completion count include attempted calls without storing input", async () => {
    const receipts: unknown[] = [], completed: unknown[] = [];
    const guard = createAutoGuard((e) => { receipts.push(e); }, ["read"], (stats) => { completed.push(stats); });
    expect(await guard.handler("read", { private: "never record" })).toEqual({ allow: true });
    expect(await guard.handler("write", { private: "never record" })).toMatchObject({ allow: false });
    expect(await guard.handler("read", {})).toEqual({ allow: true });
    guard.complete();
    expect(completed).toEqual([{ tools: ["read", "write"], count: 3 }]);
    expect(JSON.stringify(receipts)).not.toContain("never record");
  });

  test("missing or empty allowlists refuse every tool; separate guards have separate counts", async () => {
    const counts: unknown[] = [];
    for (const tools of [undefined, []]) {
      const guard = createAutoGuard(() => {}, tools, (stats) => { counts.push(stats); });
      expect(await guard.handler("read", {})).toMatchObject({ allow: false });
      guard.complete();
    }
    expect(counts).toEqual([{ tools: ["read"], count: 1 }, { tools: ["read"], count: 1 }]);
  });

  test("session and CLI wire one shared implementation and one TurnContext argument", () => {
    const session = readFileSync(new URL("../../src/agents/session.ts", import.meta.url), "utf8");
    const cli = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
    expect(session.includes('from "./auto-guard"')).toBe(true);
    expect(cli.includes('from "./agents/auto-guard"')).toBe(true);
    expect(session).not.toContain("private createAutoGuard(");
    expect(cli).not.toContain("function createAutoGuard(");
    expect(session).toContain("runToolLoop(context: TurnContext)");
    expect(session).not.toContain("options: RunAgentSessionOptions,\n    mode: PermissionMode,");
  });
});
