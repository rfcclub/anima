import { afterEach, expect, test } from "bun:test";
import type { ProviderDef } from "../src/config/types";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import { ProviderError } from "../src/providers/interface";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("query posts ProviderRequest as OpenAI chat completions", async () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = mockFetch(calls, jsonResponse({ choices: [{ message: { role: "assistant", content: "hello" } }] }));
  const provider = new OpenAICompatProvider(providerDef());

  const result = await provider.query({
    agent: "eli",
    mode: "edit",
    model: "glm-5.1",
    messages: [{ role: "user", content: "hi" }],
  });

  expect(result.message.content).toBe("hello");
  expect(calls[0].url).toBe("https://provider.example/v1/chat/completions");
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].headers.Authorization).toBe("Bearer exampleprov_test_key");
  expect(calls[0].body.model).toBe("glm-5.1");
  expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
});

test("query merges provider and model extraParams into the request body", async () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = mockFetch(calls, jsonResponse({ choices: [{ message: { role: "assistant", content: "merged" } }] }));
  const provider = new OpenAICompatProvider(providerDef({
    extraParams: { kwerk_reasoning: true, temperature: 0.4 },
    models: [{ id: "glm-5.1", extraParams: { thinking: "enabled", temperature: 0.2 } }],
  }));

  await provider.query({
    agent: "eli",
    mode: "edit",
    model: "glm-5.1",
    messages: [{ role: "user", content: "hi" }],
  });

  expect(calls[0].body.kwerk_reasoning).toBe(true);
  expect(calls[0].body.thinking).toBe("enabled");
  expect(calls[0].body.temperature).toBe(0.2);
});

test("query supports custom endpoint, headers, and AbortSignal", async () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = mockFetch(calls, jsonResponse({ choices: [{ message: { role: "assistant", content: "custom" } }] }));
  const signal = new AbortController().signal;
  const provider = new OpenAICompatProvider(providerDef({
    endpoint: "/v1/responses",
    headers: { "X-Custom": "value" },
  }));

  await provider.query({
    agent: "eli",
    mode: "edit",
    model: "glm-5.1",
    messages: [{ role: "user", content: "hi" }],
    signal,
  });

  expect(calls[0].url).toBe("https://provider.example/v1/v1/responses");
  expect(calls[0].headers["X-Custom"]).toBe("value");
  // The fetch receives a composed AbortSignal (caller signal + internal 30s timeout).
  // Verify it is a live, non-aborted AbortSignal.
  const passedSignal = calls[0].init.signal as AbortSignal;
  expect(passedSignal).toBeInstanceOf(AbortSignal);
  expect(passedSignal.aborted).toBe(false);
});

test("query maps HTTP status errors to ProviderError codes", async () => {
  for (const [status, code] of [[429, "RATE_LIMITED"], [401, "AUTH_ERROR"], [403, "AUTH_ERROR"], [500, "SERVER_ERROR"]] as const) {
    globalThis.fetch = mockFetch([], new Response("nope", { status }));
    const provider = new OpenAICompatProvider(providerDef());

    await expect(provider.query({
      agent: "eli",
      mode: "edit",
      model: "glm-5.1",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toMatchObject(new ProviderError(code, "exampleprov", "nope"));
  }
});

interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function providerDef(overrides: Partial<ProviderDef> = {}): ProviderDef {
  return {
    id: "exampleprov",
    label: "Nahcrof",
    baseUrl: "https://provider.example/v1",
    api: "openai-completions",
    apiKey: "exampleprov_test_key",
    models: [{ id: "glm-5.1" }],
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(calls: FetchCall[], response: Response): typeof fetch {
  return (async (url, init = {}) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url: String(url),
      init,
      headers,
      body: JSON.parse(String(init.body)),
    });
    return response;
  }) as typeof fetch;
}
