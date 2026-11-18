import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { OpenAIv1ChatProvider } from "../providers/openai-v1-chat";
import type { Provider } from "../providers/interface";
import type { ProviderDef, ProviderApi } from "../config/types";
import type { ProviderRegistry } from "../providers/registry";
import { meterProvider } from "../cost/meter";

interface OverrideRule {
  match: string;
  provider: string;
  model: string;
}

interface InlineProvider {
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  headers?: Record<string, string>;
  extraParams?: Record<string, unknown>;
}

interface OverrideConfig {
  providers?: Record<string, InlineProvider>;
  overrides: OverrideRule[];
}

export interface OverrideResult {
  provider: Provider;
  providerDef: ProviderDef;
  modelId: string;
}

let _config: OverrideConfig | null | undefined;

async function loadConfig(): Promise<OverrideConfig | null> {
  if (_config !== undefined) return _config;

  const path =
    process.env.ANIMA_PROXY_OVERRIDES ??
    join(process.env.HOME ?? "~", ".config", "anima", "proxy-overrides.yaml");

  if (!existsSync(path)) {
    _config = null;
    return null;
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw) as OverrideConfig;
    if (!Array.isArray(parsed?.overrides)) {
      _config = null;
      return null;
    }
    _config = parsed;
    return _config;
  } catch {
    _config = null;
    return null;
  }
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

export async function resolveOverride(
  modelName: string,
  registry: ProviderRegistry,
): Promise<OverrideResult | null> {
  const config = await loadConfig();
  if (!config) return null;

  const rule = config.overrides.find(
    (r) => r.match === "*" || r.match === modelName,
  );
  if (!rule) return null;

  // Prefer existing ANIMA registry provider
  const registryDef = registry.get(rule.provider);
  if (registryDef) {
    return {
      provider: meterProvider(new OpenAIv1ChatProvider(registryDef), { path: "proxy" }),
      providerDef: registryDef,
      modelId: rule.model,
    };
  }

  // Fall back to inline provider in overrides config
  const inline = config.providers?.[rule.provider];
  if (!inline) return null;

  const def: ProviderDef = {
    id: rule.provider,
    label: rule.provider,
    baseUrl: inline.baseUrl,
    api: inline.api,
    apiKey: expandEnvVars(inline.apiKey),
    models: [{ id: rule.model }],
    ...(inline.headers ? { headers: inline.headers } : {}),
    ...(inline.extraParams ? { extraParams: inline.extraParams } : {}),
  };

  return {
    provider: meterProvider(new OpenAIv1ChatProvider(def), { path: "proxy" }),
    providerDef: def,
    modelId: rule.model,
  };
}
