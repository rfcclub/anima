import { describe, expect, test } from "bun:test";
import { buildSystemPromptBlocks, injectMessageCacheControl, injectToolCacheControl } from "../src/anthropic/index.ts";

describe("buildSystemPromptBlocks", () => {
  test("SC-001: splits into [cached-static, dynamic] when cachePrefix is a prefix", () => {
    const system = "STATIC PART\nDYNAMIC PART";
    const cachePrefix = "STATIC PART\n";
    const result = buildSystemPromptBlocks(system, cachePrefix);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "STATIC PART\n", cache_control: { type: "ephemeral" } });
    expect(result[1]).toEqual({ type: "text", text: "DYNAMIC PART" });
  });

  test("SC-002: returns single cached block when cachePrefix equals full system", () => {
    const system = "FULL SYSTEM";
    const result = buildSystemPromptBlocks(system, system);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "FULL SYSTEM", cache_control: { type: "ephemeral" } });
  });

  test("SC-003: returns single plain block when cachePrefix is undefined", () => {
    const result = buildSystemPromptBlocks("MY SYSTEM", undefined);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "MY SYSTEM" });
    expect((result[0] as any).cache_control).toBeUndefined();
  });

  test("SC-004: returns empty array for empty system", () => {
    const result = buildSystemPromptBlocks("", undefined);
    expect(result).toHaveLength(0);
  });
});

describe("injectMessageCacheControl", () => {
  test("SC-005: wraps string content in text block with cache_control", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = injectMessageCacheControl(messages, { enabled: true });
    expect(result[0]!.content).toEqual([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
  });

  test("SC-006: skips tool messages and tags last non-tool message", () => {
    const messages = [
      { role: "user", content: "query" },
      { role: "assistant", content: "thinking", tool_calls: [{}] },
      { role: "tool", content: "result", tool_call_id: "t1" },
    ];
    const result = injectMessageCacheControl(messages, { enabled: true });
    const assistant = result[1]!;
    const content = assistant.content as Array<{ type: string; cache_control?: unknown }>;
    expect(content.some((b) => b.cache_control != null)).toBe(true);
    expect((result[2]! as any).content).toBe("result");
  });

  test("SC-007: adds cache_control to last text block in existing ContentBlock array", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ];
    const result = injectMessageCacheControl(messages, { enabled: true });
    const content = result[0]!.content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(content[0]!.cache_control).toBeUndefined();
    expect(content[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("SC-008: returns input reference unchanged when enabled is false", () => {
    const messages = [{ role: "user", content: "hi" }];
    const result = injectMessageCacheControl(messages, { enabled: false });
    expect(result).toBe(messages);
  });

  test("SC-009: returns empty array for empty messages", () => {
    const result = injectMessageCacheControl([], { enabled: true });
    expect(result).toHaveLength(0);
  });

  test("SC-010: idempotent — second call does not double-tag", () => {
    const messages = [{ role: "user", content: "hello" }];
    const once = injectMessageCacheControl(messages, { enabled: true });
    const twice = injectMessageCacheControl(once, { enabled: true });
    expect(twice[0]!.content).toEqual(once[0]!.content);
  });
});

describe("injectToolCacheControl", () => {
  test("SC-011: adds cache_control to single tool", () => {
    const tools = [{ name: "my_tool", input_schema: {} }];
    const result = injectToolCacheControl(tools, { enabled: true });
    expect(result[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("SC-012: tags only the last tool when multiple tools present", () => {
    const tools = [
      { name: "tool_a", input_schema: {} },
      { name: "tool_b", input_schema: {} },
      { name: "tool_c", input_schema: {} },
    ];
    const result = injectToolCacheControl(tools, { enabled: true });
    expect(result[0]!.cache_control).toBeUndefined();
    expect(result[1]!.cache_control).toBeUndefined();
    expect(result[2]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("SC-013: returns input reference unchanged when enabled is false", () => {
    const tools = [{ name: "tool_a", input_schema: {} }];
    const result = injectToolCacheControl(tools, { enabled: false });
    expect(result).toBe(tools);
  });

  test("SC-014: returns empty array for empty tools", () => {
    const result = injectToolCacheControl([], { enabled: true });
    expect(result).toHaveLength(0);
  });
});
