import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTalkProvider, runTalkToolLoop } from "../../src/agents/talk-runtime";
import type { ModeMap, ProviderConfig } from "../../src/config/types";
import { CircuitBreaker } from "../../src/providers/circuit-breaker";
import {
  ProviderError,
  type Provider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
} from "../../src/providers/interface";

function makeRegistry(providers: Array<{ id: string; models: string[] }>) {
  const map = new Map(
    providers.map((p) => [
      p.id,
      {
        id: p.id,
        label: p.id,
        baseUrl: "https://mock.local/v1",
        api: "openai-completions" as const,
        apiKey: "mock-key",
        models: p.models.map((id) => ({ id })),
      },
    ]),
  );
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
    resolve: (ref: string) => {
      const at = ref.lastIndexOf("@");
      const provider = map.get(ref.slice(at + 1));
      if (!provider) throw new Error(`unknown provider: ${ref}`);
      const model = provider.models.find((m) => m.id === ref.slice(0, at));
      if (!model) throw new Error(`unknown model: ${ref}`);
      return { provider, model };
    },
  } as any;
}

const modeMap = {
  chatting: [], programming: [], image: [], private: [], philosophy: [], creative: [],
} as unknown as ModeMap;

function breaker(): CircuitBreaker {
  return new CircuitBreaker(join(mkdtempSync(join(tmpdir(), "talk-runtime-")), "breaker.json"));
}

function text(content: string): ProviderResponse {
  return { message: { role: "assistant", content } };
}

const request: ProviderRequest = { agent: "finn", mode: "auto", messages: [{ role: "user", content: "review #13" }] };

const withFallback: ProviderConfig = {
  type: "opencode-go-oai",
  model: "longcat-2.5-preview-free",
  fallback: [{ type: "agnes", model: "agnes-3.0-flash" }],
};

describe("createTalkProvider", () => {
  test("CT-1 a SERVER_ERROR from the primary is answered by the first fallback model", async () => {
    const registry = makeRegistry([
      { id: "opencode-go-oai", models: ["longcat-2.5-preview-free"] },
      { id: "agnes", models: ["agnes-3.0-flash"] },
    ]);
    const seen: string[] = [];
    const provider = await createTalkProvider(
      withFallback,
      { providerName: "opencode-go-oai", providerFlag: false, modelFlag: false, taskMode: "programming" },
      {
        registry,
        loadModeMap: async () => modeMap,
        breaker: breaker(),
        createDirect: async () => { throw new Error("direct provider must not be used when a fallback chain exists"); },
        createProvider: (providerId): Provider => ({
          name: providerId,
          async query(req) {
            seen.push(`${req.model}@${providerId}`);
            if (providerId === "opencode-go-oai") {
              throw new ProviderError("SERVER_ERROR", providerId, "Upstream request failed: Endpoint is unavailable.");
            }
            return text("answer from agnes");
          },
        }),
      },
    );

    const result = (await provider.query(request)) as ProviderResponse;

    expect(result.message.content).toBe("answer from agnes");
    expect(seen.at(-1)).toBe("agnes-3.0-flash@agnes");
    expect(seen.filter((ref) => ref.endsWith("@opencode-go-oai")).length).toBeGreaterThan(0);
  });

  test("CT-2 without a fallback the configured provider is called directly", async () => {
    const direct: Provider = { name: "direct", query: async () => text("direct") };
    const provider = await createTalkProvider(
      { type: "agnes", model: "agnes-3.0-flash" },
      { providerName: "agnes", providerFlag: false, modelFlag: false, taskMode: "chatting" },
      { registry: makeRegistry([{ id: "agnes", models: ["agnes-3.0-flash"] }]), loadModeMap: async () => modeMap, createDirect: async (name) => (name === "agnes" ? direct : Promise.reject(new Error(name))) },
    );
    expect(provider).toBe(direct);
  });

  test("CT-3 an explicit --provider or --model bypasses the chain", async () => {
    const registry = makeRegistry([
      { id: "opencode-go-oai", models: ["longcat-2.5-preview-free"] },
      { id: "agnes", models: ["agnes-3.0-flash"] },
      { id: "hypercharm", models: ["prism"] },
    ]);
    const direct: Provider = { name: "direct", query: async () => text("direct") };
    const deps = { registry, loadModeMap: async () => modeMap, createDirect: async () => direct };
    expect(await createTalkProvider(withFallback, { providerName: "hypercharm", providerFlag: true, modelFlag: true, taskMode: "chatting" }, deps)).toBe(direct);
    expect(await createTalkProvider(withFallback, { providerName: "opencode-go-oai", providerFlag: false, modelFlag: true, taskMode: "chatting" }, deps)).toBe(direct);
  });
});

describe("createTalkProvider review fixes", () => {
  test("CT-7 a direct provider never loads the global mode map", async () => {
    const registry = makeRegistry([{ id: "primary", models: ["m1"] }, { id: "backup", models: ["m1"] }]);
    const direct: Provider = { name: "direct", query: async () => text("direct") };
    const deps = {
      registry,
      loadModeMap: async (): Promise<ModeMap> => { throw new Error("invalid mode map: missing programming"); },
      createDirect: async () => direct,
    };
    const withChain: ProviderConfig = { type: "primary", model: "m1", fallback: [{ type: "backup", model: "m1" }] };
    expect(await createTalkProvider(withChain, { providerName: "primary", providerFlag: true, modelFlag: true, taskMode: "programming" }, deps)).toBe(direct);
    expect(await createTalkProvider({ type: "primary", model: "m1" }, { providerName: "primary", providerFlag: false, modelFlag: false, taskMode: "programming" }, deps)).toBe(direct);
  });

  test("CT-8 a config without a model keeps its primary's first registered model ahead of the fallback", async () => {
    const registry = makeRegistry([{ id: "primary", models: ["p-default", "p-other"] }, { id: "backup", models: ["m1"] }]);
    const seen: string[] = [];
    const provider = await createTalkProvider(
      { type: "primary", fallback: [{ type: "backup", model: "m1" }] },
      { providerName: "primary", providerFlag: false, modelFlag: false, taskMode: "chatting" },
      {
        registry,
        loadModeMap: async () => modeMap,
        breaker: breaker(),
        createDirect: async () => { throw new Error("direct provider must not be used when a fallback chain exists"); },
        createProvider: (providerId): Provider => ({ name: providerId, async query(req) { seen.push(`${req.model}@${providerId}`); return text(`from ${providerId}`); } }),
      },
    );
    const result = (await provider.query(request)) as ProviderResponse;
    expect(result.message.content).toBe("from primary");
    expect(seen).toEqual(["p-default@primary"]);
  });
});

function toolCall(id: string, name = "bash") {
  return { id, name, arguments: JSON.stringify({ command: `echo ${id}` }) };
}

describe("runTalkToolLoop", () => {
  test("CT-4 tool calls and results are sent back as assistant tool_calls and tool messages", async () => {
    const requests: ProviderMessage[][] = [];
    const base: ProviderMessage[] = [{ role: "user", content: "review #13" }];
    const { result } = await runTalkToolLoop({
      first: { message: { role: "assistant", content: "reading" }, tool_calls: [toolCall("c1"), toolCall("c2", "read")] },
      messages: base,
      query: async (messages) => { requests.push(messages.map((m) => ({ ...m }))); return text("posted"); },
      runTool: async (call) => `output of ${call.id}`,
    });

    expect(result.message.content).toBe("posted");
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.slice(0, 1)).toEqual(base);
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "reading",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo c1" }) } },
        { id: "c2", type: "function", function: { name: "read", arguments: JSON.stringify({ command: "echo c2" }) } },
      ],
    });
    expect(sent[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "output of c1" });
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "c2", content: "output of c2" });
    expect(JSON.stringify(sent)).not.toContain("Now write output files");
  });

  test("CT-5 a task needing six tool rounds runs them all and returns the final text", async () => {
    let round = 0;
    const ran: string[] = [];
    const { result } = await runTalkToolLoop({
      first: { message: { role: "assistant", content: "" }, tool_calls: [toolCall("r0")] },
      messages: [{ role: "user", content: "go" }],
      query: async () => {
        round++;
        return round < 6
          ? { message: { role: "assistant", content: "" }, tool_calls: [toolCall(`r${round}`)] }
          : text("https://github.com/rfcclub/colony-mesh/issues/13#issuecomment-1");
      },
      runTool: async (call) => { ran.push(call.id); return "ok"; },
    });

    expect(ran).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
    expect(result.message.content).toBe("https://github.com/rfcclub/colony-mesh/issues/13#issuecomment-1");
  });

  test("CT-6 a call denied by the guard is not run and still gets a tool result", async () => {
    const ran: string[] = [];
    let sent: ProviderMessage[] = [];
    await runTalkToolLoop({
      first: { message: { role: "assistant", content: "" }, tool_calls: [toolCall("ok1"), toolCall("deny1", "write")] },
      messages: [{ role: "user", content: "go" }],
      canUseTool: (name) => (name === "write" ? { allow: false, message: "write is not allowed" } : { allow: true }),
      query: async (messages) => { sent = messages; return text("done"); },
      runTool: async (call) => { ran.push(call.id); return "ran"; },
    });

    expect(ran).toEqual(["ok1"]);
    expect(sent.find((m) => m.tool_call_id === "deny1")).toEqual({
      role: "tool",
      tool_call_id: "deny1",
      content: "Error: tool blocked — write is not allowed",
    });
  });
});
