import type { Fs } from "./types.ts";

export interface Config {
  intervalMs: number;
  runCapMs: number;
  owned: string[];
  ports: Record<string, string>;
  thresholds: {
    presenceMinutes: number;
    claimMinutes: number;
    crashRuns: number;
    crashWindowMinutes: number;
    restartCap: number;
    restartWindowMinutes: number;
  };
  telegramEnvFile: string;
  meshLoaderModule: string;
  issuerKeyFile: string;
  issuerKid: string;
  runtimeFile: string;
  lastGoodDir: string;
  logMaxBytes: number;
}

const DEFAULTS: Config = {
  intervalMs: 120000,
  runCapMs: 60000,
  // Service labels and port owners are supplied by the deployment's config file.
  owned: [],
  ports: {},
  thresholds: {
    presenceMinutes: 5,
    claimMinutes: 30,
    crashRuns: 5,
    crashWindowMinutes: 10,
    restartCap: 3,
    restartWindowMinutes: 60,
  },
  // Paths and key id are intentionally unset until a deployment supplies them.
  telegramEnvFile: "",
  meshLoaderModule: "",
  issuerKeyFile: "",
  issuerKid: "",
  runtimeFile: "",
  lastGoodDir: "",
  logMaxBytes: 1048576,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config ${name}: expected a positive finite number`);
  }
  return value;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Invalid config ${name}: expected an object of non-empty strings`);
  }
  return value as Record<string, string>;
}

export function loadConfig(fs: Fs, path: string): Config {
  const contents = fs.read(path);
  let overrides: unknown = {};
  if (contents !== undefined) {
    try {
      overrides = JSON.parse(contents);
    } catch {
      throw new Error(`Invalid config ${path}: expected valid JSON`);
    }
  }
  if (!isRecord(overrides)) throw new Error(`Invalid config ${path}: expected a JSON object`);

  const value = { ...DEFAULTS, ...overrides } as Record<string, unknown>;
  const intervalMs = positiveNumber(value.intervalMs, "intervalMs");
  const runCapMs = positiveNumber(value.runCapMs, "runCapMs");
  const logMaxBytes = positiveNumber(value.logMaxBytes, "logMaxBytes");
  if (logMaxBytes < 256) throw new Error("Invalid config logMaxBytes: expected at least 256");
  if (!Number.isInteger(intervalMs) || !Number.isInteger(runCapMs) || !Number.isInteger(logMaxBytes)) {
    throw new Error("Invalid config intervalMs, runCapMs, or logMaxBytes: expected integers");
  }
  if (!Array.isArray(value.owned) || value.owned.some((label) => typeof label !== "string" || !label)) {
    throw new Error("Invalid config owned: expected an array of non-empty strings");
  }
  const ports = stringRecord(value.ports, "ports");
  if (Object.keys(ports).some((port) => !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error("Invalid config ports: keys must be valid port numbers");
  }
  if (!isRecord(value.thresholds)) throw new Error("Invalid config thresholds: expected an object");
  const thresholdNames = ["presenceMinutes", "claimMinutes", "crashRuns", "crashWindowMinutes", "restartCap", "restartWindowMinutes"] as const;
  const thresholds = { ...DEFAULTS.thresholds };
  for (const name of thresholdNames) {
    if (name in value.thresholds) {
      const threshold = value.thresholds[name];
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) {
        throw new Error(`Invalid config thresholds.${name}: expected a positive finite number`);
      }
      if ((name === "crashRuns" || name === "restartCap") && !Number.isInteger(threshold)) {
        throw new Error(`Invalid config thresholds.${name}: expected a positive integer`);
      }
      thresholds[name] = threshold;
    }
  }
  const stringFields = ["telegramEnvFile", "meshLoaderModule", "issuerKeyFile", "issuerKid", "runtimeFile", "lastGoodDir"] as const;
  for (const name of stringFields) {
    if (typeof value[name] !== "string") throw new Error(`Invalid config ${name}: expected a string`);
  }

  return {
    intervalMs,
    runCapMs,
    owned: [...value.owned] as string[],
    ports,
    thresholds,
    telegramEnvFile: value.telegramEnvFile as string,
    meshLoaderModule: value.meshLoaderModule as string,
    issuerKeyFile: value.issuerKeyFile as string,
    issuerKid: value.issuerKid as string,
    runtimeFile: value.runtimeFile as string,
    lastGoodDir: value.lastGoodDir as string,
    logMaxBytes,
  };
}
