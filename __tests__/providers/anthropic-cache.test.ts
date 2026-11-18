/**
 * AnthropicProvider — cache boundary wiring tests.
 * Verifies that req.cachePrefix is translated into a string[]
 * systemPrompt with SYSTEM_PROMPT_DYNAMIC_BOUNDARY so the SDK
 * can establish the correct cache breakpoint.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";

const BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

let capturedSystemPrompt: string | string[] | undefined;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: BOUNDARY,
  query: (_opts: any) => {
    capturedSystemPrompt = _opts.options?.systemPrompt;
    return (async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: {},
      };
    })();
  },
}));

const { AnthropicProvider } = await import("../../src/providers/anthropic");

function baseReq(overrides = {}) {
  return {
    agent: "test",
    mode: "edit" as const,
    messages: [{ role: "user" as const, content: "hello" }],
    ...overrides,
  };
}

beforeEach(() => {
  capturedSystemPrompt = undefined;
});

describe("AnthropicProvider — cache boundary wiring", () => {
  test("no cachePrefix → systemPrompt is a plain string", async () => {
    const provider = new AnthropicProvider();
    await provider.query(baseReq({ system: "You are Bruno." }));

    expect(typeof capturedSystemPrompt).toBe("string");
    expect(capturedSystemPrompt).toBe("You are Bruno.");
  });

  test("with cachePrefix → systemPrompt is array with BOUNDARY between static and dynamic", async () => {
    const staticPrefix = "## Soul\nI am Bruno.\n";
    const dynamicSuffix = "Date: 2026-06-26";
    const provider = new AnthropicProvider();

    await provider.query(baseReq({
      system: staticPrefix + dynamicSuffix,
      cachePrefix: staticPrefix,
    }));

    expect(Array.isArray(capturedSystemPrompt)).toBe(true);
    const parts = capturedSystemPrompt as string[];
    expect(parts[0]).toBe(staticPrefix);
    expect(parts[1]).toBe(BOUNDARY);
    expect(parts[2]).toBe(dynamicSuffix);
  });

  test("with cachePrefix and no dynamic suffix → array has only static + BOUNDARY", async () => {
    const staticPrefix = "## Soul\nI am Bruno.\n";
    const provider = new AnthropicProvider();

    await provider.query(baseReq({
      system: staticPrefix,
      cachePrefix: staticPrefix,
    }));

    const parts = capturedSystemPrompt as string[];
    expect(parts[0]).toBe(staticPrefix);
    expect(parts[1]).toBe(BOUNDARY);
    expect(parts.length).toBe(2);
  });

  test("with cachePrefix and extra system messages → appended after BOUNDARY", async () => {
    const staticPrefix = "## Soul\nI am Bruno.\n";
    const dynamicSuffix = "Date: 2026-06-26";
    const provider = new AnthropicProvider();

    await provider.query(baseReq({
      system: staticPrefix + dynamicSuffix,
      cachePrefix: staticPrefix,
      messages: [
        { role: "system" as const, content: "extra context" },
        { role: "user" as const, content: "hello" },
      ],
    }));

    const parts = capturedSystemPrompt as string[];
    expect(parts[0]).toBe(staticPrefix);
    expect(parts[1]).toBe(BOUNDARY);
    expect(parts.includes("extra context")).toBe(true);
    const boundaryIdx = parts.indexOf(BOUNDARY);
    const extraIdx = parts.indexOf("extra context");
    expect(extraIdx).toBeGreaterThan(boundaryIdx);
  });
});
