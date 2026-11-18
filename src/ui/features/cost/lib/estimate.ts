/**
 * Plain-language labels for the cost report's coverage (cost-ledger-accuracy).
 * The estimate undercounts or guesses when calls reported no usage, only part of it, or
 * were priced at a provider default; the dashboard must say so instead of showing a clean total.
 */

export interface EstimateCoverage {
  estimateComplete?: boolean;
  unknownCalls?: number;
  partialCalls?: number;
  fallbackPriced?: Array<{ provider: string; model: string; calls: number }>;
}

export interface LegacyBlock {
  summary: { totalRequests: number; estimatedCost: number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** null when there is nothing to warn about (including an answer from an API without the new fields). */
export function describeEstimate(s: EstimateCoverage): string | null {
  if (s.estimateComplete !== false) return null;
  const parts: string[] = [];
  if (s.unknownCalls) parts.push(`${plural(s.unknownCalls, "call", "calls")} without usage`);
  if (s.partialCalls) parts.push(`${s.partialCalls} with partial usage`);
  const guessed = (s.fallbackPriced ?? []).reduce((n, f) => n + f.calls, 0);
  if (guessed) parts.push(`${guessed} priced at a default`);
  return parts.length > 0 ? `Estimate incomplete: ${parts.join(", ")}` : "Estimate incomplete";
}

/** The history written before call records existed, kept apart and labelled as stored. */
export function describeLegacy(legacy: LegacyBlock | undefined): string | null {
  const s = legacy?.summary;
  if (!s || !s.totalRequests) return null;
  return `Before call records: ${s.totalRequests.toLocaleString("en-US")} requests, $${s.estimatedCost.toFixed(4)} (as stored)`;
}
