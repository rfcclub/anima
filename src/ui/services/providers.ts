import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoomConfig } from "../../config/types";
import { AnthropicProvider } from "../../providers/anthropic";
import { GeminiProvider } from "../../providers/gemini";
import { OpenAICompatProvider } from "../../providers/openai-compat";
import { ProviderRegistry } from "../../providers/registry";
import type { Provider } from "../../providers/interface";
import type { ProviderType, ProviderConfig, ProviderDef, ModeMap } from "../../config/types";
import { ModeRouter } from "../../providers/router";
import { CircuitBreaker } from "../../providers/circuit-breaker";
import { defaultRoomsDir } from "./session-store";
import { meterProvider } from "../../cost/meter";

export async function resolveAgentProvider(roomDir: string): Promise<Provider> {
  const configPath = join(roomDir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`no config.yaml in ${roomDir}`);
  }
  const config = loadRoomConfig(readFileSync(configPath, "utf-8"));
  return createProviderForType(config.provider);
}

export interface CreateProviderOverrides {
  registry?: ProviderRegistry | null;
  createProvider?: (providerId: string, provider: ProviderDef) => Provider;
  /** CircuitBreaker state file override — tests should isolate this from ~/.anima/breaker.json. */
  breakerPath?: string;
}

/**
 * Resolve a Provider for an agent's provider config. Registry-backed configs
 * (any provider other than Claude or Gemini) route through ModeRouter so the
 * agent's configured fallback chain + circuit breaker apply — a single
 * upstream 500 (e.g. a provider outage) no longer surfaces as a
 * user-facing failure when a fallback provider is configured and healthy.
 * Claude/Gemini stay on direct instantiation (unaffected).
 */
export async function createProviderForType(
  providerConfig: ProviderConfig,
  overrides?: CreateProviderOverrides,
): Promise<Provider> {
  const type = providerConfig.type as ProviderType;
  const registry = overrides?.registry !== undefined ? overrides.registry : await getProviderRegistry();
  const def = registry?.get(type);
  if (def) {
    if (!providerConfig.model) {
      return meterProvider(new OpenAICompatProvider(def), { path: "castle-ui" });
    }
    const modeMap: ModeMap = {
      chatting: [`${providerConfig.model}@${type}`],
      programming: [`${providerConfig.model}@${type}`],
      image: [`${providerConfig.model}@${type}`],
      private: [`${providerConfig.model}@${type}`],
      philosophy: [`${providerConfig.model}@${type}`],
      creative: [`${providerConfig.model}@${type}`],
    };
    const router = new ModeRouter(registry as ProviderRegistry, modeMap, {
      providerConfig,
      createProvider: overrides?.createProvider,
      meter: { path: "castle-ui" },
      breaker: overrides?.breakerPath ? new CircuitBreaker(overrides.breakerPath) : undefined,
    });
    return { name: "router", query: (req) => router.query(req, "chatting") };
  }

  switch (type) {
    case "claude": return meterProvider(new AnthropicProvider({ log: () => {} }), { path: "castle-ui" });
    case "gemini": return meterProvider(new GeminiProvider(), { path: "castle-ui" });
    default: throw new Error(`unsupported provider type: ${type}`);
  }
}

let _providerRegistry: ProviderRegistry | null | undefined;
async function getProviderRegistry(): Promise<ProviderRegistry | null> {
  if (_providerRegistry !== undefined) return _providerRegistry;
  const roomsDir = defaultRoomsDir();
  const dir = join(roomsDir, "..", "providers.d");
  try {
    _providerRegistry = await ProviderRegistry.load(dir);
    return _providerRegistry;
  } catch {
    _providerRegistry = null;
    return null;
  }
}
