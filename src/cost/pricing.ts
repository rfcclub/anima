/**
 * Provider pricing — Cost per 1M tokens (USD).
 *
 * Reads from ~/.anima/pricing.json if available.
 * Falls back to hardcoded defaults in PRICING below.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  /** Cache write cost (5-min TTL, most common). 1.25x base input for Anthropic. */
  cacheWrite?: number;
  /** Free model — skip cost calculation entirely */
  free?: boolean;
  /** Fixed monthly plan — skip per-token cost (e.g. Gemini AI Studio plan) */
  plan?: boolean;
}

export type PricingConfig = Record<string, Record<string, ModelPrice>>;

const HOME = process.env.HOME ?? "~";
const PRICING_PATH = join(HOME, ".anima", "pricing.json");

function loadPricing(): PricingConfig {
  try {
    if (existsSync(PRICING_PATH)) {
      return JSON.parse(readFileSync(PRICING_PATH, "utf-8"));
    }
  } catch { /* fall through to defaults */ }
  return DEFAULTS;
}

export function reloadPricing(): PricingConfig {
  return loadPricing();
}

const DEFAULTS: PricingConfig = {
  claude: {
    "claude-fable-5":     { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.50 },
    "claude-opus-4-8":    { input: 5.0, output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
    "claude-opus-4-7":    { input: 5.0, output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
    "claude-opus-4-6":    { input: 5.0, output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
    "claude-sonnet-4-6":  { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
    "claude-sonnet-4-5":  { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
    "claude-haiku-4-5":   { input: 1.0, output: 5.0, cacheRead: 0.10, cacheWrite: 1.25 },
    default:              { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  gemini: {
    "gemini-2.5-flash": { input: 0, output: 0, plan: true },
    "gemini-2.5-pro": { input: 0, output: 0, plan: true },
    "gemini-3.1-flash-lite-preview": { input: 0, output: 0, plan: true },
    default: { input: 0, output: 0, plan: true },
  },
  minimax: {
    "MiniMax-M3": { input: 0.60, output: 4.0, cacheRead: 0.12 },
    "MiniMax-M2.7": { input: 0.50, output: 3.0, cacheRead: 0.10 },
    "MiniMax-Text-01": { input: 0.20, output: 1.0, cacheRead: 0.04 },
    default: { input: 0.60, output: 4.0, cacheRead: 0.12 },
  },
  deepseek: {
    // DeepSeek native KV cache: cache hit = ~10% of input, cache miss = 100%
    // https://api-docs.deepseek.com/quick_start/pricing
    "deepseek-v4-pro": { input: 1.25, output: 8.0, cacheRead: 0.014 },
    "deepseek-v4-flash": { input: 0.30, output: 2.0, cacheRead: 0.0028 },
    default: { input: 0.50, output: 2.0, cacheRead: 0.014 },
  },
  qwen: {
    "qwen3.7-max": { input: 1.0, output: 4.0 },
    "qwen3.6-plus": { input: 0.50, output: 2.0 },
    default: { input: 0.50, output: 2.0 },
  },
  xiaomi: {
    "mimo-v2.5-pro": { input: 0.80, output: 3.0, cacheRead: 0.08, cacheWrite: 1.0 },
    "mimo-v2.5": { input: 0.40, output: 1.50, cacheRead: 0.04, cacheWrite: 0.50 },
    default: { input: 0.80, output: 3.0, cacheRead: 0.08, cacheWrite: 1.0 },
  },
  exampleprov: {
    // Nahcrof proxies DeepSeek + GLM through Anthropic-compatible API.
    // Cache pricing follows DeepSeek KV cache rates (~10% of input for cache hits).
    "glm-5.1": { input: 0.50, output: 2.0, cacheRead: 0.05 },
    "kimi-k2.6": { input: 0.60, output: 2.50, cacheRead: 0.06 },
    "deepseek-v4-pro": { input: 1.25, output: 8.0, cacheRead: 0.014 },
    "deepseek-v4-flash": { input: 0.30, output: 2.0, cacheRead: 0.0028 },
    "qwen3.5-397b-a17b": { input: 0.50, output: 2.0, cacheRead: 0.05 },
    default: { input: 0.50, output: 2.0, cacheRead: 0.05 },
  },
  openrouter: {
    "deepseek/deepseek-v4-flash:free": { input: 0, output: 0, free: true },
    "moonshotai/kimi-k2.6:free": { input: 0, output: 0, free: true },
    "nvidia/nemotron-3-ultra-550b-a55b:free": { input: 0, output: 0, free: true },
    "nvidia/nemotron-3-super-120b-a12b:free": { input: 0, output: 0, free: true },
    default: { input: 0.50, output: 2.0 },
  },
  neuralwatt: {
    "kimi-k2.6":       { input: 0.60, output: 2.50 },
    "glm-5.1":         { input: 0.50, output: 2.0 },
    "qwen3.5-397b":    { input: 0.50, output: 2.0 },
    "qwen3.6-35b":     { input: 0.20, output: 0.80 },
    default:           { input: 0.50, output: 2.0 },
  },
  supergrok: {
    // SuperGrok subscription via OAuth — fixed monthly plan, no per-token billing
    "grok-4":       { input: 0, output: 0, plan: true },
    "grok-4-mini":  { input: 0, output: 0, plan: true },
    "grok-3":       { input: 0, output: 0, plan: true },
    "grok-3-mini":  { input: 0, output: 0, plan: true },
    default:        { input: 0, output: 0, plan: true },
  },
  opencode_go: {
    "minimax-m3": { input: 0.60, output: 4.0, cacheRead: 0.12 },
    "kimi-k2.6": { input: 0.60, output: 2.50 },
    "mimo-v2.5-pro": { input: 0.80, output: 3.0 },
    default: { input: 0.50, output: 2.0 },
  },
};

/** Trailing parts that name a build or variant of a model, not a different price: a date (-20260101,
 *  -2026-01-01), -latest, or a bracketed qualifier ([1m]). */
function aliasCandidates(model: string): string[] {
  const out: string[] = [];
  let m = model.replace(/\[[^\]]*\]$/, "");
  if (m !== model) out.push(m);
  const dated = m.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "");
  if (dated !== m) out.push(dated);
  return out;
}

/** Looks a price up and says whether it was found by name (`exact`) or is the provider default or the
 *  unknown-provider guess. */
function lookupIn(pricing: PricingConfig, provider: string, model?: string): { price: ModelPrice; exact: boolean } {
  const provPricing = pricing[provider.toLowerCase()];
  if (!provPricing) return { price: { input: 0.50, output: 2.0 }, exact: false }; // unknown provider: a guess
  if (model && provPricing[model] && model !== "default") return { price: provPricing[model], exact: true };
  if (model) {
    for (const candidate of aliasCandidates(model)) {
      if (candidate !== "default" && provPricing[candidate]) return { price: provPricing[candidate], exact: true };
    }
  }
  return { price: provPricing["default"] ?? { input: 0.50, output: 2.0 }, exact: false };
}

function priceIn(pricing: PricingConfig, provider: string, model?: string): ModelPrice {
  return lookupIn(pricing, provider, model).price;
}

export function getPrice(provider: string, model?: string): ModelPrice {
  return priceIn(loadPricing(), provider, model);
}

function costWith(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  // Free models or fixed monthly plans — no per-token cost
  if (price.free || price.plan) return 0;
  // If all prices are 0, skip (user hasn't set pricing)
  if (price.input === 0 && price.output === 0 && !price.cacheRead && !price.cacheWrite) return 0;

  const inputCost = (inputTokens / 1_000_000) * price.input;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  const cacheReadCost = cacheReadTokens
    ? (cacheReadTokens / 1_000_000) * (price.cacheRead ?? price.input * 0.10)
    : 0;
  const cacheWriteCost = (cacheWriteTokens && price.cacheWrite)
    ? (cacheWriteTokens / 1_000_000) * price.cacheWrite
    : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Calculate USD cost from token counts. Returns 0 for free/plan models. */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  provider: string,
  model?: string,
): number {
  return costWith(getPrice(provider, model), inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
}

/** A price table read once, for a report that prices many rows. */
export function createPricer(load: () => PricingConfig = loadPricing) {
  const pricing = load();
  return {
    cost(inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, provider: string, model?: string): number {
      return costWith(priceIn(pricing, provider, model), inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    },
    /** True when the price used is a fallback guess (provider default for an unlisted model, or an unknown
     *  provider). A free or plan price is never a guess: it costs nothing whichever model it is. */
    isFallback(provider: string, model?: string): boolean {
      const { price, exact } = lookupIn(pricing, provider, model);
      return !exact && !price.free && !price.plan;
    },
  };
}
