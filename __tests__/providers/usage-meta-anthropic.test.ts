/**
 * cost-ledger-accuracy: the Claude SDK provider reports one
 * usage entry per model. The SDK is mocked; nothing runs.
 */

import { test, expect, describe, mock } from "bun:test";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
  query: () => (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
    yield {
      type: "result",
      subtype: "success",
      result: "ok",
      usage: { input_tokens: 30, output_tokens: 12 },
      modelUsage: {
        "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 4 },
        "claude-haiku-4-5": { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 },
      },
    };
  })(),
}));

const { AnthropicProvider } = await import("../../src/providers/anthropic");

describe("AnthropicProvider usage metadata", () => {
  test("one entry per model, the aggregate unchanged, input excludes the cache", async () => {
    const provider = new AnthropicProvider({ log: () => {} });
    const out = await provider.query({ agent: "bruno", mode: "edit", messages: [{ role: "user", content: "hi" }] });
    expect(out.usage).toMatchObject({
      input_tokens: 30,
      output_tokens: 12,
      cache_read_tokens: 150,
      cache_write_tokens: 4,
      input_includes_cache: false,
      cache_categories_reported: true,
    });
    expect(out.usage?.models).toEqual([
      { model: "claude-sonnet-4-6", input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 4 },
      { model: "claude-haiku-4-5", input_tokens: 20, output_tokens: 7, cache_read_tokens: 50, cache_write_tokens: 0 },
    ]);
  });
});
