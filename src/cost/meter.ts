/**
 * Metering wrapper for a leaf Provider (cost-ledger-accuracy, anima #134).
 *
 * One `provider_calls` row per actual `Provider.query`, plus one `token_usage`
 * detail per model, written when the call settles. The wrapper is the only
 * place calls are recorded; call sites no longer log. It keeps the leaf's
 * Promise-or-AsyncGenerator shape, name, sharedSafe, errors and cancellation,
 * and a failure to record never changes what the caller gets.
 */

import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse, ProviderUsage } from "../providers/interface";
import type { CallCoverage, CallDetail, CallRecord, CallStatus } from "./ledger";
import { getDefaultLedger } from "./logger";
import { normalizeUsage, type RawUsage } from "./usage";

const METERED = Symbol.for("anima.metered");

export interface MeterOptions {
  /** Identifier of a non-session path, used when the request carries no sessionId. */
  path?: string;
  /** Where calls go. Default: the process ledger, opened on the first settlement. */
  ledger?: { recordCall(call: CallRecord): void };
  now?: () => number;
  newId?: () => string;
  onError?: (error: unknown, callId: string) => void;
}

export function isMetered(provider: unknown): boolean {
  return typeof provider === "object" && provider !== null && (provider as Record<symbol, unknown>)[METERED] === true;
}

function isAsyncIterator(value: unknown): value is AsyncGenerator<ProviderChunk> {
  return typeof (value as AsyncGenerator<ProviderChunk>)?.[Symbol.asyncIterator] === "function";
}

function combine(coverages: CallCoverage[]): CallCoverage {
  if (coverages.length > 0 && coverages.every((c) => c === "complete")) return "complete";
  if (coverages.every((c) => c === "unknown")) return "unknown";
  return "partial";
}

function detailsFor(usage: ProviderUsage | undefined, req: ProviderRequest): { details: CallDetail[]; coverage: CallCoverage } {
  const meta = {
    inputIncludesCache: usage?.input_includes_cache,
    cacheCategoriesReported: usage?.cache_categories_reported,
    inputReported: usage?.input_reported,
    outputReported: usage?.output_reported,
  };
  const toDetail = (model: string, raw: RawUsage | undefined) => {
    const n = normalizeUsage(raw, meta);
    return { n, detail: { model, inputTokens: n.inputTokens, outputTokens: n.outputTokens, cacheReadTokens: n.cacheReadTokens, cacheWriteTokens: n.cacheWriteTokens } satisfies CallDetail };
  };
  if (usage?.models && usage.models.length > 0) {
    const parts = usage.models.map((m) => toDetail(m.model, m));
    return { details: parts.map((p) => p.detail), coverage: combine(parts.map((p) => p.n.coverage)) };
  }
  const part = toDetail(usage?.model ?? req.model ?? "unknown", usage);
  return { details: [part.detail], coverage: part.n.coverage };
}

export function meterProvider(leaf: Provider, opts: MeterOptions = {}): Provider {
  if (isMetered(leaf)) return leaf;

  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const report = opts.onError ?? ((error: unknown, callId: string) => { console.error(`[cost] could not record provider call ${callId}:`, error); });
  const ledgerOf = () => opts.ledger ?? getDefaultLedger();

  /** The state of one call from its first moment to its settlement. */
  function begin(req: ProviderRequest, startedMs: number) {
    const callId = newId();
    let final = false;
    let aborted = false;
    let abortLatency = 0;
    const signal = req.signal;

    const write = (status: CallStatus, usage: ProviderUsage | undefined, latencyMs: number) => {
      try {
        const { details, coverage } = detailsFor(usage, req);
        ledgerOf().recordCall({
          callId,
          agentId: req.agent || "unknown",
          sessionId: req.sessionId ?? null,
          pathId: req.sessionId ? null : (opts.path ?? null),
          backend: leaf.name,
          startedAt: new Date(startedMs).toISOString(),
          latencyMs: Math.max(0, latencyMs),
          status,
          coverage,
          details,
          ...(req.work ? { work: req.work } : {}),
        });
      } catch (error) {
        report(error, callId);
      }
    };

    const onAbort = () => {
      if (final || aborted) return;
      aborted = true;
      abortLatency = Math.max(0, now() - startedMs);
      write("aborted", undefined, abortLatency);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    return {
      /** Settles the call once. After an abort the status stays aborted; a provider that finishes later only adds its usage to the same call. */
      finish(status: CallStatus, usage: ProviderUsage | undefined): void {
        if (final) return;
        final = true;
        signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          if (usage) write("aborted", usage, abortLatency);
          return;
        }
        write(status, usage, Math.max(0, now() - startedMs));
      },
      get settled(): boolean { return final; },
    };
  }

  const metered = Object.create(leaf) as Provider;
  Object.defineProperty(metered, METERED, { value: true, enumerable: false });
  Object.defineProperty(metered, "query", {
    enumerable: true,
    configurable: true,
    writable: true,
    value(req: ProviderRequest): AsyncGenerator<ProviderChunk> | Promise<ProviderResponse> {
      const startedMs = now();
      let result: AsyncGenerator<ProviderChunk> | Promise<ProviderResponse>;
      try {
        result = leaf.query.call(leaf, req);
      } catch (error) {
        const call = begin(req, startedMs);
        call.finish("error", undefined);
        throw error;
      }

      if (isAsyncIterator(result)) {
        const inner = result;
        return (async function* () {
          const call = begin(req, now());
          let usage: ProviderUsage | undefined;
          let sawErrorChunk = false;
          let exhausted = false;
          try {
            while (true) {
              const step = await inner.next();
              if (step.done) { exhausted = true; break; }
              if (step.value.usage) usage = step.value.usage;
              if (step.value.type === "error") sawErrorChunk = true;
              yield step.value;
            }
            call.finish(sawErrorChunk ? "error" : "ok", usage);
          } catch (error) {
            call.finish("error", usage);
            throw error;
          } finally {
            // An explicit return() from the consumer lands here before the stream ended.
            call.finish(sawErrorChunk ? "error" : "ok", usage);
            if (!exhausted) {
              try { await inner.return(undefined); } catch { /* the consumer already left */ }
            }
          }
        })();
      }

      const call = begin(req, startedMs);
      return Promise.resolve(result).then(
        (response) => { call.finish("ok", response?.usage); return response; },
        (error) => { call.finish("error", undefined); throw error; },
      );
    },
  });
  return metered;
}
