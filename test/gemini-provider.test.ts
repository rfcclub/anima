import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { ProviderRequest, ProviderMessage } from "../src/providers/interface";
import { ProviderError } from "../src/providers/interface";

function buildRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  const messages: ProviderMessage[] = [{ role: "user", content: "Hello" }];
  return { messages, agent: "test-agent", mode: "plan", ...overrides };
}

let _fetchImpl: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

const originalFetch = globalThis.fetch;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  _fetchImpl = null;
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    if (_fetchImpl) return _fetchImpl(url, init);
    // Default: success response
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GEMINI_API_KEY;
});

import { GeminiProvider } from "../src/providers/gemini";

test("name is gemini", () => {
  const provider = new GeminiProvider("test-key");
  expect(provider.name).toBe("gemini");
});

test("throws when no API key provided and none in env", () => {
  delete process.env.GEMINI_API_KEY;
  expect(() => new GeminiProvider()).toThrow("GEMINI_API_KEY not set");
});

test("uses API key from constructor", async () => {
  let capturedHeaders: Record<string, string> = {};
  _fetchImpl = async (url, init) => {
    capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello from Gemini" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const provider = new GeminiProvider("custom-key");
  const response = await provider.query(buildRequest());

  expect(response.message.content).toBe("Hello from Gemini");
  expect(response.usage?.input_tokens).toBe(10);
  expect(response.usage?.output_tokens).toBe(5);
  expect(capturedHeaders["authorization"]).toBe("Bearer custom-key");
});

test("query returns assistant message", async () => {
  _fetchImpl = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "I am Gemini, how can I help?" } }],
    usage: { prompt_tokens: 8, completion_tokens: 12 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const provider = new GeminiProvider();
  const response = await provider.query(buildRequest());

  expect(response.message.role).toBe("assistant");
  expect(response.message.content).toBe("I am Gemini, how can I help?");
  expect(response.usage?.input_tokens).toBe(8);
  expect(response.usage?.output_tokens).toBe(12);
});

test("query handles missing usage metadata", async () => {
  _fetchImpl = async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "OK" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const provider = new GeminiProvider();
  const response = await provider.query(buildRequest());

  expect(response.usage).toBeUndefined();
});

test("query passes system instruction", async () => {
  let capturedBody: any = null;
  _fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const provider = new GeminiProvider();
  await provider.query(buildRequest({ system: "You are a code reviewer." }));

  expect(capturedBody.messages[0].role).toBe("system");
  expect(capturedBody.messages[0].content).toBe("You are a code reviewer.");
});

test("query separates conversation history and last message", async () => {
  let capturedBody: any = null;
  _fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Response" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const provider = new GeminiProvider();
  const messages: ProviderMessage[] = [
    { role: "user", content: "First message" },
    { role: "assistant", content: "First response" },
    { role: "user", content: "Second message" },
  ];
  await provider.query(buildRequest({ messages }));

  // 3 messages in body (no system unless explicitly set)
  expect(capturedBody.messages.length).toBe(3);
  expect(capturedBody.messages[0].role).toBe("user");
  expect(capturedBody.messages[0].content).toBe("First message");
  expect(capturedBody.messages[1].role).toBe("assistant");
  expect(capturedBody.messages[1].content).toBe("First response");
  expect(capturedBody.messages[2].role).toBe("user");
  expect(capturedBody.messages[2].content).toBe("Second message");
});

test("query skips system messages in conversation history", async () => {
  let capturedBody: any = null;
  _fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const provider = new GeminiProvider();
  const messages: ProviderMessage[] = [
    { role: "system", content: "System prompt" },
    { role: "user", content: "User query" },
  ];
  await provider.query(buildRequest({ messages }));

  // System prompt from `system` field + user message (system in messages is merged)
  const roles = capturedBody.messages.map((m: any) => m.role);
  expect(roles).toContain("system");
  expect(roles).toContain("user");
});

test("query uses default model", async () => {
  let capturedBody: any = null;
  _fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const provider = new GeminiProvider();
  await provider.query(buildRequest());

  expect(capturedBody.model).toBe("gemini-2.0-flash");
});

test("query uses specified model", async () => {
  let capturedBody: any = null;
  _fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const provider = new GeminiProvider();
  await provider.query(buildRequest({ model: "gemini-2.5-pro" }));

  expect(capturedBody.model).toBe("gemini-2.5-pro");
});

test("maps 401 to AUTH_ERROR", async () => {
  _fetchImpl = async () => new Response("Unauthorized", { status: 401 });

  const provider = new GeminiProvider();
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("AUTH_ERROR");
    expect((err as ProviderError).retryable).toBe(false);
  }
});

test("maps 429 to RATE_LIMITED", async () => {
  _fetchImpl = async () => new Response("Rate limited", { status: 429 });

  const provider = new GeminiProvider();
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("RATE_LIMITED");
    expect((err as ProviderError).retryable).toBe(true);
  }
});

test("maps 503 to SERVER_ERROR", async () => {
  _fetchImpl = async () => new Response("Unavailable", { status: 503 });

  const provider = new GeminiProvider();
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("SERVER_ERROR");
    expect((err as ProviderError).retryable).toBe(true);
  }
});

test("network error maps to SERVER_ERROR", async () => {
  _fetchImpl = async () => { throw new Error("Connection refused"); };

  const provider = new GeminiProvider();
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("SERVER_ERROR");
  }
});
