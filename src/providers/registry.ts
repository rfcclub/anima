import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { ModelRef, ProviderApi, ProviderDef, ProviderModelDef } from "../config/types";

type WarnFn = (message: string) => void;

const PROVIDER_APIS: ProviderApi[] = ["openai-completions", "anthropic-messages", "openai-responses", "generic"];
// Matches ${VAR} and bash-style ${VAR:-default} (default may be empty: ${VAR:-}).
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;
const OAUTH_VAR_RE = /\$\{OAUTH:([a-z][a-z0-9_-]*)\}/gi;

/** Resolve ${ENV_VAR}, ${ENV_VAR:-default}, and ${OAUTH:source} patterns in an apiKey string. */
async function resolveApiKey(value: string): Promise<string> {
  // Resolve OAuth tokens first
  let resolved = value;
  const oauthMatches = [...value.matchAll(OAUTH_VAR_RE)];
  for (const match of oauthMatches) {
    const source = match[1];
    const token = await getOAuthToken(source);
    resolved = resolved.replace(match[0], token);
  }
  // Resolve env vars
  return resolved.replace(ENV_VAR_RE, (_match, name, defaultValue) => {
    const env = (typeof Bun !== "undefined" ? Bun.env[name] : undefined) ?? process.env[name];
    if (env) return env;
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`env var not set: ${name}`);
  });
}

/** Search OpenClaw auth-profiles (both directory and agent file formats) for an OAuth token. */
async function findOpenClawOAuthToken(provider: string): Promise<string | null> {
  const home = process.env.HOME ?? "~";

  // 1. Agent format: ~/.openclaw/agents/*/agent/auth-profiles.json
  const agentsDir = join(home, ".openclaw", "agents");
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (!entry.isDirectory()) continue;
      const profilesFile = join(agentsDir, entry.name, "agent", "auth-profiles.json");
      try {
        const raw = await readFile(profilesFile, "utf8");
        const data = JSON.parse(raw);
        const profiles = data?.profiles;
        if (!profiles || typeof profiles !== "object") continue;
        for (const profile of Object.values(profiles)) {
          if (!isRecord(profile)) continue;
          if (profile.provider === provider && profile.type === "oauth" && typeof profile.access === "string") {
            // Skip expired tokens — caller should re-auth via OpenClaw
            const exp = typeof profile.expires === "number" ? profile.expires : 0;
            if (exp > 0 && exp < Date.now()) continue;
            return profile.access;
          }
        }
      } catch {
        // try next agent
      }
    }
  } catch {
    // agents dir doesn't exist
  }

  // 2. Directory format: ~/.openclaw/credentials/auth-profiles/*.json
  const profilesDir = join(home, ".openclaw", "credentials", "auth-profiles");
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(profilesDir, entry.name), "utf8");
        const profile = JSON.parse(raw);
        if (profile?.provider === provider && profile?.access) {
          const exp = typeof profile.expires === "number" ? profile.expires : 0;
          if (exp > 0 && exp < Date.now()) continue;
          return profile.access as string;
        }
      } catch {
        // try next profile
      }
    }
  } catch {
    // profiles dir doesn't exist
  }

  return null;
}

async function getOAuthToken(source: string): Promise<string> {
  switch (source) {
    case "openai": {
      // Primary: Codex auth.json
      const authFile = join(process.env.HOME ?? "~", ".codex", "auth.json");
      try {
        const raw = await readFile(authFile, "utf8");
        const auth = JSON.parse(raw);
        const token = auth?.tokens?.access_token;
        if (token) return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // Fallback: OpenClaw OAuth profile
      const token = await findOpenClawOAuthToken("openai-codex");
      if (token) return token;
      throw new Error(`OpenAI OAuth token not found — run codex login or check OpenClaw auth`);
    }
    case "supergrok": {
      // Dedicated auth files
      const locations = [
        join(process.env.HOME ?? "~", ".anima", "auth", "supergrok.json"),
        join(process.env.HOME ?? "~", ".config", "xai", "auth.json"),
      ];
      for (const loc of locations) {
        try {
          const raw = await readFile(loc, "utf8");
          const auth = JSON.parse(raw);
          const token = auth?.access_token ?? auth?.tokens?.access_token;
          if (token) return token;
        } catch {
          // try next location
        }
      }
      // Fallback: OpenClaw OAuth profile
      const token = await findOpenClawOAuthToken("xai");
      if (token) return token;
      throw new Error(`SuperGrok OAuth token not found — place access_token at ~/.anima/auth/supergrok.json or run xAI OAuth login`);
    }
    default:
      throw new Error(`unknown OAuth source: ${source}`);
  }
}

export class ProviderRegistry {
  private constructor(private readonly providers: Map<string, ProviderDef>) {}

  static async load(dir: string, warn: WarnFn = defaultWarn): Promise<ProviderRegistry> {
    const providers = new Map<string, ProviderDef>();

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "import.yaml") {
          continue;
        }

        const filePath = join(dir, entry.name);
        try {
          const raw = validateProviderDef(yaml.load(await readFile(filePath, "utf8")), filePath);
          const provider: ProviderDef = { ...raw, apiKey: await resolveApiKey(raw.apiKey) };
          providers.set(provider.id, provider);
        } catch (error) {
          warn(`skipping invalid provider file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`failed to scan provider directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const provider of await importFromSiblingImportFile(dir, warn)) {
      providers.set(provider.id, provider);
    }

    return new ProviderRegistry(providers);
  }

  static async importOpenClaw(path: string, warn: WarnFn = defaultWarn): Promise<ProviderDef[]> {
    if (!existsSync(path)) {
      warn(`OpenClaw import file missing: ${path}`);
      return [];
    }

    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const providers = readOpenClawProviders(parsed);
      const result: ProviderDef[] = [];
      for (const [id, rawProvider] of providers) {
        try {
          result.push(openClawProviderToProviderDef(id, rawProvider, path));
        } catch (error) {
          warn(`skipping invalid OpenClaw provider ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    } catch (error) {
      warn(`failed to import OpenClaw config ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  get(id: string): ProviderDef | undefined {
    return this.providers.get(id);
  }

  list(): ProviderDef[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(ref: ModelRef): { provider: ProviderDef; model: ProviderModelDef } {
    const at = ref.lastIndexOf("@");
    if (at <= 0 || at === ref.length - 1) {
      throw new Error(`invalid model ref: ${ref}`);
    }

    const modelId = ref.slice(0, at);
    const providerId = ref.slice(at + 1);
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`unknown provider: ${providerId}`);
    }

    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`unknown model: ${modelId}@${providerId}`);
    }

    return { provider, model };
  }
}

async function importFromSiblingImportFile(dir: string, warn: WarnFn): Promise<ProviderDef[]> {
  const importPath = join(dirname(dir), "import.yaml");
  if (!existsSync(importPath)) {
    return [];
  }

  try {
    const parsed = yaml.load(await readFile(importPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.sources)) {
      warn(`skipping invalid import file ${importPath}: missing sources`);
      return [];
    }

    const imported: ProviderDef[] = [];
    for (const source of parsed.sources) {
      if (!isRecord(source)) {
        warn(`skipping invalid import source in ${importPath}`);
        continue;
      }
      if (source.type === "openclaw" && typeof source.path === "string") {
        imported.push(...await ProviderRegistry.importOpenClaw(expandHome(source.path), warn));
      }
    }
    return imported;
  } catch (error) {
    warn(`failed to read import file ${importPath}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function validateProviderDef(value: unknown, source: string): ProviderDef {
  if (!isRecord(value)) {
    throw new Error("provider must be a YAML object");
  }

  const id = requireString(value, "id");
  const label = requireString(value, "label");
  const baseUrl = requireString(value, "baseUrl");
  const api = requireApi(value, "api");
  const apiKey = requireString(value, "apiKey");
  const models = requireModels(value, source);
  const endpoint = readString(value, "endpoint");
  const headers = readStringRecord(value, "headers");
  const extraParams = readRecord(value, "extraParams");
  const sharedSafe = readBoolean(value, "sharedSafe");

  return {
    id,
    label,
    baseUrl,
    api,
    apiKey,
    models,
    ...(endpoint ? { endpoint } : {}),
    ...(headers ? { headers } : {}),
    ...(extraParams ? { extraParams } : {}),
    ...(sharedSafe !== undefined ? { sharedSafe } : {}),
  };
}

function openClawProviderToProviderDef(id: string, rawProvider: unknown, source: string): ProviderDef {
  if (!isRecord(rawProvider)) {
    throw new Error("provider must be an object");
  }

  const withDefaults = {
    ...rawProvider,
    id,
    label: typeof rawProvider.label === "string" ? rawProvider.label : id,
    api: typeof rawProvider.api === "string" ? rawProvider.api : "openai-completions",
  };

  return validateProviderDef(withDefaults, source);
}

function readOpenClawProviders(parsed: unknown): Array<[string, unknown]> {
  if (!isRecord(parsed)) {
    return [];
  }
  if (isRecord(parsed.providers)) {
    return Object.entries(parsed.providers);
  }
  if (Array.isArray(parsed.providers)) {
    return parsed.providers
      .filter(isRecord)
      .map((provider) => [String(provider.id ?? provider.name ?? ""), provider] as [string, unknown])
      .filter(([id]) => id.length > 0);
  }
  return [];
}

function requireModels(parent: Record<string, unknown>, source: string): ProviderModelDef[] {
  const value = parent.models;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("missing required field: models");
  }

  return value.map((model, index) => {
    if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) {
      throw new Error(`invalid model at ${source}#models[${index}]`);
    }
    return {
      ...model,
      id: model.id,
      ...(typeof model.label === "string" ? { label: model.label } : {}),
      ...(isRecord(model.extraParams) ? { extraParams: model.extraParams } : {}),
    } as ProviderModelDef;
  });
}

function requireString(parent: Record<string, unknown>, field: string): string {
  const value = parent[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required field: ${field}`);
  }
  return value;
}

function readString(parent: Record<string, unknown>, field: string): string | undefined {
  const value = parent[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid field: ${field}`);
  }
  return value;
}

function readBoolean(parent: Record<string, unknown>, field: string): boolean | undefined {
  const value = parent[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`invalid field: ${field}`);
  return value;
}

function requireApi(parent: Record<string, unknown>, field: string): ProviderApi {
  const value = requireString(parent, field);
  if (!PROVIDER_APIS.includes(value as ProviderApi)) {
    throw new Error(`invalid field: ${field}`);
  }
  return value as ProviderApi;
}

function readStringRecord(parent: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const value = parent[field];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`invalid field: ${field}`);
  }
  return value as Record<string, string>;
}

function readRecord(parent: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = parent[field];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`invalid field: ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(path: string): string {
  if (path === "~") {
    return process.env.HOME ?? path;
  }
  if (path.startsWith("~/")) {
    return join(process.env.HOME ?? "~", path.slice(2));
  }
  return path;
}

function defaultWarn(message: string): void {
  console.warn(message);
}
