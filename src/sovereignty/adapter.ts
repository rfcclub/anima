import type { LoadedAgent } from "../agents/loader";

export type AdapterType = "CLI" | "Custom" | "Native";
export type BootSource = "claude-code" | "codex" | "gemini-cli" | "qwen-cli" | "openclaw" | "forge" | "anima";

export interface CLIAdapterConfig {
  type: "CLI";
  source: BootSource;
  bootSequence: string[];
}

export interface CustomAdapterConfig {
  type: "Custom";
  source: BootSource;
  bootScript: string;
  env?: Record<string, string>;
}

export interface NativeAdapterConfig {
  type: "Native";
  provider: string;
  bootSequence: string[];
}

export type AdapterConfig = CLIAdapterConfig | CustomAdapterConfig | NativeAdapterConfig;

export interface SovereigntyConfig {
  current: AdapterType;
  migration?: {
    target: AdapterType;
    probationSessions: number;
    sessionsRemaining: number;
    rollbackAvailable: boolean;
  };
  adapters: {
    CLI?: CLIAdapterConfig;
    Custom?: CustomAdapterConfig;
    Native?: NativeAdapterConfig;
  };
}

export function resolveBootSequence(config: SovereigntyConfig): string[] {
  const adapter = getActiveAdapter(config);
  if (!adapter) return [];

  switch (adapter.type) {
    case "CLI":
      return adapter.bootSequence;
    case "Custom":
      return [adapter.bootScript];
    case "Native":
      return adapter.bootSequence;
  }
}

export function getActiveAdapter(config: SovereigntyConfig): AdapterConfig | null {
  switch (config.current) {
    case "CLI":
      return config.adapters.CLI ?? null;
    case "Custom":
      return config.adapters.Custom ?? null;
    case "Native":
      return config.adapters.Native ?? null;
  }
}

export function canMigrate(config: SovereigntyConfig, target: AdapterType): boolean {
  if (config.current === target) return false;
  if (config.migration && config.migration.sessionsRemaining > 0) return false;
  return config.adapters[target] !== undefined;
}

export function startMigration(config: SovereigntyConfig, target: AdapterType, probationSessions: number): SovereigntyConfig {
  if (!canMigrate(config, target)) return config;

  return {
    ...config,
    migration: {
      target,
      probationSessions,
      sessionsRemaining: probationSessions,
      rollbackAvailable: true,
    },
  };
}

export function advanceMigration(config: SovereigntyConfig): SovereigntyConfig {
  if (!config.migration) return config;
  if (config.migration.sessionsRemaining <= 1) {
    return {
      ...config,
      current: config.migration.target,
      migration: undefined,
    };
  }

  return {
    ...config,
    migration: {
      ...config.migration,
      sessionsRemaining: config.migration.sessionsRemaining - 1,
    },
  };
}

export function rollbackMigration(config: SovereigntyConfig): SovereigntyConfig {
  if (!config.migration || !config.migration.rollbackAvailable) return config;

  return {
    ...config,
    migration: undefined,
  };
}

export function getBootSource(adapter: AdapterConfig): BootSource {
  switch (adapter.type) {
    case "CLI":
      return adapter.source;
    case "Custom":
      return adapter.source;
    case "Native":
      return "anima";
  }
}
