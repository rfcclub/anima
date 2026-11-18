import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry } from "../cartridge/registry";
import { AgentLoader } from "../agents/loader";
import { defaultContinuityDbPath } from "../memory/continuity-adapter";
import { createAgentMemoryStore } from "../memory/store-registry";
import { RuntimeEventStore } from "./contract/runtime-events.ts";
import { createAnimaProjectionCompiler } from "./anima-projection-compiler";
import { compileCoreIdentity, readCoreIdentityProjection, type CoreIdentityPaths } from "./core-identity-compiler";
import { startCoreIdentityWatcher } from "./core-identity-watcher";
import { AnimaContinuityService, type AnimaContinuityServiceOptions } from "./continuity-service";
import { storeDirectRecall } from "./direct-recall";
import { idempotentRemember } from "./idempotent-remember";
import { ProjectionGrantStore } from "./projection-grant-store";

function coreIdentityPaths(): CoreIdentityPaths {
  return {
    agoraRoot: Bun.env.ELI_AGORA_ROOT ?? `${homedir()}/agora/familia/eli`,
    cacheDir: Bun.env.ELI_IDENTITY_CACHE_DIR ?? `${homedir()}/agora/familia/eli/identityCache`,
  };
}

export interface CreateEliContinuityServiceOptions {
  roomsDir: string;
  projectRoot?: string;
  continuityDbPath?: string;
  readRoom?: AnimaContinuityServiceOptions["readRoom"];
  commitRoom?: AnimaContinuityServiceOptions["commitRoom"];
}

/**
 * ANIMA composition root for Eli's canonical ContinuityService. The raw
 * memory store is constructed and retained here; it is never passed to the
 * eli-runtime process.
 */
export async function createEliContinuityService(
  options: CreateEliContinuityServiceOptions,
): Promise<AnimaContinuityService> {
  const agent = await new AgentLoader({ roomsDir: options.roomsDir }).load("eli");
  const rawStore = await createAgentMemoryStore(agent.config, agent.roomDir);
  if (!rawStore) throw new Error("Eli canonical memory store is unavailable");

  const dbPath = options.continuityDbPath ?? defaultContinuityDbPath(agent.name);
  const grantStore = new ProjectionGrantStore(dbPath);
  const events = new RuntimeEventStore(dbPath);
  const compiler = createAnimaProjectionCompiler({
    agent,
    cartridgeRegistry: new CartridgeRegistry({ projectRoot: options.projectRoot ?? resolve(options.roomsDir, "..") }),
    cartridgeLoader: new CartridgeLoader(),
  });

  startCoreIdentityWatcher(coreIdentityPaths(), { compile: compileCoreIdentity });

  const stateHash = () => hash(`${agent.name}:${events.revision(agent.name)}`);
  return new AnimaContinuityService({
    identity: agent.name,
    readRoom: options.readRoom,
    commitRoom: options.commitRoom,
    grantStore,
    compileProjection: (intent) => readCoreIdentityProjection(coreIdentityPaths()) as unknown as ReturnType<typeof compiler.compile>,
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
    directRecall: storeDirectRecall(rawStore, "eli_memory"),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
