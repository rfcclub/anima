import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry } from "../cartridge/registry";
import { AgentLoader } from "../agents/loader";
import { defaultContinuityDbPath } from "../memory/continuity-adapter";
import { createAgentMemoryStore } from "../memory/store-registry";
import { RuntimeEventStore } from "./contract/runtime-events.ts";
import { createAnimaProjectionCompiler } from "./anima-projection-compiler";
import { AnimaContinuityService, type AnimaContinuityServiceOptions } from "./continuity-service";
import { storeDirectRecall } from "./direct-recall";
import { idempotentRemember } from "./idempotent-remember";
import { ProjectionGrantStore } from "./projection-grant-store";

export interface CreateAgentContinuityServiceOptions {
  /** Live roster id (`abel`, whom owner also calls Quin). */
  agentId: string;
  roomsDir: string;
  projectRoot?: string;
  continuityDbPath?: string;
  readRoom?: AnimaContinuityServiceOptions["readRoom"];
  commitRoom?: AnimaContinuityServiceOptions["commitRoom"];
}

/**
 * ANIMA composition root for an identity that has no bespoke static core file
 * (Bruno and Eli have their own). Compiles through the same
 * AnimaProjectionCompiler Town's identity-runtime opt-in uses and writes/reads
 * through the agent's own canonical store, which is never handed to the runtime process.
 */
export async function createAgentContinuityService(
  options: CreateAgentContinuityServiceOptions,
): Promise<AnimaContinuityService> {
  const agent = await new AgentLoader({ roomsDir: options.roomsDir }).load(options.agentId);
  const rawStore = await createAgentMemoryStore(agent.config, agent.roomDir);
  if (!rawStore) throw new Error(`${options.agentId} canonical memory store is unavailable`);

  const dbPath = options.continuityDbPath ?? defaultContinuityDbPath(agent.name);
  const grantStore = new ProjectionGrantStore(dbPath);
  const events = new RuntimeEventStore(dbPath);
  const compiler = createAnimaProjectionCompiler({
    agent,
    cartridgeRegistry: new CartridgeRegistry({ projectRoot: options.projectRoot ?? resolve(options.roomsDir, "..") }),
    cartridgeLoader: new CartridgeLoader(),
  });

  const stateHash = () => hash(`${agent.name}:${events.revision(agent.name)}`);
  return new AnimaContinuityService({
    identity: agent.name,
    readRoom: options.readRoom,
    commitRoom: options.commitRoom,
    grantStore,
    compileProjection: (intent) => compiler.compile({
      identity: agent.name,
      surfaceId: intent.surfaceId,
      mode: "plan",
      message: intent.message,
      cartridgeOverride: intent.cartridgeOverride,
      hostContext: intent.hostContext,
    }),
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
    directRecall: storeDirectRecall(rawStore, `${agent.name}_memory`),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
