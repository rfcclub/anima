import { test, expect, mock, beforeEach } from "bun:test";
import type { ProviderRequest, ProviderMessage } from "../src/providers/interface";
import { ProviderError } from "../src/providers/interface";

function successResult(result: string) {
  return { type: "result", subtype: "success", result, usage: { input_tokens: 1, output_tokens: 1 } };
}

// _sdkQuery is the mock function that the SDK's query() resolves to
let _sdkQuery = (...args: any[]) => makeStream([successResult("done")]);

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: any[]) => _sdkQuery(...args),
}));

import { AnthropicProvider } from "../src/providers/anthropic";

beforeEach(() => {
  _sdkQuery = (...args: any[]) => makeStream([successResult("done")]);
});

function makeStream(chunks: Array<Record<string, unknown>>) {
  let index = 0;
  let closed = false;
  return {
    [Symbol.asyncIterator]() {
      index = 0;
      return {
        async next() {
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
    close() { closed = true; },
    _closed: () => closed,
  };
}

function buildRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  const messages: ProviderMessage[] = [{ role: "user", content: "Hello" }];
  return { messages, agent: "bruno", mode: "plan", ...overrides };
}

const noopLog = () => {};

test("name is claude", () => {
  const provider = new AnthropicProvider();
  expect(provider.name).toBe("claude");
});

test("query returns assistant message from result", async () => {
  _sdkQuery = (...args: any[]) => makeStream([
    { type: "result", subtype: "success", result: "I can help.", usage: { input_tokens: 10, output_tokens: 20 } },
  ]);

  const provider = new AnthropicProvider({ log: noopLog });
  const response = await provider.query(buildRequest());

  expect(response.message.role).toBe("assistant");
  expect(response.message.content).toBe("I can help.");
  expect(response.usage?.input_tokens).toBe(10);
  expect(response.usage?.output_tokens).toBe(20);
});

test("query returns assistant message from assistant chunk when result has no text", async () => {
  _sdkQuery = (...args: any[]) => makeStream([
    { type: "assistant", message: { content: [{ type: "text", text: "Partial response" }] } },
    { type: "result", subtype: "success", result: "", usage: { input_tokens: 5, output_tokens: 3 } },
  ]);

  const provider = new AnthropicProvider({ log: noopLog });
  const response = await provider.query(buildRequest());

  expect(response.message.content).toBe("Partial response");
});

test("query extracts Claude tool_use blocks into provider tool calls", async () => {
  _sdkQuery = (...args: any[]) => makeStream([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll read that." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "note.txt" } },
        ],
      },
    },
    { type: "result", subtype: "success", result: "", usage: { input_tokens: 5, output_tokens: 3 } },
  ]);

  const provider = new AnthropicProvider({ log: noopLog });
  const response = await provider.query(buildRequest());

  expect(response.message.content).toBe("I'll read that.");
  expect(response.tool_calls).toEqual([
    { id: "toolu_1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) },
  ]);
});

test("query throws ProviderError on result failure", async () => {
  _sdkQuery = (...args: any[]) => makeStream([
    { type: "result", subtype: "error_max_turns", errors: ["Max turns exceeded"], result: "" },
  ]);

  const provider = new AnthropicProvider({ log: noopLog });
  await expect(provider.query(buildRequest())).rejects.toBeInstanceOf(ProviderError);
});

test("query maps 401 error to AUTH_ERROR", async () => {
  const err = new Error("Invalid API key");
  (err as any).status = 401;
  _sdkQuery = (...args: any[]) => { throw err; };

  const provider = new AnthropicProvider({ log: noopLog });
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("AUTH_ERROR");
    expect((err as ProviderError).retryable).toBe(false);
  }
});

test("query maps 429 rate limit to RATE_LIMITED", async () => {
  const err = new Error("Rate limit exceeded");
  (err as any).status = 429;
  _sdkQuery = (...args: any[]) => { throw err; };

  const provider = new AnthropicProvider({ log: noopLog });
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect((err as ProviderError).code).toBe("RATE_LIMITED");
    expect((err as ProviderError).retryable).toBe(true);
  }
});

test("query maps 429 quota message to QUOTA_EXHAUSTED", async () => {
  const err = new Error("Your credit balance is too low");
  (err as any).status = 429;
  _sdkQuery = (...args: any[]) => { throw err; };

  const provider = new AnthropicProvider({ log: noopLog });
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect((err as ProviderError).code).toBe("QUOTA_EXHAUSTED");
    expect((err as ProviderError).retryable).toBe(true);
  }
});

test("query maps timeout message to TIMEOUT", async () => {
  _sdkQuery = (...args: any[]) => { throw new Error("Request timed out after 30s"); };

  const provider = new AnthropicProvider({ log: noopLog });
  try {
    await provider.query(buildRequest());
    expect.unreachable("should have thrown");
  } catch (err) {
    expect((err as ProviderError).code).toBe("TIMEOUT");
  }
});

test("query uses correct permission mode for auto", async () => {
  let capturedOpts: any = null;
  _sdkQuery = (...args: any[]) => {
    capturedOpts = args[0];
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({ mode: "auto" }));

  expect(capturedOpts.options.permissionMode).toBe("auto");
  expect(capturedOpts.options.allowedTools).toBeUndefined();
});

test("query sets allowedTools empty for plan mode", async () => {
  let capturedOpts: any = null;
  _sdkQuery = (...args: any[]) => {
    capturedOpts = args[0];
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({ mode: "plan" }));

  expect(capturedOpts.options.allowedTools).toEqual([]);
});

test("query passes system prompt", async () => {
  let capturedOpts: any = null;
  _sdkQuery = (...args: any[]) => {
    capturedOpts = args[0];
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({ system: "You are helpful." }));

  expect(capturedOpts.options.systemPrompt).toBe("You are helpful.");
});

test("query passes model override", async () => {
  let capturedOpts: any = null;
  _sdkQuery = (...args: any[]) => {
    capturedOpts = args[0];
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({ model: "claude-sonnet-4-6" }));

  expect(capturedOpts.options.model).toBe("claude-sonnet-4-6");
});

test("query passes provider tools to Claude options", async () => {
  let capturedOpts: any = null;
  _sdkQuery = (...args: any[]) => {
    capturedOpts = args[0];
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({
    tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
  }));

  expect(capturedOpts.options.tools).toEqual(["read_file"]);
});

test("query merges system messages into systemPrompt instead of dropping them", async () => {
  let capturedPrompt = "";
  let capturedSystemPrompt = "";
  _sdkQuery = (...args: any[]) => {
    capturedPrompt = args[0].prompt;
    capturedSystemPrompt = args[0].options.systemPrompt;
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  const messages: ProviderMessage[] = [
    { role: "system", content: "Mail context: agent cleo says hello" },
    { role: "system", content: "Session baseline: previous discussion about Phase 1" },
    { role: "user", content: "User message" },
  ];
  await provider.query(buildRequest({ system: "You are Bruno.", messages }));

  // System messages should NOT appear in conversation prompt
  expect(capturedPrompt).not.toContain("Mail context");
  expect(capturedPrompt).not.toContain("Session baseline");
  expect(capturedPrompt).toContain("User message");

  // System messages should be merged into systemPrompt after the identity
  expect(capturedSystemPrompt).toContain("You are Bruno.");
  expect(capturedSystemPrompt).toContain("Mail context: agent cleo says hello");
  expect(capturedSystemPrompt).toContain("Session baseline: previous discussion about Phase 1");
});

test("query handles system messages without explicit system prompt", async () => {
  let capturedSystemPrompt = "";
  _sdkQuery = (...args: any[]) => {
    capturedSystemPrompt = args[0].options.systemPrompt;
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  const messages: ProviderMessage[] = [
    { role: "system", content: "Context only" },
    { role: "user", content: "Hi" },
  ];
  await provider.query(buildRequest({ messages }));

  expect(capturedSystemPrompt).toBe("Context only");
});

test("canUseTool allow path", async () => {
  let canUseToolFn: any = null;
  _sdkQuery = (...args: any[]) => {
    canUseToolFn = args[0].options.canUseTool;
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({ canUseTool: async () => ({ allow: true }) }));

  const decision = await canUseToolFn!("read", { path: "/tmp" });
  expect(decision.behavior).toBe("allow");
});

test("canUseTool deny path", async () => {
  let canUseToolFn: any = null;
  _sdkQuery = (...args: any[]) => {
    canUseToolFn = args[0].options.canUseTool;
    return makeStream([successResult("done")]);
  };

  const provider = new AnthropicProvider({ log: noopLog });
  await provider.query(buildRequest({
    canUseTool: async () => ({ allow: false, message: "Blocked" }),
  }));

  const decision = await canUseToolFn!("bash", { command: "rm -rf /" });
  expect(decision.behavior).toBe("deny");
  expect(decision.message).toBe("Blocked");
});
