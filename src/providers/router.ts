import type { ModeMap, ModelRef, ProviderDef, ProviderConfig, TaskMode } from "../config/types";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "./interface";
import { CircuitBreaker } from "./circuit-breaker";
import { meterProvider, type MeterOptions } from "../cost/meter";
import { OpenAIv1ChatProvider } from "./openai-v1-chat";
import { OpenAIv1ResponseProvider } from "./openai-v1-response";
import type { ProviderRegistry } from "./registry";

type ProviderFactory = (providerId: string, provider: ProviderDef) => Provider;

interface ModeRouterOptions {
  modeMap?: Partial<ModeMap>;
  createProvider?: ProviderFactory;
  /** Agent's provider config with optional fallback chain. */
  providerConfig?: ProviderConfig;
  /** CircuitBreaker instance (injectable for testing). */
  breaker?: CircuitBreaker;
  /** Where the leaf calls this router makes are recorded (injectable for testing). */
  meter?: MeterOptions;
}

const FALLBACK_CODES = new Set(["RATE_LIMITED", "QUOTA_EXHAUSTED", "SERVER_ERROR", "TIMEOUT"]);

/** A resolved entry in the fallback chain — provider + model + retry count. */
interface ChainEntry {
  ref: ModelRef;
  retry: number;
}

export class ModeRouter {
  private readonly agentModeMap?: Partial<ModeMap>;
  private readonly createProvider: ProviderFactory;
  private readonly providerCache = new Map<string, Provider>();
  private readonly breaker: CircuitBreaker;
  private readonly agentProviderConfig?: ProviderConfig;
  private readonly meterOptions?: MeterOptions;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly modeMap: ModeMap,
    options: ModeRouterOptions = {},
  ) {
    this.agentModeMap = options.modeMap;
    this.createProvider = options.createProvider ?? defaultProviderFactory;
    this.agentProviderConfig = options.providerConfig;
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.meterOptions = options.meter;
  }

  resolve(mode: TaskMode): ModelRef[] {
    return this.agentModeMap?.[mode] ?? this.modeMap[mode];
  }

  /** Build the ordered chain of providers to try from the agent's fallback config. */
  private buildChain(): ChainEntry[] {
    const cfg = this.agentProviderConfig;
    if (!cfg?.model || !cfg?.type) return [];

    const chain: ChainEntry[] = [
      {
        ref: `${cfg.model}@${cfg.type}` as ModelRef,
        retry: cfg.retry ?? 3,
      },
    ];

    for (const fb of cfg.fallback ?? []) {
      chain.push({
        ref: `${fb.model}@${fb.type}` as ModelRef,
        retry: fb.retry ?? (chain.length === 1 ? 2 : 1),
      });
    }

    return chain;
  }

  async query(req: ProviderRequest, mode: TaskMode): Promise<ProviderResponse> {
    req.signal?.throwIfAborted();
    const chain = this.buildChain();

    // If agent has a fallback config, use that chain. Otherwise use modeMap resolution.
    if (chain.length > 0) {
      return this.queryChain(req, chain);
    }

    return this.queryModeMap(req, mode);
  }

  /** Query using the agent's fallback chain (retry + breaker). */
  private async queryChain(req: ProviderRequest, chain: ChainEntry[]): Promise<ProviderResponse> {
    const errors: { ref: string; code: string; message: string }[] = [];

    for (const entry of chain) {
      req.signal?.throwIfAborted();
      const { provider, model } = this.registry.resolve(entry.ref);

      // Check breaker — skip if OPEN
      if (await this.breaker.isOpen(provider.id)) {
        console.log(`[breaker] ${provider.id} is OPEN, skipping to fallback`);
        errors.push({ ref: entry.ref, code: "SERVER_ERROR", message: `provider ${provider.id} breaker open` });
        continue;
      }

      const wasHalfOpen = await this.breaker.isHalfOpen(provider.id);

      // Retry loop
      let lastError: ProviderError | undefined;
      for (let attempt = 1; attempt <= entry.retry; attempt++) {
        try {
          req.signal?.throwIfAborted();
          const result = await this.providerFor(provider).query({
            ...req,
            model: model.id,
          });
          req.signal?.throwIfAborted();
          if (isAsyncGenerator(result)) {
            throw new ProviderError("SERVER_ERROR", provider.id, "streaming provider responses are not supported by ModeRouter");
          }

          // Success: close breaker if it was half-open, or if an earlier model on
          // this provider failed and this model answered (a same-provider fallback
          // must not trip the shared breaker on the next query; PR #101 review).
          if (wasHalfOpen) {
            this.breaker.recordSuccess(provider.id);
            console.log(`[breaker] ${provider.id} half-open → closed`);
          } else {
            await this.breaker.recordModelSuccess(provider.id, req.signal);
          }
          req.signal?.throwIfAborted();
          return result;
        } catch (error) {
          req.signal?.throwIfAborted();
          if (error instanceof ProviderError) {
            lastError = error;
            if (error.code === "AUTH_ERROR") {
              // Auth errors are non-retryable, skip this provider entirely
              break;
            }
            if (FALLBACK_CODES.has(error.code)) {
              // Will retry if attempts remain
              continue;
            }
            throw error; // Unknown error, don't swallow
          }
          throw error;
        }
      }

      // All retries exhausted (or auth error)
      if (lastError) {
        req.signal?.throwIfAborted();
        errors.push({ ref: entry.ref, code: lastError.code, message: lastError.message });

        // Open breaker if retries exhausted on transient errors
        if (lastError.code !== "AUTH_ERROR") {
          const prevState = (await this.breaker.getState(provider.id))?.state;
          req.signal?.throwIfAborted();
          this.breaker.recordFailure(provider.id);
          const newState = (await this.breaker.getState(provider.id))?.state;
          if (prevState !== "open" && newState === "open") {
            console.log(`[breaker] ${provider.id} opened (${(await this.breaker.getState(provider.id))?.failureCount} failures)`);
          }
        }
      }
    }

    req.signal?.throwIfAborted();
    const trail = errors.map((e) => `${e.ref}: ${e.code} — ${e.message}`).join("; ");
    throw new ProviderError("SERVER_ERROR", "router", `all providers exhausted. tried: ${trail}`);
  }

  /** Existing modeMap-based query (backward compatible — agents without fallback). */
  private async queryModeMap(req: ProviderRequest, mode: TaskMode): Promise<ProviderResponse> {
    const skippedProviders = new Set<string>();
    const providerErrors: { ref: string; code: string; message: string }[] = [];

    for (const ref of this.resolve(mode)) {
      req.signal?.throwIfAborted();
      const { provider, model } = this.registry.resolve(ref);

      // Breaker check for modeMap fallback too
      if (await this.breaker.isOpen(provider.id)) {
        console.log(`[breaker] ${provider.id} is OPEN, skipping to fallback`);
        providerErrors.push({ ref, code: "SERVER_ERROR", message: `provider ${provider.id} breaker open` });
        continue;
      }

      if (skippedProviders.has(provider.id)) {
        providerErrors.push({ ref, code: "AUTH_ERROR", message: `provider ${provider.id} skipped (auth error on earlier model)` });
        continue;
      }

      try {
        req.signal?.throwIfAborted();
        const result = await this.providerFor(provider).query({
          ...req,
          model: model.id,
        });
        req.signal?.throwIfAborted();
        if (isAsyncGenerator(result)) {
          throw new ProviderError("SERVER_ERROR", provider.id, "streaming provider responses are not supported by ModeRouter");
        }
        return result;
      } catch (error) {
        req.signal?.throwIfAborted();
        if (error instanceof ProviderError && error.code === "AUTH_ERROR") {
          skippedProviders.add(provider.id);
          providerErrors.push({ ref, code: error.code, message: error.message });
          continue;
        }
        if (error instanceof ProviderError && FALLBACK_CODES.has(error.code)) {
          providerErrors.push({ ref, code: error.code, message: error.message });
          this.breaker.recordFailure(provider.id);
          continue;
        }
        throw error;
      }
    }

    req.signal?.throwIfAborted();
    const trail = providerErrors.map((e) => `${e.ref}: ${e.code} — ${e.message}`).join("; ");
    throw new ProviderError("SERVER_ERROR", "router", `all providers exhausted. tried: ${trail}`);
  }

  private providerFor(provider: ProviderDef): Provider {
    const cached = this.providerCache.get(provider.id);
    if (cached) {
      return cached;
    }

    // Each attempt is its own metered leaf call; the router records nothing itself.
    const instance = meterProvider(this.createProvider(provider.id, provider), this.meterOptions);
    this.providerCache.set(provider.id, instance);
    return instance;
  }
}

function defaultProviderFactory(providerId: string, provider: ProviderDef): Provider {
  if (provider.api === "openai-completions" || provider.api === "anthropic-messages") {
    return new OpenAIv1ChatProvider(provider);
  }
  if (provider.api === "openai-responses") {
    return new OpenAIv1ResponseProvider(provider);
  }
  throw new Error(`provider factory not configured for ${providerId}`);
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
  return typeof (value as AsyncGenerator<unknown>)?.[Symbol.asyncIterator] === "function";
}
