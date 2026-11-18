import { afterEach, expect, test } from "bun:test";
import type { ProviderDef } from "../src/config/types";
import { OpenAIv1ChatProvider } from "../src/providers/openai-v1-chat";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("OpenCode Go receives the conversation session header", async () => {
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedHeaders = new Headers(init.headers);
    return jsonResponse();
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ id: "opencode-go-oai", baseUrl: "https://opencode.ai/zen/go/v1" }));
  await provider.query({
    agent: "lena",
    mode: "plan",
    model: "deepseek-v4-flash",
    sessionId: "telegram-session-1",
    messages: [{ role: "user", content: "hello" }],
  });

  expect(capturedHeaders?.get("x-opencode-session")).toBe("telegram-session-1");
});

test("OpenCode Go uses a stable agent fallback when no session is supplied", async () => {
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedHeaders = new Headers(init.headers);
    return jsonResponse();
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ id: "opencode-go-oai" }));
  await provider.query({
    agent: "lena",
    mode: "plan",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "reflection" }],
  });

  expect(capturedHeaders?.get("x-opencode-session")).toBe("anima:lena");
});

test("OpenCode Go does not emit an empty session header", async () => {
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedHeaders = new Headers(init.headers);
    return jsonResponse();
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ id: "opencode-go-oai" }));
  await provider.query({
    agent: "lena",
    mode: "plan",
    model: "deepseek-v4-flash",
    sessionId: "   ",
    messages: [{ role: "user", content: "reflection" }],
  });

  expect(capturedHeaders?.get("x-opencode-session")).toBe("anima:lena");
});

test("other OpenAI-compatible providers do not receive the OpenCode Go header", async () => {
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedHeaders = new Headers(init.headers);
    return jsonResponse();
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef());
  await provider.query({
    agent: "lena",
    mode: "plan",
    model: "deepseek-v4-flash",
    sessionId: "telegram-session-1",
    messages: [{ role: "user", content: "hello" }],
  });

  expect(capturedHeaders?.get("x-opencode-session")).toBeNull();
});

test("sharedSafe defaults to false when not configured", () => {
  const provider = new OpenAIv1ChatProvider(providerDef());
  expect(provider.sharedSafe).toBe(false);
});

test("sharedSafe is true only when explicitly configured, not implied by protocol compatibility", () => {
  const provider = new OpenAIv1ChatProvider(providerDef({ sharedSafe: true }));
  expect(provider.sharedSafe).toBe(true);
});

// ── stream override + SSE parsing (some providers, e.g. GLM-family gateways,
// reject non-streaming requests with "streaming_required"; the old
// `stream: false` sat AFTER the extraParams spreads so config could never
// turn it on, and query() only ever did response.json() — would break on
// a real SSE body even if stream were enabled.) ────────────────────────────

test("stream defaults to false when no extraParams override it", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse();
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef());
  await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(capturedBody?.stream).toBe(false);
});

test("provider-level extraParams.stream can override the default false", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedBody = JSON.parse(init.body as string);
    return sseResponse(['data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n', "data: [DONE]\n\n"]);
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ extraParams: { stream: true } }));
  await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(capturedBody?.stream).toBe(true);
});

test("model-level extraParams.stream also overrides the default false", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedBody = JSON.parse(init.body as string);
    return sseResponse(['data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n', "data: [DONE]\n\n"]);
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ models: [{ id: "deepseek-v4-flash", extraParams: { stream: true } }] }));
  await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(capturedBody?.stream).toBe(true);
});

test("enabling stream also requests stream_options.include_usage so cost tracking keeps working", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init = {}) => {
    capturedBody = JSON.parse(init.body as string);
    return sseResponse(['data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n', "data: [DONE]\n\n"]);
  }) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ extraParams: { stream: true } }));
  await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(capturedBody?.stream_options).toEqual({ include_usage: true });
});

test("a streamed text response is parsed into the full assembled message", async () => {
  globalThis.fetch = (async (_input?: unknown, _init?: unknown) => sseResponse([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello, "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world."},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ])) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ extraParams: { stream: true } }));
  const result = await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(result.message.content).toBe("Hello, world.");
  expect(result.usage?.input_tokens).toBe(10);
  expect(result.usage?.output_tokens).toBe(3);
});

test("a streamed tool-call response accumulates argument fragments per tool-call index", async () => {
  globalThis.fetch = (async (_input?: unknown, _init?: unknown) => sseResponse([
    'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"comm"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ])) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ extraParams: { stream: true } }));
  const result = await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(result.tool_calls).toHaveLength(1);
  expect(result.tool_calls?.[0].id).toBe("call_1");
  expect(result.tool_calls?.[0].name).toBe("bash");
  expect(result.tool_calls?.[0].arguments).toBe('{"command":"ls"}');
});

test("an SSE event split across two network reads is reassembled correctly", async () => {
  const full = 'data: {"choices":[{"delta":{"role":"assistant","content":"split across chunks"}}]}\n\n';
  const mid = Math.floor(full.length / 2);
  globalThis.fetch = (async (_input?: unknown, _init?: unknown) => sseResponse([full.slice(0, mid), full.slice(mid), "data: [DONE]\n\n"])) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef({ extraParams: { stream: true } }));
  const result = await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(result.message.content).toBe("split across chunks");
});

test("a non-streamed request (default) still parses a plain JSON body unchanged", async () => {
  globalThis.fetch = (async (_input?: unknown, _init?: unknown) => jsonResponse()) as typeof fetch;

  const provider = new OpenAIv1ChatProvider(providerDef());
  const result = await provider.query({ agent: "lena", mode: "plan", model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });

  expect(result.message.content).toBe("ok");
});

function providerDef(overrides: Partial<ProviderDef> = {}): ProviderDef {
  return {
    id: "exampleprov",
    label: "Test provider",
    baseUrl: "https://provider.test/v1",
    api: "openai-completions",
    apiKey: "test-key",
    models: [{ id: "deepseek-v4-flash" }],
    ...overrides,
  };
}

function jsonResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}
