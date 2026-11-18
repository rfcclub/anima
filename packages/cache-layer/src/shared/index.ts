import type { NormalizedUsage, UsageFormat } from "../types.js";

export function normalizeUsage(
  raw: Record<string, unknown> | null | undefined,
  format: UsageFormat
): NormalizedUsage | undefined {
  if (raw == null) return undefined;

  if (format === "anthropic") {
    return {
      cache_read_tokens: raw["cache_read_input_tokens"] as number | undefined,
      cache_write_tokens: raw["cache_creation_input_tokens"] as number | undefined,
    };
  }

  if (format === "openai") {
    const details = raw["prompt_tokens_details"] as Record<string, unknown> | undefined;
    const cached = details?.["cached_tokens"];
    return {
      cache_read_tokens: typeof cached === "number" ? cached : undefined,
      cache_write_tokens: undefined,
    };
  }

  if (format === "deepseek") {
    return {
      cache_read_tokens: raw["prompt_cache_hit_tokens"] as number | undefined,
      cache_write_tokens: raw["prompt_cache_miss_tokens"] as number | undefined,
    };
  }

  return { cache_read_tokens: undefined, cache_write_tokens: undefined };
}
