/**
 * cost-ledger-accuracy: ledger-boundary usage normalisation.
 */

import { test, expect, describe } from "bun:test";
import { normalizeUsage } from "../../src/cost/usage";

describe("normalizeUsage", () => {
  test("input that includes the cache is stored as uncached input (prompt 1000, cached 800, output 100)", () => {
    const n = normalizeUsage(
      { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 800 },
      { inputIncludesCache: true, cacheCategoriesReported: true },
    );
    expect(n).toEqual({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0, coverage: "complete" });
  });

  test("input that already excludes the cache is not subtracted twice", () => {
    const n = normalizeUsage(
      { input_tokens: 200, output_tokens: 100, cache_read_tokens: 800 },
      { inputIncludesCache: false, cacheCategoriesReported: true },
    );
    expect(n).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, coverage: "complete" });
  });

  test("cache-read above the stated prompt makes the input unknown and the coverage partial, never negative", () => {
    const n = normalizeUsage(
      { input_tokens: 100, output_tokens: 10, cache_read_tokens: 800 },
      { inputIncludesCache: true, cacheCategoriesReported: true },
    );
    expect(n.inputTokens).toBeNull();
    expect(n.cacheReadTokens).toBe(800);
    expect(n.coverage).toBe("partial");
  });

  test("includes-cache with no cache-read reported keeps the input but is partial", () => {
    const n = normalizeUsage({ input_tokens: 500, output_tokens: 10 }, { inputIncludesCache: true });
    expect(n).toEqual({ inputTokens: 500, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, coverage: "partial" });
  });

  test("no usage at all is unknown with every count NULL", () => {
    expect(normalizeUsage(undefined, {})).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, coverage: "unknown" });
  });

  test("a measured zero stays 0", () => {
    const n = normalizeUsage({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, { cacheCategoriesReported: true });
    expect(n).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, coverage: "complete" });
  });

  test("cache categories the leaf does not report stay NULL unless it states they are reported", () => {
    const unreported = normalizeUsage({ input_tokens: 10, output_tokens: 5 }, {});
    expect(unreported).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: null, coverage: "partial" });
    const reported = normalizeUsage({ input_tokens: 10, output_tokens: 5 }, { cacheCategoriesReported: true });
    expect(reported).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, coverage: "complete" });
  });

  test("negative, NaN and non-numeric counts are unknown, not zero", () => {
    const n = normalizeUsage(
      { input_tokens: -5, output_tokens: Number.NaN, cache_read_tokens: "7" as unknown as number },
      { cacheCategoriesReported: true },
    );
    expect(n.inputTokens).toBeNull();
    expect(n.outputTokens).toBeNull();
    expect(n.cacheReadTokens).toBeNull();
    // Without a usable input or output count only inferred zeros remain: unknown, not partial.
    expect(n.coverage).toBe("unknown");
  });

  test("only unusable counts means unknown coverage", () => {
    const n = normalizeUsage({ input_tokens: -1, output_tokens: -1 }, {});
    expect(n.coverage).toBe("unknown");
  });
});
