import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "../src/shared/index.ts";

describe("normalizeUsage — anthropic", () => {
  test("SC-020: maps cache_read_input_tokens to cache_read_tokens", () => {
    const result = normalizeUsage({ cache_read_input_tokens: 100 }, "anthropic");
    expect(result?.cache_read_tokens).toBe(100);
  });

  test("SC-021: maps cache_creation_input_tokens to cache_write_tokens", () => {
    const result = normalizeUsage({ cache_creation_input_tokens: 200 }, "anthropic");
    expect(result?.cache_write_tokens).toBe(200);
  });

  test("SC-022: maps both cache fields when both present", () => {
    const result = normalizeUsage(
      { cache_read_input_tokens: 50, cache_creation_input_tokens: 80 },
      "anthropic"
    );
    expect(result).toEqual({ cache_read_tokens: 50, cache_write_tokens: 80 });
  });

  test("SC-023: returns undefined,undefined when no cache fields", () => {
    const result = normalizeUsage({ input_tokens: 10, output_tokens: 5 }, "anthropic");
    expect(result).toEqual({ cache_read_tokens: undefined, cache_write_tokens: undefined });
  });
});

describe("normalizeUsage — openai", () => {
  test("SC-024: maps prompt_tokens_details.cached_tokens to cache_read_tokens", () => {
    const result = normalizeUsage(
      { prompt_tokens_details: { cached_tokens: 42 } },
      "openai"
    );
    expect(result?.cache_read_tokens).toBe(42);
    expect(result?.cache_write_tokens).toBeUndefined();
  });

  test("SC-025: returns undefined when prompt_tokens_details absent", () => {
    const result = normalizeUsage({ prompt_tokens: 10 }, "openai");
    expect(result?.cache_read_tokens).toBeUndefined();
  });

  test("SC-026: cached_tokens=0 returns 0, not undefined", () => {
    const result = normalizeUsage(
      { prompt_tokens_details: { cached_tokens: 0 } },
      "openai"
    );
    expect(result?.cache_read_tokens).toBe(0);
  });
});

describe("normalizeUsage — deepseek", () => {
  test("SC-027: maps prompt_cache_hit_tokens to cache_read_tokens", () => {
    const result = normalizeUsage({ prompt_cache_hit_tokens: 77 }, "deepseek");
    expect(result?.cache_read_tokens).toBe(77);
  });

  test("SC-028: maps prompt_cache_miss_tokens to cache_write_tokens", () => {
    const result = normalizeUsage(
      { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90 },
      "deepseek"
    );
    expect(result?.cache_write_tokens).toBe(90);
  });

  test("SC-029: returns undefined,undefined when no cache fields", () => {
    const result = normalizeUsage({ prompt_tokens: 5 }, "deepseek");
    expect(result).toEqual({ cache_read_tokens: undefined, cache_write_tokens: undefined });
  });
});

describe("normalizeUsage — edge cases", () => {
  test("SC-030: undefined raw returns undefined", () => {
    expect(normalizeUsage(undefined, "anthropic")).toBeUndefined();
  });

  test("SC-031: null raw returns undefined", () => {
    expect(normalizeUsage(null, "openai")).toBeUndefined();
  });

  test("SC-032: unknown format returns undefined,undefined", () => {
    const result = normalizeUsage({ cache_read_input_tokens: 10 }, "unknown-provider" as any);
    expect(result).toEqual({ cache_read_tokens: undefined, cache_write_tokens: undefined });
  });
});
