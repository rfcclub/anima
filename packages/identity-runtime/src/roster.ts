import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A tenant id becomes a URL segment and a store path, so only plain lowercase names qualify. */
const TENANT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Agent ids from a colony roster file, in roster order. Missing or malformed file: no agents. */
export function readRosterAgentIds(colonyPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(colonyPath, "utf8")) as { agents?: unknown };
    if (!Array.isArray(parsed.agents)) return [];
    return parsed.agents.flatMap((agent) => {
      const name = (agent as { name?: unknown } | null)?.name;
      return typeof name === "string" && TENANT_ID.test(name) ? [name] : [];
    });
  } catch {
    return [];
  }
}

export interface ResolveColonyPathOptions {
  explicit?: string;
  /** Checked in order; defaults to the working directory's data/ (dev) then ~/.anima/data/ (prod). */
  candidates?: readonly string[];
}

/** The roster file to use: the explicit path if given, else the first candidate that exists. */
export function resolveColonyPath(options: ResolveColonyPathOptions = {}): string | undefined {
  if (options.explicit) return options.explicit;
  const candidates = options.candidates ?? [
    join(process.cwd(), "data", "colony.json"),
    join(homedir(), ".anima", "data", "colony.json"),
  ];
  return candidates.find((path) => existsSync(path));
}

export function isTenantId(value: string): boolean {
  return TENANT_ID.test(value);
}
