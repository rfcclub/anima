/**
 * Fetches an agent's identity projection from identity-runtime and caches it
 * to a file. Rebuilds when the cache is missing, older than STALE_MS, or
 * --force is given; otherwise leaves it untouched.
 *
 * Generic replacement for the old per-agent copies (scripts/claude/fetch-identity.ts,
 * scripts/codex/fetch-identity.ts), which differed only in tenant/path/client/surface —
 * one launcher (claude/codex/omp/reasonix) per agent now calls this directly with
 * --tenant instead of each agent needing its own near-duplicate script.
 *
 * Usage: bun fetch-identity-cache.ts --tenant <name> [--client-id <id>]
 *        [--surface-id <id>] [--target-path <path>] [--force]
 */
import { mkdirSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fetchIdentityProjection } from "./fetch-projection.ts";

export const STALE_MS = 30 * 60 * 1000;

export interface CacheArgs {
  tenant: string;
  clientId: string;
  surfaceId: string;
  targetPath: string;
  force: boolean;
}

export function parseArgs(argv: string[]): CacheArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tenant = flag("tenant");
  if (!tenant) throw new Error("--tenant is required");
  return {
    tenant,
    clientId: flag("client-id") ?? tenant,
    surfaceId: flag("surface-id") ?? `${tenant}-cache`,
    targetPath: flag("target-path") ?? join(homedir(), ".agent-runtime", tenant, "CORE_IDENTITY.md"),
    force: argv.includes("--force"),
  };
}

export function isStale(targetPath: string, now: number, force: boolean): { stale: boolean; cacheAgeMs?: number } {
  if (force) return { stale: true };
  if (!existsSync(targetPath)) return { stale: true };
  const { mtimeMs, size } = statSync(targetPath);
  if (size === 0) return { stale: true };
  const cacheAgeMs = now - mtimeMs;
  return { stale: cacheAgeMs >= STALE_MS, cacheAgeMs };
}

/** Write via a temp file in the same directory so a concurrent reader never sees a half-written cache. */
export function writeCacheAtomic(targetPath: string, text: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, text);
    renameSync(tmpPath, targetPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const { stale, cacheAgeMs } = isStale(args.targetPath, Date.now(), args.force);
  if (!stale) {
    console.log(JSON.stringify({ ok: true, rebuilt: false, path: args.targetPath, cacheAgeMs }));
    process.exit(0);
  }

  const runtimeUrl = Bun.env.IDENTITY_RUNTIME_URL ?? "http://127.0.0.1:13541";
  const projection = await fetchIdentityProjection({
    origin: runtimeUrl,
    tenant: args.tenant,
    clientId: args.clientId,
    surfaceId: args.surfaceId,
    message: `Fetch ${args.tenant} identity projection for ${args.surfaceId}.`,
  });

  writeCacheAtomic(args.targetPath, projection);
  console.log(JSON.stringify({ ok: true, rebuilt: true, path: args.targetPath, projectionChars: projection.length }));
}
