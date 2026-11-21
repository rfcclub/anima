import type { Provider, ProviderRequest } from "./interface";

/**
 * Wrap a provider so a request that names no model uses `model` (the room's
 * configured model). Callers that bypass the agent loop (the dream paths) send
 * no model and would otherwise get the provider's first listed model, not the
 * one the owner set for the room. A request that names its own model wins.
 */
export function withDefaultModel(provider: Provider, model: string): Provider {
  return {
    name: provider.name,
    sharedSafe: provider.sharedSafe,
    query(req: ProviderRequest) {
      return provider.query(req.model ? req : { ...req, model });
    },
  };
}
