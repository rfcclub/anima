import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { AgentLoader } from "../agents/loader";
import { defaultContinuityDbPath } from "../memory/continuity-adapter";
import { createAgentMemoryStore } from "../memory/store-registry";
import { RuntimeEventStore } from "./contract/runtime-events.ts";
import { readBrunoCoreIdentityProjection, type BrunoCoreIdentityPaths } from "./bruno-core-identity-compiler";
import { AnimaContinuityService, type AnimaContinuityServiceOptions } from "./continuity-service";
import { idempotentRemember } from "./idempotent-remember";
import { ProjectionGrantStore } from "./projection-grant-store";

function brunoCoreIdentityPaths(): BrunoCoreIdentityPaths {
  return {
    substrateRoot: Bun.env.BRUNO_SUBSTRATE_ROOT ?? `${homedir()}/substrate`,
    identityRuntimeRoot: Bun.env.BRUNO_IDENTITY_RUNTIME_ROOT,
  };
}

export interface CreateBrunoContinuityServiceOptions {
  roomsDir: string;
  continuityDbPath?: string;
  readRoom?: AnimaContinuityServiceOptions["readRoom"];
  commitRoom?: AnimaContinuityServiceOptions["commitRoom"];
  /** Test seam; defaults to the real ~/substrate paths. */
  coreIdentityPaths?: BrunoCoreIdentityPaths;
}

/**
 * ANIMA composition root for Bruno's canonical ContinuityService — mirrors
 * createEliContinuityService (eli-continuity-service.ts) exactly: ANIMA
 * owns the canonical compile (readBrunoCoreIdentityProjection, the static
 * SOUL + IDENTITY_IMMEDIATE artifact path) and the canonical write (the
 * real BrunoEntityAdapter store from createAgentMemoryStore). The raw
 * memory store is constructed and retained here; it is never passed to
 * the bruno-runtime process.
 *
 * Divergence from the Eli mirror, deliberate and documented:
 * - no AnimaProjectionCompiler construction at all — Eli constructs one
 *   but never calls it (leftover from its own pre-static-path design,
 *   see the archived 2026-07-30-core-identity-immediate-compiler change,
 *   D2); Bruno's factory omits the dead construction.
 * - no core-identity watcher — the compiled file's only consumer is
 *   compileProjection itself, which recompiles synchronously on staleness
 *   (eli's watcher exists to keep a symlinked file fresh for other
 *   CLI-script consumers; Bruno's design has no symlink).
 */
export async function createBrunoContinuityService(
  options: CreateBrunoContinuityServiceOptions,
): Promise<AnimaContinuityService> {
  const agent = await new AgentLoader({ roomsDir: options.roomsDir }).load("bruno");
  const rawStore = await createAgentMemoryStore(agent.config, agent.roomDir);
  if (!rawStore) throw new Error("Bruno canonical memory store is unavailable");

  const dbPath = options.continuityDbPath ?? defaultContinuityDbPath(agent.name);
  const grantStore = new ProjectionGrantStore(dbPath);
  const events = new RuntimeEventStore(dbPath);

  const stateHash = () => hash(`${agent.name}:${events.revision(agent.name)}`);
  return new AnimaContinuityService({
    identity: agent.name,
    readRoom: options.readRoom,
    commitRoom: options.commitRoom,
    grantStore,
    compileProjection: () => readBrunoCoreIdentityProjection(options.coreIdentityPaths ?? brunoCoreIdentityPaths()),
    canonicalStateHash: stateHash,
    claimCurrentState: (candidate) => {
      const revision = events.revision(agent.name);
      if (candidate !== hash(`${agent.name}:${revision}`) || !events.advanceRevision(agent.name, revision)) {
        return undefined;
      }
      return { rollback: () => { events.rollbackRevision(agent.name, revision); } };
    },
    remember: idempotentRemember(rawStore),
    recall: async ({ query }, scopes) => rawStore.recall(query, { scopes: [...scopes] }),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
