import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner, type TurnContext, type TurnEvent } from "../../src/agents/turn-runner";
import { runTalkToolLoop } from "../../src/agents/talk-runtime";
import type { Provider, ProviderChunk, ProviderMessage, ProviderResponse, ProviderToolCall } from "../../src/providers/interface";

const call = (id = "a", name = "read", args: unknown = { path: "one.txt" }): ProviderToolCall =>
  ({ id, name, arguments: JSON.stringify(args) });
const response = (content: ProviderMessage["content"] = "done", calls?: ProviderToolCall[]): ProviderResponse =>
  ({ message: { role: "assistant", content }, tool_calls: calls });
async function fixture(check: (ctx: TurnContext, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "anima-turn-stream-"));
  writeFileSync(join(root, "one.txt"), "one");
  const ctx: TurnContext = {
    agentName: "stream-fixture", cwd: root, sessionId: "fixture-session", mode: "edit",
    provider: { name: "fixture", query: async () => response() },
    messages: [{ role: "user", content: "start" }], tools: [], limits: { maxIterations: 64 },
    policy: { allowedRoots: [root], allowedTools: ["read"], readOnlyRoots: [], enforce: "block" },
    surface: { kind: "stream" },
  };
  try { await check(ctx, root); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function collect(ctx: TurnContext) {
  const events: TurnEvent[] = [];
  for await (const event of new TurnRunner().run(ctx)) events.push(event);
  return events;
}
const chunks = (events: TurnEvent[]) => events.flatMap((e) => e.type === "provider-chunk" ? [e.chunk] : []);
const done = (events: TurnEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== "done") throw Error(`expected done, got ${last?.type}`);
  return last.response;
};

describe("stream TurnRunner compatibility", () => {
  test("native chunks preserve identity, tool_use/error/usage metadata and duplicate execution-call ordering", async () => {
    await fixture(async (ctx) => {
      const tc = call(), usage = { input_tokens: 9, output_tokens: 4 };
      const input: ProviderChunk[] = [
        { type: "text", content: "work" }, { type: "tool_use", tool_use: call("hint") },
        { type: "error", error: "provider advisory" }, { type: "tool_call", tool_call: tc, usage },
      ];
      const requests: ProviderMessage[][] = [];
      let n = 0;
      ctx.provider = { name: "fixture", query: (req) => (async function* () {
        requests.push(structuredClone(req.messages));
        if (++n === 1) yield* input;
        else yield { type: "text", content: "final", usage } as ProviderChunk;
      })() };
      const events = await collect(ctx);
      expect(chunks(events)).toEqual([...input, { type: "text", content: "final", usage }]);
      input.forEach((chunk, i) => expect(chunks(events)[i]).toBe(chunk));
      expect(events.map((e) => e.type)).toEqual([
        "provider-chunk", "provider-chunk", "provider-chunk", "provider-chunk",
        "tool-call", "tool-result", "provider-chunk", "done",
      ]);
      expect(events.find((e) => e.type === "tool-call")).toMatchObject({ call: tc, iteration: 0 });
      expect(requests[1]!.slice(-2)).toEqual([
        { role: "assistant", content: "work", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: tc.arguments } }] },
        { role: "tool", tool_call_id: "a", content: "1\tone" },
      ]);
      expect(done(events)).toMatchObject({ message: { content: "final" }, usage });
    });
  });

  test("regression: final native usage does not inherit an earlier round; consumer return closes provider", async () => {
    await fixture(async (ctx) => {
      let queries = 0, closed = 0;
      ctx.provider = { name: "fixture", query: () => (async function* () {
        try {
          yield { type: "text", content: "a" } as ProviderChunk;
          yield { type: "text", content: "b" } as ProviderChunk;
          if (++queries === 1) yield { type: "tool_call", tool_call: call(), usage: { input_tokens: 9, output_tokens: 1 } } as ProviderChunk;
        } finally { closed++; }
      })() };
      const events = await collect(ctx);
      expect(done(events).message.content).toBe("ab");
      expect(done(events).usage).toBeUndefined();
      expect(closed).toBe(2);
      const generator = new TurnRunner().run(ctx);
      expect((await generator.next()).value).toMatchObject({ type: "provider-chunk", chunk: { content: "a" } });
      await generator.return(undefined);
      expect(closed).toBe(3);
    });
  });

  test("response-form streaming normalizes structured and null content; empty tool-round text becomes null", async () => {
    for (const content of [null, [{ type: "text", text: "structured" }]]) {
      await fixture(async (ctx) => {
        const requests: ProviderMessage[][] = [];
        ctx.provider = { name: "fixture", query: async (req) => {
          requests.push(structuredClone(req.messages));
          return requests.length === 1 ? response(content, [call()]) : response("final");
        } };
        const events = await collect(ctx);
        const normalized = content === null ? "" : JSON.stringify(content);
        expect(chunks(events)).toEqual([{ type: "text", content: normalized }, { type: "text", content: "final" }]);
        expect(requests[1]![1]!.content).toBe(normalized || null);
      });
    }
  });

  test("disabled tools suppress only tool_call, keep tool_use/error/usage and emit ignored calls without execution", async () => {
    await fixture(async (ctx, root) => {
      ctx.surface = { kind: "stream", disableTools: true };
      const tc = call("deny", "write", { path: "sentinel", content: "forbidden" });
      const input: ProviderChunk[] = [
        { type: "tool_use", tool_use: tc }, { type: "tool_call", tool_call: tc },
        { type: "error", error: "advisory", usage: { input_tokens: 1, output_tokens: 2 } },
      ];
      let queries = 0;
      ctx.provider = { name: "fixture", query: () => (async function* () { queries++; yield* input; })() };
      const events = await collect(ctx);
      expect(chunks(events)).toEqual([input[0]!, input[2]!]);
      expect(events.find((e) => e.type === "tools-disabled")).toEqual({ type: "tools-disabled", calls: [tc] });
      expect(events.filter((e) => e.type === "tool-result")).toHaveLength(0);
      expect(done(events).usage).toEqual(input[2]!.usage);
      expect(queries).toBe(1);
      expect(() => readFileSync(join(root, "sentinel"))).toThrow();
    });
  });

  test("stream cap ends silently after exact query/execution count and retains final usage", async () => {
    await fixture(async (ctx) => {
      let queries = 0;
      ctx.limits.maxIterations = 2;
      ctx.provider = { name: "fixture", query: async () => ({ ...response(`round${++queries}`, [call()]), usage: { input_tokens: queries, output_tokens: 0 } }) };
      const events = await collect(ctx);
      expect(queries).toBe(2);
      expect(events.filter((e) => e.type === "tool-result")).toHaveLength(2);
      expect(done(events)).toMatchObject({ message: { content: "round2" }, usage: { input_tokens: 2 } });
      expect(events.some((e) => e.type === "error")).toBe(false);
    });
  });

  test("unauthorized streaming guard refuses with feedback, no successful execution event", async () => {
    await fixture(async (ctx) => {
      const requests: ProviderMessage[][] = [];
      ctx.guard = () => ({ allow: false, message: "unauthorized fixture" });
      ctx.provider = { name: "fixture", query: async (req) => {
        requests.push(structuredClone(req.messages));
        return requests.length === 1 ? response("", [call()]) : response("final");
      } };
      const events = await collect(ctx);
      expect(events.filter((e) => e.type === "tool-result")).toEqual([
        { type: "tool-result", call: call(), result: "Error: tool blocked — unauthorized fixture", iteration: 0, blocked: true },
      ]);
      expect(requests[1]!.at(-1)).toMatchObject({ role: "tool", tool_call_id: "a", content: "Error: tool blocked — unauthorized fixture" });
    });
  });

  test("stream provider and MCP exceptions preserve identity; advisory chunk is not a fatal event", async () => {
    for (const source of ["provider", "mcp"]) await fixture(async (ctx) => {
      const failure = new Error(source);
      ctx.provider = { name: "fixture", query: () => (async function* () {
        yield { type: "error", error: "advisory" } as ProviderChunk;
        if (source === "provider") throw failure;
        yield { type: "tool_call", tool_call: call("remote", "mcp") } as ProviderChunk;
      })() };
      ctx.mcpManager = { getTools: () => [{ name: "mcp", description: "", input_schema: {} }], callTool: async () => { throw failure; } };
      const events = await collect(ctx);
      expect(chunks(events)[0]).toEqual({ type: "error", error: "advisory" });
      expect(events.at(-1)?.type).toBe("error");
      if (events.at(-1)?.type === "error") expect((events.at(-1) as { error: unknown }).error).toBe(failure);
    });
  });

  test("abort between native tools executes no second call or query, finishes with last text", async () => {
    await fixture(async (ctx) => {
      const controller = new AbortController(); ctx.signal = controller.signal;
      let queries = 0, executions = 0;
      ctx.provider = { name: "fixture", query: () => (async function* () {
        queries++;
        yield { type: "text", content: "partial" } as ProviderChunk;
        yield { type: "tool_call", tool_call: call("a", "mcp") } as ProviderChunk;
        yield { type: "tool_call", tool_call: call("b", "mcp") } as ProviderChunk;
      })() };
      ctx.mcpManager = { getTools: () => [{ name: "mcp", description: "", input_schema: {} }], callTool: async () => { executions++; controller.abort(); return "ok"; } };
      const events = await collect(ctx);
      expect([queries, executions]).toEqual([1, 1]);
      expect(events.filter((e) => e.type === "tool-call").map((e) => e.call.id)).toEqual(["a"]);
      expect(done(events).message.content).toBe("partial");
    });
  });
});

describe("talk TurnRunner compatibility", () => {
  test("CLI adapter uses real executor context and passes feedback through runner without granting unrelated tools", async () => {
    await fixture(async (ctx) => {
      const messages: ProviderMessage[][] = [];
      const result = await runTalkToolLoop({
        first: response("work", [call(), call("mem", "anima_recall", { query: "fixture" }), call("context", "anima_context_search", { query: "fixture-context" })]),
        messages: ctx.messages,
        execution: { cwd: ctx.cwd, agentName: ctx.agentName, policy: { ...ctx.policy!, allowedTools: ["read", "anima_recall", "anima_context_search"] }, contextEngine: { search: () => ["context"] } as unknown as TurnContext["contextEngine"], memoryStore: {
          remember: async () => { throw Error("no writes"); }, forget: async () => { throw Error("no writes"); }, bootstrap: async () => [], recall: async () => [],
        } },
        query: async (next) => { messages.push(next); return response(""); },
      });
      expect(messages[0]!.slice(-3).map((m) => m.content)).toEqual(["1\tone", "[]", '{"results":["context"]}']);
      expect(result.toolOutputs).toEqual(["[read] 1\tone", "[anima_recall] []", '[anima_context_search] {"results":["context"]}']);
      expect(result.result.message.content).toBe("");
    });
  });

  test("later query failure reports the right round and retains previous result and fallback; execution errors propagate", async () => {
    const first = response("work", [call()]), failure = new Error("query");
    const reported: unknown[] = [];
    const result = await runTalkToolLoop({ first, messages: [], runTool: async () => "output", query: async () => { throw failure; }, onRoundError: (round, error) => { reported.push([round, error]); } });
    expect(result).toEqual({ result: first, toolOutputs: ["[read] output"] });
    expect(reported).toEqual([[1, failure]]);
    const executed = new Error("executor");
    await expect(runTalkToolLoop({ first, messages: [], runTool: async () => { throw executed; }, query: async () => response() })).rejects.toBe(executed);
  });

  test("talk cap retains final extra response, feedback copies and fallback truncation", async () => {
    let queries = 0, executions = 0;
    const sent: ProviderMessage[][] = [];
    const initial: ProviderMessage[] = [{ role: "user", content: "start" }];
    const first = response("work", [call("deny"), call("ok")]);
    const result = await runTalkToolLoop({
      first, messages: initial, maxRounds: 2,
      canUseTool: (_name, input) => ({ allow: input.path !== "denied" }),
      runTool: async () => { executions++; return "x".repeat(2001); },
      query: async (messages) => { sent.push(messages); queries++; return response(`q${queries}`, [call(String(queries))]); },
    });
    expect(queries).toBe(2);
    expect(executions).toBe(3);
    expect(result.result.message.content).toBe("q2");
    expect(result.toolOutputs).toHaveLength(3);
    expect(result.toolOutputs[0]).toBe(`[read] ${"x".repeat(2000)}\n...(truncated)`);
    expect(initial).toHaveLength(1);
    expect(sent[0]).toHaveLength(4);
    expect(sent[1]).toHaveLength(6);
    expect(sent[0]).not.toBe(sent[1]);
  });

  test("unauthorized talk guard blocks execution and omits fallback while retaining feedback", async () => {
    let executions = 0;
    const sent: ProviderMessage[][] = [];
    const result = await runTalkToolLoop({ first: response("", [call()]), messages: [],
      canUseTool: () => ({ allow: false, message: "unauthorized" }),
      runTool: async () => { executions++; return "forbidden"; },
      query: async (messages) => { sent.push(messages); return response(""); },
    });
    expect(executions).toBe(0);
    expect(result.toolOutputs).toEqual([]);
    expect(sent[0]!.at(-1)?.content).toBe("Error: tool blocked — unauthorized");
  });

  test("regression: fractional, negative and NaN talk limits retain the legacy loop boundary", async () => {
    for (const [maxRounds, expected] of [[1.5, 2], [-0.5, 0], [Number.NaN, 0]] as const) {
      let queries = 0, executions = 0;
      const result = await runTalkToolLoop({ first: response("first", [call()]), messages: [], maxRounds,
        runTool: async () => { executions++; return "ok"; },
        query: async () => { queries++; return response("next", [call()]); },
      });
      expect([queries, executions]).toEqual([expected, expected]);
      expect(result.result.message.content).toBe(expected ? "next" : "first");
    }
  });

  test("zero rounds returns initial response without query or execution", async () => {
    const first = response("initial", [call()]);
    const result = await runTalkToolLoop({ first, messages: [], maxRounds: 0, query: async () => { throw Error("unexpected query"); }, runTool: async () => { throw Error("unexpected execution"); } });
    expect(result).toEqual({ result: first, toolOutputs: [] });
  });
});

test("shared generator predicate and source wiring eliminate migrated loops and direct executor calls", async () => {
  const { isAsyncGenerator } = await import("../../src/utils/async-generator");
  const generator = (async function* () { yield 1; })();
  expect(isAsyncGenerator(generator)).toBe(true);
  for (const value of [null, undefined, 0, "text", {}, response(), Promise.resolve(response())]) expect(isAsyncGenerator(value)).toBe(false);
  await generator.return(undefined);
  const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
  for (const file of ["agents/session.ts", "cli.ts", "agents/talk-runtime.ts"]) expect(source(file)).not.toMatch(/\bexecuteTool\(/);
  expect(source("agents/session.ts")).not.toContain("streamProviderQuery(");
  expect(source("agents/talk-runtime.ts")).not.toContain("for (let round");
  expect(source("cli.ts")).toContain("execution:");
  for (const file of ["cli.ts", "continuity/reflection-engine.ts"]) {
    expect(source(file)).toContain('utils/async-generator"');
    expect(source(file)).not.toContain("function isAsyncGenerator(");
  }
});
