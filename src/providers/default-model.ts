import type { Provider, ProviderRequest } from "./interface";

/**
 * Wrap a provider so a request that names no model uses `model` (the room's
 * configured model). Callers that bypass the agent loop (the dream paths) send
 * no model and would otherwise get the provider's first listed model, not the
 * one the owner set for the room. A request that names its own model wins.
 */
export function withDefaultModel(provider: Provider, model: string): Provider {
  const wrapped: Provider = {
    name: provider.name,
    sharedSafe: provider.sharedSafe,
    query(req: ProviderRequest) {
      return provider.query(req.model ? req : { ...req, model });
    },
  };
  // Keep the "already metered" marker so a later meterProvider() does not
  // meter the same calls twice.
  const marker = Symbol.for("anima.metered");
  if ((provider as unknown as Record<symbol, unknown>)[marker] === true) {
    (wrapped as unknown as Record<symbol, unknown>)[marker] = true;
  }
  return wrapped;
}
