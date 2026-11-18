import { afterEach, describe, test, expect, mock, beforeAll } from "bun:test";
import { resolveModel } from "./model-resolver";
import { parseAnthropicRequest } from "./anthropic-inbound";
import { parseOpenAIRequest } from "./openai-inbound";
import { toAnthropicResponse, toAnthropicStream } from "./anthropic-outbound";
import { toOpenAIChatResponse, toOpenAIChatStream } from "./openai-outbound";
import { detectCaller } from "./caller";
import { handleProxyRequest } from "./index";
import { streamProxyRequest } from "./stream";
import type { ProviderDef } from "../config/types";
import type { ProviderResponse } from "../providers/interface";

// Stub model-override (no overrides in tests)
mock.module("./model-override", () => ({ resolveOverride: async () => null }));

// ── Mock registry ─────────────────────────────────────────────────────────────

function makeRegistry(models: string[]) {
  return {
    list: () => [
      {
        id: "test-provider",
        label: "Test",
        baseUrl: "https://test.example.com",
        api: "openai-completions" as const,
        apiKey: "test-key",
        models: models.map((id) => ({ id })),
      },
    ],
    get: () => undefined,
    resolve: () => { throw new Error("not used"); },
  } as unknown as import("../providers/registry").ProviderRegistry;
}

// ── resolveModel ─────────────────────────────────────────────────

describe("resolveModel", () => {
  test("finds provider for known model id", () => {
    const registry = makeRegistry(["gpt-4o", "gpt-4o-mini"]);
    const result = resolveModel("gpt-4o", registry);
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe("gpt-4o");
  });

  test("returns null for unknown model", () => {
    const registry = makeRegistry(["gpt-4o"]);
    const result = resolveModel("nonexistent-model", registry);
    expect(result).toBeNull();
  });
});

// ── parseAnthropicRequest ────────────────────────────────────────

describe("parseAnthropicRequest", () => {
  test("maps messages and system correctly", () => {
    const { req } = parseAnthropicRequest({
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(req.system).toBe("You are helpful.");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    expect(req.messages[0]!.content).toBe("Hello");
    expect(req.agent).toBe("proxy-gateway");
    expect(req.mode).toBe("auto");
  });

  test("maps tools to ProviderTool (input_schema)", () => {
    const { req } = parseAnthropicRequest({
      model: "claude-sonnet-4-6",
      messages: [],
      tools: [{ name: "search", description: "search the web", input_schema: { type: "object", properties: {} } }],
    });
    expect(req.tools).toHaveLength(1);
    expect((req.tools![0] as any).input_schema).toBeDefined();
  });

  test("stream flag is extracted", () => {
    const { stream } = parseAnthropicRequest({ model: "x", messages: [], stream: true });
    expect(stream).toBe(true);
  });
});

// ── parseOpenAIRequest ───────────────────────────────────────────

describe("parseOpenAIRequest", () => {
  test("extracts system message, maps remaining messages", () => {
    const { req } = parseOpenAIRequest({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
    });
    expect(req.system).toBe("You are helpful.");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
  });

  test("maps tools to ProviderToolDefinition (parameters)", () => {
    const { req } = parseOpenAIRequest({
      model: "gpt-4o",
      messages: [],
      tools: [{ type: "function", function: { name: "search", description: "search", parameters: { type: "object" } } }],
    });
    expect(req.tools).toHaveLength(1);
    expect((req.tools![0] as any).parameters).toBeDefined();
  });
});

// ── Tasks 3.3 & 3.5: response JSON format ─────────────────────────────────

const sampleResponse: ProviderResponse = {
  message: { role: "assistant", content: "Hello world" },
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe("streamProxyRequest OpenCode Go session routing", () => {
  const originalFetch = globalThis.fetch;

  function opencodeProvider(api: "openai-completions" | "anthropic-messages"): ProviderDef {
    return {
      id: api === "anthropic-messages" ? "opencode-go" : "opencode-go-oai",
      label: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      endpoint: api === "anthropic-messages" ? "/messages" : "/chat/completions",
      api,
      apiKey: "test-key",
      models: [{ id: "test-model" }],
    };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("adds the stable conversation header on an OpenAI streaming request", async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input, init = {}) => {
      headers = new Headers(init.headers);
      return new Response("data: [DONE]\\n\\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    await streamProxyRequest({ agent: "codex", sessionId: "conversation-123", mode: "auto", model: "test-model", messages: [] }, opencodeProvider("openai-completions"), "openai");

    expect(headers?.get("x-opencode-session")).toBe("conversation-123");
  });

  test("adds a deterministic fallback header on an Anthropic streaming request", async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input, init = {}) => {
      headers = new Headers(init.headers);
      return new Response("event: message_stop\\ndata: {}\\n\\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    await streamProxyRequest({ agent: "proxy-gateway", mode: "auto", model: "test-model", messages: [] }, opencodeProvider("anthropic-messages"), "anthropic");

    expect(headers?.get("x-opencode-session")).toBe("anima:proxy-gateway");
  });

  test("does not add the OpenCode header for other streaming providers", async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input, init = {}) => {
      headers = new Headers(init.headers);
      return new Response("data: [DONE]\\n\\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    await streamProxyRequest(
      { agent: "codex", sessionId: "conversation-123", mode: "auto", model: "test-model", messages: [] },
      { id: "exampleprov", label: "Nahcrof", baseUrl: "https://exampleprov.example/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "test-model" }] },
      "openai",
    );

    expect(headers?.get("x-opencode-session")).toBeNull();
  });
});

describe("toAnthropicResponse", () => {
  test("correct shape and content", () => {
    const out = toAnthropicResponse(sampleResponse, "claude-sonnet-4-6") as any;
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toBe("Hello world");
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.usage.input_tokens).toBe(10);
    expect(out.usage.output_tokens).toBe(5);
  });
});

describe("toOpenAIChatResponse", () => {
  test("correct choices[0].message shape", () => {
    const out = toOpenAIChatResponse(sampleResponse, "gpt-4o") as any;
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.role).toBe("assistant");
    expect(out.choices[0].message.content).toBe("Hello world");
    expect(out.usage.prompt_tokens).toBe(10);
    expect(out.usage.completion_tokens).toBe(5);
  });
});

// ── Tasks 3.4 & 3.6: stream format ─────────────────────────────────────────

async function readStream(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
}

describe("toAnthropicStream", () => {
  test("emits events in correct SSE order, terminates with message_stop", async () => {
    const raw = await readStream(toAnthropicStream(sampleResponse, "claude-sonnet-4-6"));
    const eventNames = [...raw.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventNames).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(raw).toContain("Hello world");
  });
});

describe("toOpenAIChatStream", () => {
  test("emits delta chunks + [DONE] terminator", async () => {
    const raw = await readStream(toOpenAIChatStream(sampleResponse, "gpt-4o"));
    expect(raw).toContain("chat.completion.chunk");
    expect(raw).toContain("Hello world");
    expect(raw).toContain("[DONE]");
  });
});

// ── gateway integration ─────────────────────────────────────

function makeMockProvider(response: ProviderResponse) {
  return {
    name: "mock-provider",
    query: async () => response,
  };
}

function makeRegistryWithMock(modelName: string, response: ProviderResponse) {
  const mockProvider = makeMockProvider(response);
  return {
    list: () => [
      {
        id: "mock-provider",
        label: "Mock",
        baseUrl: "https://mock.test",
        api: "openai-completions" as const,
        apiKey: "key",
        models: [{ id: modelName }],
      },
    ],
  } as unknown as import("../providers/registry").ProviderRegistry;
}

describe("handleProxyRequest", () => {
  test("POST /ai/v1/messages stream=false → Anthropic JSON response", async () => {
    const registry = makeRegistryWithMock("claude-sonnet-4-6", sampleResponse);
    mock.module("./model-resolver", () => ({
      resolveModel: (_: string, __: unknown) => ({
        provider: makeMockProvider(sampleResponse),
        providerDef: {},
        modelId: "claude-sonnet-4-6",
      }),
    }));

    const req = new Request("http://localhost:3700/ai/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hi" }], stream: false }),
    });
    const res = await handleProxyRequest(req, registry);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("Hello world");
  });

  test("POST /ai/v1/messages stream=true → text/event-stream", async () => {
    mock.module("./model-resolver", () => ({
      resolveModel: (_: string, __: unknown) => ({
        provider: makeMockProvider(sampleResponse),
        providerDef: { id: "mock", api: "anthropic-messages", baseUrl: "https://mock.test", apiKey: "k", models: [] },
        modelId: "claude-sonnet-4-6",
      }),
    }));
    // Stub real streaming so no network call is made
    mock.module("./stream", () => ({
      streamProxyRequest: async () => new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: test\n\n")); c.close(); } }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    }));

    const registry = makeRegistryWithMock("claude-sonnet-4-6", sampleResponse);
    const req = new Request("http://localhost:3700/ai/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });
    const res = await handleProxyRequest(req, registry);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  test("POST /ai/v1/chat/completions stream=false → OpenAI JSON response", async () => {
    mock.module("./model-resolver", () => ({
      resolveModel: (_: string, __: unknown) => ({
        provider: makeMockProvider(sampleResponse),
        providerDef: {},
        modelId: "gpt-4o",
      }),
    }));

    const registry = makeRegistryWithMock("gpt-4o", sampleResponse);
    const req = new Request("http://localhost:3700/ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }], stream: false }),
    });
    const res = await handleProxyRequest(req, registry);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe("chat.completion");
  });

  test("unknown model → 400 with correct error format", async () => {
    mock.module("./model-resolver", () => ({
      resolveModel: () => null,
    }));

    const registry = makeRegistry([]);
    const req = new Request("http://localhost:3700/ai/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "unknown-model", messages: [] }),
    });
    const res = await handleProxyRequest(req, registry);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error?.message).toContain("model not found");
  });
});

// ── detectCaller ──────────────────────────────────────────────────────────────

describe("detectCaller", () => {
  function makeReq(ua?: string, xAnimaCaller?: string) {
    const headers: Record<string, string> = {};
    if (ua) headers["user-agent"] = ua;
    if (xAnimaCaller) headers["x-anima-caller"] = xAnimaCaller;
    return new Request("http://localhost/ai/v1/messages", { method: "POST", headers });
  }

  test("detects claude-code from User-Agent", () => {
    expect(detectCaller(makeReq("claude-code/1.2.3 anthropic-sdk-typescript/0.50.0"))).toBe("claude-code");
  });

  test("detects codex from User-Agent", () => {
    expect(detectCaller(makeReq("openai-codex/1.0.0"))).toBe("codex");
  });

  test("detects anthropic-sdk from User-Agent", () => {
    expect(detectCaller(makeReq("anthropic-sdk-python/0.34.0"))).toBe("anthropic-sdk");
  });

  test("falls back to proxy-gateway for unknown UA", () => {
    expect(detectCaller(makeReq("curl/7.88.0"))).toBe("proxy-gateway");
  });

  test("x-anima-caller header overrides detection", () => {
    expect(detectCaller(makeReq("claude-code/1.0", "my-script"))).toBe("my-script");
  });

  test("no headers → proxy-gateway", () => {
    expect(detectCaller(makeReq())).toBe("proxy-gateway");
  });
});
