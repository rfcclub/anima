import { describe, expect, test } from "bun:test";
import { buildCacheKeyHeader } from "../src/openai/index.ts";

describe("buildCacheKeyHeader", () => {
  test("SC-015: returns { prompt_cache_key: agentId } for non-empty agentId", () => {
    expect(buildCacheKeyHeader("bruno")).toEqual({ prompt_cache_key: "bruno" });
  });

  test("SC-016: returns {} when agentId is undefined", () => {
    expect(buildCacheKeyHeader(undefined)).toEqual({});
  });

  test("SC-017: returns {} when agentId is empty string", () => {
    expect(buildCacheKeyHeader("")).toEqual({});
  });

  test("SC-018: merging result does not mutate original headers", () => {
    const original = { Authorization: "Bearer tok" };
    const result = buildCacheKeyHeader("bruno");
    const merged = { ...original, ...result };
    expect(merged).toEqual({ Authorization: "Bearer tok", prompt_cache_key: "bruno" });
    expect(original).toEqual({ Authorization: "Bearer tok" });
  });

  test("SC-019: spreading undefined result adds no extra keys", () => {
    const original = { Authorization: "Bearer tok" };
    const merged = { ...original, ...buildCacheKeyHeader(undefined) };
    expect(Object.keys(merged)).toEqual(["Authorization"]);
  });
});
