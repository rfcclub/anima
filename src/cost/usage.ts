/**
 * Ledger-boundary usage normalisation (cost-ledger-accuracy, anima #134).
 *
 * Providers keep their public token values. Only here does the ledger turn a
 * response's usage into one meaning: `inputTokens` is uncached input. NULL
 * means "not reported or not verifiable"; a measured zero stays 0.
 */

import type { CallCoverage } from "./ledger";

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface UsageMeta {
  /** The leaf states that `input_tokens` already includes cached tokens
   *  (OpenAI `prompt_tokens`, DeepSeek hit tokens); cache-read is then
   *  subtracted. Anything else is not subtracted. */
  inputIncludesCache?: boolean;
  /** The leaf states that it reports cache categories, so an absent one means
   *  none were used (0). Without this an absent category is unknown (NULL). */
  cacheCategoriesReported?: boolean;
  /** The wire carried no input/output count at all. `false` makes it unknown (NULL), never a measured zero;
   *  omitted means the leaf's number is a real report. */
  inputReported?: boolean;
  outputReported?: boolean;
}

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  coverage: CallCoverage;
}

const NONE: NormalizedUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, coverage: "unknown" };

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeUsage(usage: RawUsage | undefined, meta: UsageMeta): NormalizedUsage {
  if (!usage) return { ...NONE };

  let input = meta.inputReported === false ? null : count(usage.input_tokens);
  const output = meta.outputReported === false ? null : count(usage.output_tokens);
  const absentIsZero = meta.cacheCategoriesReported === true;
  const cacheRead = usage.cache_read_tokens === undefined ? (absentIsZero ? 0 : null) : count(usage.cache_read_tokens);
  const cacheWrite = usage.cache_write_tokens === undefined ? (absentIsZero ? 0 : null) : count(usage.cache_write_tokens);

  if (meta.inputIncludesCache === true && input !== null && cacheRead !== null) {
    input = cacheRead > input ? null : input - cacheRead;
  }

  const all = [input, output, cacheRead, cacheWrite];
  const known = all.filter((v) => v !== null).length;
  const coverage: CallCoverage = known === all.length ? "complete" : known === 0 || (input === null && output === null) ? "unknown" : "partial";
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, coverage };
}
