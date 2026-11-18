/**
 * Identity half of `agent-loader`: for one roster agent and one harness, make sure a fresh
 * identity projection is cached on disk and print its path. Fail closed — any problem throws a
 * LoaderError with an exit code and nothing is printed. The launching (exec) half is
 * agent-loader.sh; Bun has no exec(2), so a TypeScript process cannot replace itself with the host.
 *
 * Usage: bun agent-loader.ts prepare --agent <id> --harness <name> [--force]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isTenantId, readRosterAgentIds, resolveColonyPath } from "../../packages/identity-runtime/src/roster.ts";
import { isStale, writeCacheAtomic } from "./fetch-identity-cache.ts";
import { fetchIdentityProjection, type ProjectionFetcher } from "./fetch-projection.ts";

export const EXIT_USAGE = 64;
export const EXIT_FETCH = 69;
export const EXIT_WRITE = 73;
export const FETCH_TIMEOUT_MS = 10_000;

export class LoaderError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

interface Surface {
  clientId: string;
  surfaceId: (agent: string) => string;
}

/** Per-harness caller identity. Values match what the existing launchers send today. */
export const SURFACES: Record<string, Surface> = {
  claude: { clientId: "claude", surfaceId: (agent) => `claudia-${agent}` },
  codex: { clientId: "codex", surfaceId: (agent) => `codex-${agent}` },
  omp: { clientId: "omp", surfaceId: (agent) => `${agent}-omp` },
  reasonix: { clientId: "reasonix", surfaceId: (agent) => `reasonix-${agent}` },
};

export interface PrepareOptions {
  agent: string;
  harness: string;
  force: boolean;
  origin: string;
  home: string;
  /** Roster files, first existing wins. None existing means the runtime's join is the authority. */
  rosterCandidates: string[];
  fetcher?: ProjectionFetcher;
  timeoutMs?: number;
}

function withTimeout(base: ProjectionFetcher, timeoutMs: number): ProjectionFetcher {
  return (url, init) => base(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function rosterCandidates(repoRoot: string, home: string = homedir()): string[] {
  return [join(home, ".anima", "data", "colony.json"), join(repoRoot, "data", "colony.json")];
}

/** Returns the absolute path of the agent's cached identity file, refreshed if needed. */
export async function prepareIdentity(options: PrepareOptions): Promise<string> {
  const { agent, harness } = options;
  if (!Object.hasOwn(SURFACES, harness)) {
    throw new LoaderError(
      EXIT_USAGE,
      `agent-loader: unsupported harness '${harness}' (supported: ${Object.keys(SURFACES).join(", ")})`,
    );
  }
  const surface = SURFACES[harness]!;

  if (!isTenantId(agent)) {
    throw new LoaderError(EXIT_USAGE, `agent-loader: unknown agent '${agent}'`);
  }
  const rosterPath = resolveColonyPath({ candidates: options.rosterCandidates });
  if (rosterPath && !readRosterAgentIds(rosterPath).includes(agent)) {
    throw new LoaderError(EXIT_USAGE, `agent-loader: unknown agent '${agent}' (not in ${rosterPath})`);
  }

  const target = join(options.home, ".agent-runtime", agent, "CORE_IDENTITY.md");
  if (!isStale(target, Date.now(), options.force).stale) return target;

  const surfaceId = surface.surfaceId(agent);
  let projection: string;
  try {
    projection = await fetchIdentityProjection({
      origin: options.origin,
      tenant: agent,
      clientId: surface.clientId,
      surfaceId,
      message: `Fetch ${agent} identity projection for ${surfaceId}.`,
      fetcher: withTimeout(options.fetcher ?? ((url, init) => fetch(url, init)), options.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LoaderError(EXIT_FETCH, `agent-loader: ${agent}: identity fetch failed: ${describe(error)}`);
  }

  try {
    writeCacheAtomic(target, projection);
  } catch (error) {
    throw new LoaderError(EXIT_WRITE, `agent-loader: ${agent}: cannot write ${target}: ${describe(error)}`);
  }
  return target;
}

export function parsePrepareArgs(argv: string[]): { agent: string; harness: string; force: boolean } {
  if (argv[0] !== "prepare") throw new LoaderError(EXIT_USAGE, "usage: agent-loader.ts prepare --agent <id> --harness <name> [--force]");
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const agent = flag("agent");
  const harness = flag("harness");
  if (!agent || !harness) throw new LoaderError(EXIT_USAGE, "agent-loader: --agent and --harness are required");
  return { agent, harness, force: argv.includes("--force") };
}

if (import.meta.main) {
  try {
    const args = parsePrepareArgs(Bun.argv.slice(2));
    const path = await prepareIdentity({
      ...args,
      origin: Bun.env.IDENTITY_RUNTIME_URL ?? "http://127.0.0.1:13541",
      home: homedir(),
      rosterCandidates: rosterCandidates(resolve(import.meta.dir, "..", "..")),
    });
    process.stdout.write(`${path}\n`);
  } catch (error) {
    if (!(error instanceof LoaderError)) throw error;
    console.error(error.message);
    process.exit(error.code);
  }
}
