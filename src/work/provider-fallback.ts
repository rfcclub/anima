/**
 * A fallback model for the work lane (owner, 2026-11-28): when the pinned provider is rate limited, out of quota,
 * failing on its side or timing out, the same turn is sent to the configured fallback instead of failing the session.
 * Authentication errors and aborted requests are never hidden. A streamed answer falls back only before its first
 * chunk, so no turn is ever stitched together from two models.
 */
import { ProviderError, type Provider, type ProviderChunk, type ProviderRequest, type ProviderResponse } from "../providers/interface";

const FALLBACK_CODES = new Set(["RATE_LIMITED", "QUOTA_EXHAUSTED", "SERVER_ERROR", "TIMEOUT"]);

function shouldFallBack(error: unknown, req: ProviderRequest): error is ProviderError {
  const signal = (req as { signal?: AbortSignal }).signal;
  return error instanceof ProviderError && FALLBACK_CODES.has(error.code) && !signal?.aborted;
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return typeof (value as { then?: unknown })?.then === "function";
}

export function withFallback(primary: Provider, fallback: Provider | undefined, onFallback?: (error: ProviderError) => void): Provider {
  if (!fallback) return primary;
  return {
    name: primary.name,
    ...(primary.sharedSafe !== undefined ? { sharedSafe: primary.sharedSafe } : {}),
    query(req: ProviderRequest): AsyncGenerator<ProviderChunk> | Promise<ProviderResponse> {
      const first = primary.query(req);
      if (isPromise<ProviderResponse>(first)) {
        return first.catch((error: unknown) => {
          if (!shouldFallBack(error, req)) throw error;
          const second = fallback.query(req);
          if (!isPromise<ProviderResponse>(second)) throw error;
          onFallback?.(error);
          return second;
        });
      }
      return (async function* () {
        let yielded = false;
        try {
          for await (const chunk of first) { yielded = true; yield chunk; }
        } catch (error) {
          if (yielded || !shouldFallBack(error, req)) throw error;
          onFallback?.(error);
          const second = fallback.query(req);
          if (isPromise<ProviderResponse>(second)) throw error;
          yield* second;
        }
      })();
    },
  };
}
