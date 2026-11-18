/**
 * cost-ledger-accuracy, CL-9 at the wire boundary: a count the provider did not send is unknown,
 * never a measured zero. Real parser into the real meter and ledger; HTTP is mocked, no ~/.anima.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { OpenAIv1ChatProvider } from "../../src/providers/openai-v1-chat";
import { TokenLedger } from "../../src/cost/ledger";
import { meterProvider } from "../../src/cost/meter";
import type { ProviderDef } from "../../src/config/types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const def = (over: Partial<ProviderDef> = {}): ProviderDef =>
  ({ id: "fixture", label: "Fixture", baseUrl: "http://fixture.invalid/v1", api: "openai-completions", apiKey: "k", models: [{ id: "gpt-x" }], ...over }) as ProviderDef;

function respondWith(body: unknown, contentType = "application/json") {
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

const req = () => ({ agent: "bruno", sessionId: "s1", mode: "edit" as const, messages: [{ role: "user" as const, content: "hi" }] });

async function metered(provider: OpenAIv1ChatProvider) {
  const db = new Database(":memory:");
  const ledger = new TokenLedger(db);
  const out = await meterProvider(provider, { ledger, onError: (e) => { throw e; } }).query(req()) as { usage?: Record<string, unknown> };
  const call = db.query("SELECT coverage FROM provider_calls").get() as { coverage: string };
  const detail = db.query("SELECT input_tokens, output_tokens FROM token_usage").get() as { input_tokens: number | null; output_tokens: number | null };
  return { out, call, detail };
}

const choice = { choices: [{ message: { role: "assistant", content: "ok" } }] };

describe("OpenAI-compatible wire", () => {
  test("a missing completion count is NULL and the call is partial, not a measured zero", async () => {
    respondWith({ ...choice, usage: { prompt_tokens: 100 } });
    const { call, detail } = await metered(new OpenAIv1ChatProvider(def()));
    expect(detail).toEqual({ input_tokens: 100, output_tokens: null });
    expect(call.coverage).toBe("partial");
  });

  test("an empty usage object is unknown, not a free call", async () => {
    respondWith({ ...choice, usage: {} });
    const { call, detail } = await metered(new OpenAIv1ChatProvider(def()));
    expect(detail).toEqual({ input_tokens: null, output_tokens: null });
    expect(call.coverage).toBe("unknown");
  });

  test("explicit zeros stay zero and the call is complete", async () => {
    respondWith({ ...choice, usage: { prompt_tokens: 0, completion_tokens: 0 } });
    const { call, detail } = await metered(new OpenAIv1ChatProvider(def()));
    expect(detail).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(call.coverage).toBe("complete");
  });

  test("the public counts keep their meaning: an absent count is still 0 for callers", async () => {
    respondWith({ ...choice, usage: { prompt_tokens: 100 } });
    const { out } = await metered(new OpenAIv1ChatProvider(def()));
    expect(out.usage).toMatchObject({ input_tokens: 100, output_tokens: 0 });
  });

  test("a streamed response whose usage chunk omits the completion count is partial", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "ok" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 40 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    respondWith(sse, "text/event-stream");
    const { call, detail } = await metered(new OpenAIv1ChatProvider(def({ extraParams: { stream: true } })));
    expect(detail).toEqual({ input_tokens: 40, output_tokens: null });
    expect(call.coverage).toBe("partial");
  });
});

describe("Anthropic-compatible wire", () => {
  const anthropicDef = () => def({ api: "anthropic-messages", models: [{ id: "MiniMax-M3" }] });

  test("a missing output count is NULL and the call is partial", async () => {
    respondWith({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 7 } });
    const { call, detail } = await metered(new OpenAIv1ChatProvider(anthropicDef()));
    expect(detail).toEqual({ input_tokens: 7, output_tokens: null });
    expect(call.coverage).toBe("partial");
  });

  test("an empty usage object is unknown", async () => {
    respondWith({ content: [{ type: "text", text: "ok" }], usage: {} });
    const { call, detail } = await metered(new OpenAIv1ChatProvider(anthropicDef()));
    expect(detail).toEqual({ input_tokens: null, output_tokens: null });
    expect(call.coverage).toBe("unknown");
  });

  test("explicit zeros stay zero and complete", async () => {
    respondWith({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, output_tokens: 0 } });
    const { call, detail } = await metered(new OpenAIv1ChatProvider(anthropicDef()));
    expect(detail).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(call.coverage).toBe("complete");
  });
});
