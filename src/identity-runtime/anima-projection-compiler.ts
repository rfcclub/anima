import { createHash } from "node:crypto";
import {
  assertProjectionCompileRequest,
  canonicalJson,
  type LockedScope,
  type ProjectionCompileRequest,
  type ProjectionCompiler,
} from "@anima/continuity-core";
import type { RuntimeProjection } from "./contract/runtime-projection.ts";
import { buildSystemPrompt, buildSystemPromptFromPlan, injectIdentityAnchor } from "../agents/prompter";
import type { LoadedAgent } from "../agents/loader";
import { realCartridgePolicies } from "../agents/incarnation-adapter";
import { resolveExecutionPlan } from "../cartridge/activation";
import { CartridgeLoader } from "../cartridge/loader";
import type { CartridgeEntry, CartridgeRegistry } from "../cartridge/registry";
import { executeRetrievalPlan } from "../cartridge/retrieval";
import type { ExecutionPlan, RetrievedMemory } from "../cartridge/types";
import { produceIdentitySummary, tierSoul } from "../identity/engine";
import { DEFAULT_WRITE_SCOPES } from "../memory/scoped-store";
import type { MemoryAdapter } from "../memory/adapter";
import { NullMemoryAdapter } from "../memory/null-adapter";
import type { SessionStore } from "../memory/session-store";
import { DefaultPromptAssembler } from "../substrate/default-prompt-assembler";
import type { SubstrateView } from "../substrate/substrate-view";
import { buildCurrentIdentitySummary } from "./current-identity-summary";

/** Token budget for the substrate section of the compiled prompt when an agent does not set its own. */
const DEFAULT_SUBSTRATE_VIEW_TOKENS = 2_000;

type CartridgeRegistryReader = Pick<CartridgeRegistry, "list" | "expand">;

export interface AnimaProjectionCompilerOptions {
  /** Immutable agent material loaded before a turn begins. */
  agent: LoadedAgent;
  cartridgeRegistry?: CartridgeRegistryReader;
  cartridgeLoader?: CartridgeLoader;
  /** Event history is an explicit read input, never appended to by compilation. */
  recentEvents?: unknown[];
  /** Invocation-scoped read port; it must not be recovered from AgentSession. */
  memoryAdapter?: MemoryAdapter;
  memoryRecall?: { sessionStore?: SessionStore; sessionId?: string };
}

/**
 * Service-facing composition seam. It intentionally returns the existing
 * compiler so ANIMA's in-process and future ContinuityService paths share one
 * canonical projection implementation.
 */
export function createAnimaProjectionCompiler(
  options: AnimaProjectionCompilerOptions,
): AnimaProjectionCompiler {
  return new AnimaProjectionCompiler(options);
}

interface CartridgeConfig {
  universal?: string[];
  defaults?: string[];
  defaultRole?: string;
  selfSelect?: string;
  budgetTokens?: number;
}

/**
 * ANIMA's first canonical projection-composition adapter.
 *
 * It has no provider, store, lease, event logger, or session reference. Any
 * unavailable dependency required by the loaded configuration rejects instead
 * of falling back to a partial prompt.
 */
export class AnimaProjectionCompiler implements ProjectionCompiler<RuntimeProjection> {
  constructor(private readonly options: AnimaProjectionCompilerOptions) {}

  async compile(request: ProjectionCompileRequest): Promise<RuntimeProjection> {
    assertProjectionCompileRequest(request);
    const { agent } = this.options;
    if (request.identity !== agent.name) {
      throw new Error("projection identity does not match loaded identity");
    }
    if (!agent.soulContent?.trim()) throw new Error("loaded soul content is required");
    if (!agent.geneContent.trim()) throw new Error("loaded gene content is required");
    if (!Array.isArray(agent.sessionContextFiles)) throw new Error("loaded boot context is required");

    const cartridges = (agent.config as { cartridges?: CartridgeConfig }).cartridges ?? {};
    const requiresExecutionPlan = Boolean(
      cartridges.universal?.length || cartridges.defaults?.length || cartridges.defaultRole,
    );
    const { executionPlan, entries } = await this.resolveExecutionPlan(request, cartridges, requiresExecutionPlan);
    if (!agent.substrateAdapter || !agent.substrateViewLayer) {
      throw new Error("substrate adapter and view layer must be configured together");
    }
    const tiered = tierSoul(agent.soulContent);
    const identitySummary = produceIdentitySummary(tiered, 800);
    const currentIdentitySummary = await buildCurrentIdentitySummary(agent.substrateAdapter, tiered, 800);

    let trustedMemories: RetrievedMemory[] = [];
    let unverifiedMemories: RetrievedMemory[] = [];
    if (executionPlan?.substrateRetrievalPlan) {
      const retrieval = await executeRetrievalPlan(
        executionPlan.substrateRetrievalPlan,
        request.message,
        (this.options.memoryAdapter ?? agent.memoryAdapter ?? new NullMemoryAdapter()) as unknown as import("../cartridge/retrieval").MemoryAdapter,
        agent.config.memory?.topK ?? 5,
      );
      trustedMemories = retrieval.memories.filter((memory) => memory.trusted);
      unverifiedMemories = retrieval.memories.filter((memory) => !memory.trusted);
    }

    const prompt = executionPlan
      ? buildSystemPromptFromPlan(agent, executionPlan, {
        mode: request.mode,
        recentEvents: this.options.recentEvents ?? [],
        identitySummary,
        currentIdentitySummary,
        trustedMemories,
        unverifiedMemories,
      })
      : buildSystemPrompt(agent, {
        mode: request.mode,
        recentEvents: this.options.recentEvents ?? [],
        currentIdentitySummary,
      });

    const substrateView = await this.buildSubstrateView(executionPlan);
    const withSubstrate = this.appendSubstrateView(prompt.full, substrateView);
    const withHostContext = appendHostContext(withSubstrate, request.hostContext);
    const withGenericRecall = await this.appendGenericRecall(withHostContext, request);
    const system = injectIdentityAnchor(withGenericRecall, agent);

    return {
      prompt: system,
      promptStaticHash: prompt.staticHash,
      kernelVersion: sha256(`${agent.soulContent}\n${agent.geneContent}`),
      cartridgeVersions: cartridgeVersions(executionPlan),
      substrateViewVersion: substrateViewVersion(substrateView),
      // Substrate-view scopes and memory scopes have no canonical mapping yet;
      // returning no read scope is fail-closed rather than widening recall.
      readScopes: [],
      writeScopes: writeScopes(executionPlan, entries),
      proposalScopes: [] as LockedScope[],
      declaredSubstrateScopes: [],
      scopeDeclarationStatus: "unimplemented",
    };
  }

  private async resolveExecutionPlan(
    request: ProjectionCompileRequest,
    cartridges: CartridgeConfig,
    required: boolean,
  ): Promise<{ executionPlan: ExecutionPlan | null; entries: CartridgeEntry[] }> {
    if (!required) return { executionPlan: null, entries: [] };
    if (!this.options.cartridgeRegistry || !this.options.cartridgeLoader) {
      throw new Error("cartridge composition dependencies are required");
    }
    const entries = await this.options.cartridgeRegistry.list(request.identity);
    const executionPlan = await resolveExecutionPlan(
      this.options.cartridgeRegistry as CartridgeRegistry,
      this.options.cartridgeLoader,
      entries,
      {
        mode: request.mode,
        message: request.message,
        identity: request.identity,
        selfSelect: cartridges.selfSelect,
        defaultRole: cartridges.defaultRole,
        defaults: cartridges.defaults,
        universal: cartridges.universal,
        budgetTokens: cartridges.budgetTokens,
        cartridgeOverride: request.cartridgeOverride,
        recentTasks: recentTasksFromEvents(this.options.recentEvents ?? []),
      },
    );
    return { executionPlan, entries };
  }

  private async buildSubstrateView(executionPlan: ExecutionPlan | null): Promise<SubstrateView | undefined> {
    const { agent } = this.options;
    if (!agent.substrateAdapter && !agent.substrateViewLayer) return undefined;
    if (!agent.substrateAdapter || !agent.substrateViewLayer) {
      throw new Error("substrate adapter and view layer must be configured together");
    }
    return agent.substrateViewLayer.buildView({
      adapter: agent.substrateAdapter,
      agentDefaults: { agentId: agent.name },
      cartridgePolicies: realCartridgePolicies(executionPlan),
      maxTokens: agent.config.session.compactThreshold,
    });
  }

  private appendSubstrateView(system: string, view: SubstrateView | undefined): string {
    if (!view) return system;
    const promptContext = new DefaultPromptAssembler().assemble(view, {
      maxTokens: this.options.agent.config.session.substrateViewMaxTokens ?? DEFAULT_SUBSTRATE_VIEW_TOKENS,
      reserveScopes: view.turnContext.runtimeRequiredScopes,
      format: "markdown",
    });
    if (promptContext.blocks.length === 0) return system;
    const section = promptContext.blocks
      .map((block) => `## ${block.label}\n\n${block.content}`)
      .join("\n\n");
    return `${system}\n\n${section}`;
  }

  private async appendGenericRecall(system: string, request: ProjectionCompileRequest): Promise<string> {
    const { agent } = this.options;
    const adapter = this.options.memoryAdapter ?? agent.memoryAdapter ?? new NullMemoryAdapter();
    const recalled = await adapter.recall(request.message, {
      namespace: agent.name,
      topK: agent.config.memory?.topK ?? 5,
      mode: agent.config.memory?.recallMode,
      recentDays: agent.config.memory?.recentDays,
      sessionStore: this.options.memoryRecall?.sessionStore,
      sessionId: this.options.memoryRecall?.sessionId,
    });
    if (recalled.length === 0) return system;
    return `${system}\n\n[Memory Context]\n${recalled.map((entry) => `- ${entry.content}`).join("\n")}`;
  }
}

function writeScopes(plan: ExecutionPlan | null, entries: CartridgeEntry[]): RuntimeProjection["writeScopes"] {
  if (!plan) return [...DEFAULT_WRITE_SCOPES];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const active = [plan.interactionPersona, plan.workingRole, plan.task]
    .filter((block): block is NonNullable<typeof block> => Boolean(block))
    .map((block) => byName.get(block.name)?.memory)
    .filter((policy): policy is NonNullable<typeof policy> => Boolean(policy));
  if (active.length === 0) return [...DEFAULT_WRITE_SCOPES];
  return active[0].writeScopes.filter((scope) => active.slice(1).every((policy) => policy.writeScopes.includes(scope)));
}

function cartridgeVersions(plan: ExecutionPlan | null): Record<string, string> {
  if (!plan) return {};
  const blocks = [
    plan.interactionPersona,
    plan.workingRole,
    plan.task,
    plan.language,
    plan.framework,
    plan.project,
    ...plan.universal,
    ...plan.dependencies,
  ].filter((block): block is NonNullable<typeof block> => Boolean(block));
  return Object.fromEntries(blocks.map((block) => [block.name, sha256(block.content)]));
}

function substrateViewVersion(view: SubstrateView | undefined): string {
  const tuples = (view?.results ?? [])
    .map((result) => ({ relativePath: result.relativePath, trust: result.trust, weight: result.weight }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return sha256(canonicalJson(tuples));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function appendHostContext(system: string, context: readonly string[] | undefined): string {
  const sections = context?.map((section) => section.trim()).filter(Boolean) ?? [];
  return sections.length > 0 ? `${system}\n\n${sections.join("\n\n")}` : system;
}

function recentTasksFromEvents(events: unknown[]): string[] {
  const tasks: string[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const value = event as Record<string, unknown>;
    if (value.type === "cartridge_activated" && value.kind === "task" && typeof value.name === "string") {
      tasks.push(value.name);
    }
  }
  return tasks;
}
