import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One token, bound to one agent and one caller, valid until `expiresAt` (epoch ms). Only the sha256 is stored. */
export interface RemoteTalkGrant {
  tokenSha256: string;
  agent: string;
  caller: string;
  expiresAt: number;
}

export interface RemoteTalkConfig {
  host: string;
  port: number;
  grants: RemoteTalkGrant[];
}

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "*", "[::]"]);

export function defaultRemoteTalkConfigPath(): string {
  return Bun.env.ANIMA_REMOTE_TALK_CONFIG ?? join(process.env.HOME ?? "~", ".anima", "secrets", "remote-talk.json");
}

/** Returns null when the file is absent (listener off). Throws on any invalid field. */
export function loadRemoteTalkConfig(path: string): RemoteTalkConfig | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error("remote talk config needs an explicit host (no wildcard bind)");
  }

  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("remote talk config port must be an integer 0-65535");
  }

  if (!Array.isArray(raw.grants) || raw.grants.length === 0) {
    throw new Error("remote talk config needs at least one grant");
  }
  const grants = raw.grants.map((value, index) => parseGrant(value, index));

  return { host, port, grants };
}

function parseGrant(value: unknown, index: number): RemoteTalkGrant {
  const grant = (value ?? {}) as Record<string, unknown>;
  const fail = (field: string): never => {
    throw new Error(`remote talk grant ${index}: invalid ${field}`);
  };
  const tokenSha256 = typeof grant.tokenSha256 === "string" && /^[0-9a-f]{64}$/i.test(grant.tokenSha256)
    ? grant.tokenSha256.toLowerCase()
    : fail("tokenSha256");
  const agent = typeof grant.agent === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(grant.agent) ? grant.agent : fail("agent");
  const caller = typeof grant.caller === "string" && /^[a-z0-9][a-z0-9_-]*@[a-z0-9][a-z0-9_-]*$/i.test(grant.caller)
    ? grant.caller
    : fail("caller");
  const expiresAt = typeof grant.expiresAt === "string" ? Date.parse(grant.expiresAt) : NaN;
  if (Number.isNaN(expiresAt)) fail("expiresAt");
  return { tokenSha256, agent, caller, expiresAt };
}
