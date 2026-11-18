import { OpenAIv1ChatProvider } from "../providers/openai-v1-chat";
import type { Provider } from "../providers/interface";
import type { ProviderDef } from "../config/types";
import type { ProviderRegistry } from "../providers/registry";
import { meterProvider } from "../cost/meter";

export interface ResolvedModel {
  provider: Provider;
  providerDef: ProviderDef;
  modelId: string;
}

export function resolveModel(modelName: string, registry: ProviderRegistry): ResolvedModel | null {
  // provider/model explicit routing — no ambiguity
  const slash = modelName.indexOf("/");
  if (slash !== -1) {
    const providerId = modelName.slice(0, slash);
    const modelId = modelName.slice(slash + 1);
    const def = registry.get(providerId);
    if (!def) return null;
    return { provider: meterProvider(new OpenAIv1ChatProvider(def), { path: "proxy" }), providerDef: def, modelId };
  }

  // fallback: scan all providers by model id (first match wins, alpha order)
  for (const def of registry.list()) {
    const found = def.models.find((m) => m.id === modelName);
    if (found) {
      return { provider: meterProvider(new OpenAIv1ChatProvider(def), { path: "proxy" }), providerDef: def, modelId: found.id };
    }
  }
  return null;
}
