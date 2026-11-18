/**
 * cost-ledger-accuracy: providers tell the ledger which model
 * served a request and how to read the input count. The four public counts keep
 * their meaning. HTTP is mocked; no network, no ~/.anima.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { OpenAIv1ChatProvider } from "../../src/providers/openai-v1-chat";
import { toOpenAIChatResponse } from "../../src/proxy/openai-outbound";
import type { ProviderDef } from "../../src/config/types";
import type { ProviderResponse } from "../../src/providers/interface";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function def(over: Partial<ProviderDef> = {}): ProviderDef {
  return { id: "fixture", label: "Fixture", baseUrl: "http://fixture.invalid/v1", api: "openai-completions", apiKey: "k", models: [{ id: "gpt-x" }], ...over } as ProviderDef;
}

function respondWith(body: unknown, contentType = "application/json") {
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

const req = (over: Record<string, unknown> = {}) => ({ agent: "bruno", mode: "edit" as const, messages: [{ role: "user" as const, content: "hi" }], ...over });

const choice = { choices: [{ message: { role: "assistant", content: "ok" } }] };

describe("OpenAI-compatible chat wire", () => {
  test("a headless shared cache key reaches the wire while ordinary chat keeps its agent key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(choice);
    }) as unknown as typeof fetch;
    const provider = new OpenAIv1ChatProvider(def());
    await provider.query(req({ agent: "finn", promptCacheKey: "headless-shared" }));
    await provider.query(req({ agent: "cleo", promptCacheKey: "headless-shared" }));
    await provider.query(req({ agent: "bruno" }));
    expect(bodies.map((body) => body.prompt_cache_key)).toEqual(["headless-shared", "headless-shared", "bruno"]);
  });

  test("OpenAI fixture: prompt 1000 / cached 800 keeps the public counts and says the input includes the cache", async () => {
    respondWith({ ...choice, model: "gpt-x-2026-10-01", usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } } });
    const out = await new OpenAIv1ChatProvider(def()).query(req()) as ProviderResponse;
    expect(out.usage).toMatchObject({ input_tokens: 1000, output_tokens: 100, cache_read_tokens: 800, model: "gpt-x-2026-10-01", input_includes_cache: true, cache_categories_reported: true });
  });

  test("the proxy still reports prompt_tokens 1000 and total_tokens 1100 for that response", async () => {
    respondWith({ ...choice, model: "gpt-x-2026-10-01", usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } } });
    const out = await new OpenAIv1ChatProvider(def()).query(req()) as ProviderResponse;
    expect((toOpenAIChatResponse(out, "gpt-x") as any).usage).toEqual({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 });
  });

  test("DeepSeek fixture: prompt_cache_hit_tokens is the cache read and the input includes it", async () => {
    respondWith({ ...choice, model: "deepseek-v4-pro", usage: { prompt_tokens: 500, completion_tokens: 50, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 200 } });
    const out = await new OpenAIv1ChatProvider(def()).query(req()) as ProviderResponse;
    expect(out.usage).toMatchObject({ input_tokens: 500, cache_read_tokens: 300, input_includes_cache: true });
  });

  test("a response that does not name its model falls back to the model that was sent", async () => {
    respondWith({ ...choice, usage: { prompt_tokens: 10, completion_tokens: 2 } });
    const out = await new OpenAIv1ChatProvider(def({ models: [{ id: "gpt-x" }, { id: "gpt-y" }] })).query(req({ model: "gpt-y" })) as ProviderResponse;
    expect(out.usage?.model).toBe("gpt-y");
  });

  test("a response with no model and no requested model reports the provider's default model", async () => {
    respondWith({ ...choice, usage: { prompt_tokens: 10, completion_tokens: 2 } });
    const out = await new OpenAIv1ChatProvider(def()).query(req()) as ProviderResponse;
    expect(out.usage?.model).toBe("gpt-x");
  });

  test("a streamed response keeps the served model and DeepSeek's cache hits", async () => {
    const sse = [
      `data: ${JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { role: "assistant", content: "o" } }] })}`,
      `data: ${JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: "k" } }], usage: { prompt_tokens: 400, completion_tokens: 20, prompt_cache_hit_tokens: 250 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    respondWith(sse, "text/event-stream");
    const out = await new OpenAIv1ChatProvider(def({ extraParams: { stream: true } })).query(req()) as ProviderResponse;
    expect(out.message.content).toBe("ok");
    expect(out.usage).toMatchObject({ input_tokens: 400, output_tokens: 20, cache_read_tokens: 250, model: "deepseek-v4-flash", input_includes_cache: true });
  });

  test("no usage object means no usage metadata", async () => {
    respondWith(choice);
    const out = await new OpenAIv1ChatProvider(def()).query(req()) as ProviderResponse;
    expect(out.usage).toBeUndefined();
  });
});

describe("anthropic-messages wire", () => {
  const anthropicDef = () => def({ api: "anthropic-messages", models: [{ id: "MiniMax-M3" }] });

  test("input excludes the cache categories and the served model is reported", async () => {
    respondWith({ model: "MiniMax-M3-0924", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } });
    const out = await new OpenAIv1ChatProvider(anthropicDef()).query(req()) as ProviderResponse;
    expect(out.usage).toMatchObject({ input_tokens: 200, output_tokens: 30, cache_read_tokens: 800, cache_write_tokens: 0, model: "MiniMax-M3-0924", input_includes_cache: false, cache_categories_reported: true });
  });

  test("without a model in the response the sent model is used", async () => {
    respondWith({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const out = await new OpenAIv1ChatProvider(anthropicDef()).query(req()) as ProviderResponse;
    expect(out.usage?.model).toBe("MiniMax-M3");
  });
});
