import type { WebChatClient } from "../web-chat/client";
import { webChatRuntime } from "../web-chat/host";
import { currentToolBoundary } from "../web-chat/tool-boundary";
import { randomUUID } from "node:crypto";
import { createAutoGuard, type AutoGuard } from "./auto-guard";
import { TurnRunner, type TurnContext } from "./turn-runner";
import { buildSystemPrompt, buildSystemPromptFromPlan, injectIdentityAnchor } from "./prompter";
import { tierSoul, produceIdentitySummary } from "../identity/engine";
import type { LoadedAgent } from "./loader";
import type { PermissionMode } from "../config/types";
import type { McpServerConfig } from "../config/types";
import type { MemoryAdapter } from "../memory/adapter";
import { NullMemoryAdapter } from "../memory/null-adapter";
import type { SessionStore } from "../memory/session-store";
import type { ThreadStore } from "../memory/thread-store";
import type { JsonlEvent, Store } from "../memory/jsonl-store";
import type { Provider, ProviderChunk, ProviderMessage, ProviderResponse, ProviderTool, ProviderToolDefinition } from "../providers/interface";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry } from "../cartridge/registry";
import { executeRetrievalPlan } from "../cartridge/retrieval";
import type { RetrievedMemory } from "../cartridge/types";
import type { EvaluationPipeline, EvalOutput } from "../evaluation/pipeline";
import type { TrustDomain } from "../evaluation/trust-system";
import { buildToolDefinitions } from "../tools/definitions";
import { McpManager } from "../mcp/manager";
import { resolveActivation, resolveExecutionPlan } from "../cartridge/activation";
import { guardMemoryStore, DEFAULT_WRITE_SCOPES } from "../memory/scoped-store";
import type { ScopedMemoryStore } from "../memory/scoped-store";
import { DefaultPromptAssembler } from "../substrate/default-prompt-assembler";
import type { SubstrateView } from "../substrate/substrate-view";
import { mintForTurn, ManifestLogger, defaultManifestLogDbPath } from "./manifest-logger";
import { realCartridgePolicies } from "./incarnation-adapter";
import type { ProjectionManifest } from "@anima/continuity-core";
import { joinAnimaIdentityRuntime, type IdentityRuntimeJoinClient } from "../identity-runtime/anima-adapter";
import { buildCurrentIdentitySummary as readCurrentIdentitySummary } from "../identity-runtime/current-identity-summary";
import { AnimaProjectionCompiler } from "../identity-runtime/anima-projection-compiler";

// ── Context Engine integration (Phase 3) ──────────
import type { ContextEngine } from "@anima/context-engine";

// ── Memory store (Phase 3b) ────────────────────────
import type { AgentMemoryStore } from "../memory/contract";
import { estimateTokens } from "../utils/tokens";
import { priorSummaryMessages } from "../session/castle-compaction";

const MAX_TOOL_ITERATIONS = 64;
/** Estimated tokens of prior history a turn sends; older messages stay stored but are not sent (rfcclub/anima#125). */
export const PRIOR_HISTORY_TOKEN_BUDGET = 30_000;

type LogFields = Record<string, unknown>;

function messageTokens(message: ProviderMessage): number {
  return estimateTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

/**
 * The newest prior messages within PRIOR_HISTORY_TOKEN_BUDGET, in order. The newest exchange (the last user
 * message and everything after it) is always kept whole, even past the budget. After a cut, the kept part
 * starts with a user message.
 */
function trimPriorHistory(prior: ProviderMessage[], budget = PRIOR_HISTORY_TOKEN_BUDGET): { messages: ProviderMessage[]; estimatedTokens: number } {
  let lastUser = prior.length;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i]!.role === "user") { lastUser = i; break; }
  }
  let start = lastUser;
  let total = prior.slice(lastUser).reduce((sum, message) => sum + messageTokens(message), 0);
  for (let i = lastUser - 1; i >= 0; i--) {
    const tokens = messageTokens(prior[i]!);
    if (total + tokens > budget) break;
    total += tokens;
    start = i;
  }
  if (start > 0) {
    while (start < lastUser && prior[start]!.role === "assistant") {
      total -= messageTokens(prior[start]!);
      start++;
    }
  }
  return { messages: prior.slice(start), estimatedTokens: total };
}

type McpManagerLike = {
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  getTools(): ProviderTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
};

export interface AgentSessionOptions {
  webChatClient?: WebChatClient;
  store: Store;
  provider: Provider;
  cartridgeLoader?: CartridgeLoader;
  cartridgeRegistry?: CartridgeRegistry;
  evaluationPipeline?: EvaluationPipeline;
  mcpManagerFactory?: (configs: McpServerConfig[]) => McpManagerLike;
  log?: (level: "info" | "error", msg: string, fields?: LogFields) => void;
}

export interface RunAgentSessionOptions {
  agent: LoadedAgent;
  message: string;
  /** Aborts the turn: passed to every provider call, and no further call or tool run starts once it is aborted. */
  signal?: AbortSignal;
  /** Override the model from agent config at runtime. */
  modelOverride?: string;
  mode?: PermissionMode;
  sessionId?: string;
  recentEventCount?: number;
  channelId?: string;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  cartridgeOverride?: string | null;
  lifecycleContext?: string;
  /** Phase 3: DAG context engine for conversation continuity. */
  contextEngine?: ContextEngine;
  /** Phase 3: Conversation ID for the context engine (shared across turns). */
  contextConversationId?: string;
  /** Phase 3b: Per-agent memory store for explicit anima_* tool calls. */
  memoryStore?: AgentMemoryStore;
  /** Optional base64 image data URL to inject into the user message. */
  imageData?: string;
  /** Prior turns for this session, oldest first — prepended to the new message. */
  priorMessages?: ProviderMessage[];
  /** Stored summary of the earlier conversation (castle compaction, #127): sent first, never trimmed. */
  priorSummary?: string;
  /** Estimated-token budget for the summary pair plus prior messages; default PRIOR_HISTORY_TOKEN_BUDGET. */
  priorHistoryTokenBudget?: number;
  /**
   * runStream only: offer no tools, start no MCP servers, and neither yield nor
   * execute a tool call the provider returns anyway. Used by the remote talk
   * listener, whose caller is outside this machine's trust domain.
   */
  disableTools?: boolean;
  /** Phase 0 (`continuity-ports`): which peer surface is joining (cc | anima | openclaw | ...). Default "anima". */
  surfaceId?: string;
  /** Phase 0 (`continuity-ports`): minted once per run()/runStream() call, before prepareTurn(). Internal. */
  turnId?: string;
  /** Phase 0 (`continuity-ports`): overrides the per-agent continuity.db path. Tests only — defaults to `~/.anima/agents/<agent>/continuity.db`. */
  continuityDbPath?: string;
  /** Opt-in remote runtime client. The ANIMA surface never receives the authority or raw store. */
  identityRuntime?: IdentityRuntimeJoinClient;
}

export interface AgentSessionResult {
  sessionId: string;
  response: ProviderResponse;
}

interface PreparedTurnContext {
  sessionId: string;
  mode: PermissionMode;
  system: string;
  staticPrefix: string;
  staticHash: string;
  messages: ProviderMessage[];
  memoryStore: AgentMemoryStore | undefined;
  adapter: MemoryAdapter;
  mcpManager: McpManagerLike | undefined;
  autoGuard: AutoGuard | undefined;
  tools: Array<ProviderToolDefinition | ProviderTool>;
  /** Phase 0 (`continuity-ports`): present only when `continuity.incarnationPort` is on. */
  manifest?: ProjectionManifest;
  leaseId?: string;
}

export class AutoModeNotEnabledError extends Error {
  constructor(agent: string) {
    super(`auto mode not enabled for this agent: ${agent}`);
    this.name = "AutoModeNotEnabledError";
  }
}

/**
 * AgentSession — runs a single message through the provider's tool-use loop.
 *
 * This is the core execution engine for an agent turn. It builds the system
 * prompt from the LoadedAgent (including cartridges, memory context, identity
 * anchors), invokes the provider with tools (built-in + MCP), executes tool
 * calls in a loop (up to 64 iterations), gates memory writes through the
 * evaluation pipeline, and logs every event to the JSONL store. Both manual
 * and auto permission modes are supported.
 */
export class AgentSession {
  private static activeSet = new Set<string>();
  private static endListeners = new Map<string, Array<() => void>>();

  static isActive(agentId: string): boolean {
    return AgentSession.activeSet.has(agentId);
  }

  static onSessionEnd(agentId: string, cb: () => void): void {
    const list = AgentSession.endListeners.get(agentId) ?? [];
    list.push(cb);
    AgentSession.endListeners.set(agentId, list);
  }

  static notifySessionEnd(agentId: string): void {
    const listeners = AgentSession.endListeners.get(agentId);
    if (listeners) {
      for (const cb of listeners) cb();
      AgentSession.endListeners.delete(agentId);
    }
  }
  private readonly store: Store;
  private readonly provider: Provider;
  private readonly cartridgeLoader?: CartridgeLoader;
  private readonly cartridgeRegistry?: CartridgeRegistry;
  private readonly evaluationPipeline?: EvaluationPipeline;
  private readonly webChatClient?: WebChatClient;
  private readonly mcpManagerFactory: (configs: McpServerConfig[]) => McpManagerLike;
  private readonly log: (level: "info" | "error", msg: string, fields?: LogFields) => void;
  private sessionEvents: JsonlEvent[] = [];

  constructor(options: AgentSessionOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.webChatClient = options.webChatClient;
    this.cartridgeLoader = options.cartridgeLoader;
    this.cartridgeRegistry = options.cartridgeRegistry;
    this.evaluationPipeline = options.evaluationPipeline;
    this.mcpManagerFactory = options.mcpManagerFactory ?? ((configs) => new McpManager(configs));
    this.log = options.log ?? structuredLog;
  }

  /**
   * Evaluate a high-stakes action through the evaluation pipeline.
   * Call before memory writes, code changes, external sends.
   */
  async evaluateAction(
    agentId: string,
    output: string,
    domain: TrustDomain,
    actionId?: string,
    paths?: string[],
  ): Promise<EvalOutput | null> {
    if (!this.evaluationPipeline) return null;
    return this.evaluationPipeline.evaluate({
      agentId,
      output,
      domain,
      actionId,
      paths,
    });
  }

  async run(options: RunAgentSessionOptions): Promise<AgentSessionResult> {
    const turnId = options.turnId ?? randomUUID();
    const ctx = await this.prepareTurn({ ...options, turnId });
    let outcome: "ok" | "error" = "ok";
    try {
      const response = await this.runToolLoop(this.executionContext(options, ctx));

      const rawResponseText = typeof response.message.content === "string"
        ? response.message.content
        : response.message.content == null
          ? ""
          : JSON.stringify(response.message.content);
      const responseText = this.safetyFallback(rawResponseText, options, ctx.sessionId);

      await this.finalizeTurn(options, ctx, responseText, response.usage);

      return { sessionId: ctx.sessionId, response: { ...response, message: { ...response.message, content: responseText } } };
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      this.recordManifestLog(ctx, turnId, outcome, options.continuityDbPath);
      await ctx.mcpManager?.stop();
      ctx.autoGuard?.complete();
      AgentSession.activeSet.delete(options.agent.name);
      AgentSession.notifySessionEnd(options.agent.name);
    }
  }

  /**
   * Phase 0 (`continuity-ports`) completion-write hook — called exactly once
   * per turn attempt, from the `finally` block in `run()`/`runStream()`.
   * No-op when the continuity flag was off for this turn (ctx.manifest absent).
   */
  private recordManifestLog(
    ctx: PreparedTurnContext,
    turnId: string,
    outcome: "ok" | "error",
    dbPathOverride?: string,
  ): void {
    if (!ctx.manifest) return;
    // This runs from the `finally` block in run()/runStream() — an exception
    // thrown here would supersede the try block's return value or error
    // (standard JS finally semantics), turning a SQLite hiccup in an opt-in
    // provenance log into a fake failure of an otherwise-successful turn.
    // Swallow and log instead (Codex review finding).
    try {
      const logger = new ManifestLogger(dbPathOverride ?? defaultManifestLogDbPath(ctx.manifest.agentId));
      try {
        logger.record(turnId, ctx.manifest, outcome);
      } finally {
        logger.close();
      }
    } catch (err) {
      this.log("error", "manifest_log write failed — turn result unaffected", {
        agent: ctx.manifest.agentId,
        turnId,
        error: String(err),
      });
    }
  }

  /**
   * Streaming variant of `run` — returns an async generator of provider chunks.
   * The caller is responsible for persisting the final text to its own session store.
   */
  async *runStream(options: RunAgentSessionOptions): AsyncGenerator<ProviderChunk> {
    const turnId = options.turnId ?? randomUUID();
    const ctx = await this.prepareTurn({ ...options, turnId });
    let outcome: "ok" | "error" = "ok";
    try {
      let rawResponseText = "";
      let finalUsage: ProviderResponse["usage"];
      const context = this.executionContext(options, ctx);
      context.surface = { kind: "stream", disableTools: options.disableTools };
      for await (const event of new TurnRunner().run(context)) {
        if (event.type === "error") throw event.error;
        if (event.type === "provider-chunk") yield event.chunk;
        if (event.type === "tool-call") yield { type: "tool_call", tool_call: event.call };
        if (event.type === "tools-disabled") {
          this.log("info", "tool calls ignored — tools disabled for this turn", {
            agent: options.agent.name, tools: event.calls.map((call) => call.name),
          });
        }
        if (event.type === "done") {
          rawResponseText = event.response.message.content as string;
          finalUsage = event.response.usage;
        }
      }

      const responseText = this.safetyFallback(rawResponseText, options, ctx.sessionId);
      await this.finalizeTurn(options, ctx, responseText, finalUsage);
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      this.recordManifestLog(ctx, turnId, outcome, options.continuityDbPath);
      await ctx.mcpManager?.stop();
      ctx.autoGuard?.complete();
      AgentSession.activeSet.delete(options.agent.name);
      AgentSession.notifySessionEnd(options.agent.name);
    }
  }

  private executionContext(options: RunAgentSessionOptions, ctx: PreparedTurnContext): TurnContext {
    return {
      provider: this.provider, messages: ctx.messages, tools: ctx.tools,
      policy: options.agent.config.policy, agentName: options.agent.name,
      cwd: options.agent.roomDir, sessionId: ctx.sessionId, mode: ctx.mode,
      model: options.modelOverride ?? options.agent.config.provider.model,
      system: ctx.system, cachePrefix: ctx.staticPrefix, staticHash: ctx.staticHash,
      signal: options.signal, memoryStore: ctx.memoryStore, contextEngine: options.contextEngine,
      webChatClient: this.webChatClient, guard: ctx.autoGuard?.handler, mcpManager: ctx.mcpManager,
      limits: { maxIterations: MAX_TOOL_ITERATIONS },
      onEvent: (event) => {
        if (event.type !== "tool-result" || event.blocked) return;
        this.log("info", "tool executed", {
          agent: options.agent.name, tool: event.call.name,
          iteration: event.iteration, outputLen: event.result.length,
        });
        if (event.call.name.startsWith("anima_") && !event.result.startsWith("Error:") && !event.result.includes('"status":"error"')) {
          this.append(options.agent.name, {
            type: "memory_tool_call" as JsonlEvent["type"],
            sessionId: ctx.sessionId, tool: event.call.name,
          } as unknown as JsonlEvent);
        }
      },
    };
  }

  private recentTasksFromEvents(events: JsonlEvent[]): string[] {
    const tasks: string[] = [];
    for (const event of events) {
      const e = event as unknown as Record<string, unknown>;
      if (e.type === "cartridge_activated" && typeof e.name === "string" && e.kind === "task") {
        tasks.push(e.name);
      }
    }
    return tasks;
  }

  private safetyFallback(rawResponseText: string, options: RunAgentSessionOptions, sessionId: string): string {
    // Strict safety fallback: only trigger on a short, standalone refusal-like message
    // (not a legitimate answer that happens to mention a policy phrase).
    // "kh\u00f4ng \u0111\u01b0\u1ee3c ph\u00e9p" ("not allowed") is a Vietnamese refusal marker (written as \u escapes).
    const refusalMarkers = /high[- ]risk|request was rejected|content policy|safety filter|violates our|kh\u00f4ng \u0111\u01b0\u1ee3c ph\u00e9p/i;
    const standaloneRefusalPrefix = /^(I('m| am)? (unable|sorry|cannot|can't)|Request rejected|I cannot|I'm not able)/i;
    const isSafetyRejection = rawResponseText.length < 300
      && refusalMarkers.test(rawResponseText)
      && (standaloneRefusalPrefix.test(rawResponseText) || rawResponseText.split(/[.!?]/).filter(Boolean).length <= 1);
    if (isSafetyRejection) {
      this.log("error", "safety rejection detected — using fallback", {
        type: "safety_rejection",
        agent: options.agent.name,
        sessionId,
        raw: rawResponseText.slice(0, 120),
      });
      return `*(${options.agent.name} hit a content limit with this message — try asking another way)*`;
    }
    return rawResponseText;
  }

  private async finalizeTurn(
    options: RunAgentSessionOptions,
    ctx: PreparedTurnContext,
    responseText: string,
    usage: ProviderResponse["usage"],
  ): Promise<void> {
    const scopeViolations = (ctx.memoryStore as ScopedMemoryStore | undefined)?.violations?.() ?? [];
    if (scopeViolations.length > 0) {
      this.append(options.agent.name, { type: "memory_scope_violations", sessionId: ctx.sessionId, count: scopeViolations.length, violations: scopeViolations });
    }

    this.append(options.agent.name, {
      type: "assistant_message",
      sessionId: ctx.sessionId,
      mode: ctx.mode,
      body: responseText,
      usage,
    });

    const evalResult = await this.evaluateResponse(options, responseText, ctx.sessionId);
    const shouldAutoApply = !evalResult || evalResult.decision === "auto_apply";

    if (shouldAutoApply) {
      try {
        await ctx.adapter.store({
          namespace: options.agent.name,
          content: `User: ${options.message}\nAssistant: ${responseText}`,
          type: "message",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.log("error", "memory store failed — result still returned", {
          type: "memory_store_error",
          agent: options.agent.name,
          sessionId: ctx.sessionId,
          error: String(err),
        });
      }
    } else {
      this.log("info", "memory store held by evaluation pipeline", {
        type: "eval_held",
        agent: options.agent.name,
        sessionId: ctx.sessionId,
        decision: evalResult?.decision,
      });
    }

    if (options.contextEngine && options.contextConversationId) {
      try {
        await options.contextEngine.ingest({
          conversationId: options.contextConversationId,
          message: {
            id: randomUUID(),
            conversation_id: options.contextConversationId,
            seq: Date.now(),
            role: 'user',
            content: options.message,
            created_at: new Date().toISOString(),
            token_count: Math.ceil(options.message.length / 4),
          },
        });
        await options.contextEngine.ingest({
          conversationId: options.contextConversationId,
          message: {
            id: randomUUID(),
            conversation_id: options.contextConversationId,
            seq: Date.now() + 1,
            role: 'assistant',
            content: responseText,
            created_at: new Date().toISOString(),
            token_count: Math.ceil(responseText.length / 4),
          },
        });
        this.log("info", "context ingested", { conversationId: options.contextConversationId });
      } catch (err) {
        this.log("error", "context ingest failed", { error: String(err) });
      }
    }

    // Always record the exchange in the thread so history matches what the user saw,
    // even when evaluation pipeline holds memory writes.
    if (options.channelId && options.threadStore) {
      options.threadStore.add(options.channelId, options.agent.name, "user", options.message);
      options.threadStore.add(options.channelId, options.agent.name, "assistant", responseText);
    }

    const animaCallEvents = this.sessionEvents.filter(
      (e) => (e as unknown as Record<string, unknown>).type === "memory_tool_call",
    );
    if (ctx.memoryStore && animaCallEvents.length > 0) {
      const toolNames = animaCallEvents.map((e) => (e as unknown as Record<string, unknown>).tool as string).join(", ");
      ctx.memoryStore.remember({
        content: `Session: called ${toolNames}; response length ${responseText.length} chars`,
        scope: "episode",
        confidence: 0.7,
        source: "anima-session",
        tags: ["session", ctx.sessionId],
      }).catch((err) => this.log("error", "on_session_end episode write failed", { error: String(err) }));
    }
  }

  private async prepareTurn(options: RunAgentSessionOptions): Promise<PreparedTurnContext> {
    options.signal?.throwIfAborted();
    try {
      return await this.prepareTurnInner(options);
    } catch (error) {
      if (options.signal?.aborted) {
        AgentSession.activeSet.delete(options.agent.name);
        AgentSession.notifySessionEnd(options.agent.name);
      }
      throw error;
    }
  }

  private async prepareTurnInner(options: RunAgentSessionOptions): Promise<PreparedTurnContext> {
    if (currentToolBoundary() && (this.provider.sharedSafe !== true || (!options.disableTools && options.agent.config.mcp?.servers.length))) {
      throw Error("web chat isolation requires an explicitly safe API carrier without MCP/native tools");
    }
    const agentId = options.agent.name;
    AgentSession.activeSet.add(agentId);
    this.sessionEvents = [];

    const mode = options.mode ?? options.agent.config.session.defaultMode;
    if (mode === "auto" && !options.agent.config.session.autoModeOptIn) {
      throw new AutoModeNotEnabledError(options.agent.name);
    }

    const sessionId = options.sessionId ?? randomUUID();
    const bridge = this.webChatClient ?? webChatRuntime();
    if (bridge && options.agent.config.policy.allowedTools?.includes("anima_web_chat")) {
      const privateBoot = [
        options.agent.geneContent,
        options.agent.soulContent,
        ...options.agent.sessionContextFiles.map(f => f.content),
        ...options.agent.additionalContent.map(f => f.content),
      ].filter((s): s is string => typeof s === "string");
      await bridge.registerPrivateContent({ agent: agentId, session: sessionId }, privateBoot, options.signal);
    }
    const recentEvents = this.store.readRecent(options.agent.name, options.recentEventCount ?? 12);
    const runtimeEnabled = options.agent.config.continuity?.identityRuntime === true;
    const incarnationPortEnabled = Boolean(options.agent.config.continuity?.incarnationPort);
    if (runtimeEnabled && incarnationPortEnabled) {
      throw new Error("identityRuntime and incarnationPort cannot both be enabled");
    }
    let activation: Awaited<ReturnType<typeof resolveActivation>> = { base: [], events: [] };
    let executionPlan: Awaited<ReturnType<typeof resolveExecutionPlan>> | null = null;
    let guardEntry: { name: string; memory?: { writeScopes: import("../memory/contract").MemoryScope[] } } | undefined;

    if (!runtimeEnabled && this.cartridgeLoader && this.cartridgeRegistry) {
      try {
        const allEntries = await this.cartridgeRegistry.list(options.agent.name);
        const cartridgesConfig = (options.agent.config as any).cartridges || {};

        if (!runtimeEnabled && (cartridgesConfig.universal || cartridgesConfig.defaults || cartridgesConfig.defaultRole)) {
          executionPlan = await resolveExecutionPlan(this.cartridgeRegistry, this.cartridgeLoader, allEntries, {
            mode,
            message: options.message,
            identity: options.agent.name,
            selfSelect: cartridgesConfig.selfSelect,
            defaultRole: cartridgesConfig.defaultRole,
            defaults: cartridgesConfig.defaults,
            universal: cartridgesConfig.universal,
            budgetTokens: cartridgesConfig.budgetTokens,
            cartridgeOverride: options.cartridgeOverride,
            recentTasks: this.recentTasksFromEvents(recentEvents),
          });
          for (const event of executionPlan.events) {
            this.append(options.agent.name, { ...event, sessionId } as Record<string, unknown> & { type: string; sessionId: string });
          }
          {
            const planEntryMap = new Map(allEntries.map(e => [e.name, e]));
            const personaMem = executionPlan.interactionPersona ? planEntryMap.get(executionPlan.interactionPersona.name)?.memory : undefined;
            const roleMem = executionPlan.workingRole ? planEntryMap.get(executionPlan.workingRole.name)?.memory : undefined;
            const taskMem = executionPlan.task ? planEntryMap.get(executionPlan.task.name)?.memory : undefined;
            const policies = [personaMem, roleMem, taskMem].filter(Boolean) as Array<{ writeScopes: import("../memory/contract").MemoryScope[] }>;
            if (policies.length > 0) {
              const intersected = policies[0].writeScopes.filter(s => policies.slice(1).every(p => p.writeScopes.includes(s)));
              guardEntry = { name: "execution-plan", memory: { writeScopes: intersected } };
            } else {
              guardEntry = { name: "execution-plan", memory: { writeScopes: [...DEFAULT_WRITE_SCOPES] } };
            }
          }
        } else {
          activation = await resolveActivation(this.cartridgeRegistry, {
            entries: allEntries,
            loader: this.cartridgeLoader,
            mode,
            message: options.message,
            cartridgeOverride: options.cartridgeOverride,
            agentCartridgeConfig: {
              selfSelect: cartridgesConfig.selfSelect,
              taskPatterns: cartridgesConfig.taskPatterns,
            },
            budgetTokens: cartridgesConfig.budgetTokens,
          });
          for (const event of activation.events) {
            this.append(options.agent.name, { ...event, sessionId } as Record<string, unknown> & { type: string; sessionId: string });
          }
          guardEntry = activation.entry;
        }
      } catch (err) {
        this.log("error", "cartridge load failed", { error: String(err) });
      }
    }

    // Adapter is needed for both cartridge retrieval and flat memory recall.
    const adapter = options.memoryAdapter ?? new NullMemoryAdapter();
    const autoGuard = mode === "auto" ? createAutoGuard(
      (event) => this.append(options.agent.name, { ...event, sessionId }),
      options.agent.config.policy.allowedTools,
      (stats) => this.log("info", "auto execution complete", {
        type: "auto_execution_complete", agent: options.agent.name, sessionId, ...stats,
      }),
    ) : undefined;
    const memoryStore = runtimeEnabled ? undefined : guardMemoryStore(options.memoryStore, guardEntry);
    const canonicalHostContext: string[] = [];
    if (options.lifecycleContext) canonicalHostContext.push(options.lifecycleContext);
    if (options.contextEngine && options.contextConversationId) {
      try {
        const assembled = await options.contextEngine.assemble({
          conversationId: options.contextConversationId,
          prompt: options.message,
          tokenBudget: options.agent.config.session.compactThreshold || 200_000,
        });
        if (assembled.systemPromptAddition) canonicalHostContext.push(assembled.systemPromptAddition);
        this.log("info", "context assembled", {
          conversationId: options.contextConversationId,
          estimatedTokens: assembled.estimatedTokens,
          freshTailCount: assembled.freshTailCount,
        });
      } catch (err) {
        this.log("error", "context assembly failed — continuing without DAG context", { error: String(err) });
      }
    }

    let system = "";
    let staticPrefix = "";
    let staticHash = "";
    let substrateView: SubstrateView | undefined;
    if (runtimeEnabled) {
      if (!options.identityRuntime) {
        throw new Error("identity runtime is enabled but no remote runtime client was configured");
      }
      const compile = {
        identity: options.agent.name,
        surfaceId: options.surfaceId ?? "anima",
        mode,
        message: options.message,
        cartridgeOverride: options.cartridgeOverride,
        hostContext: canonicalHostContext,
      } as const;
      const projection = await new AnimaProjectionCompiler({
        agent: options.agent,
        cartridgeRegistry: this.cartridgeRegistry,
        cartridgeLoader: this.cartridgeLoader,
        recentEvents,
        memoryAdapter: adapter,
        memoryRecall: { sessionStore: options.sessionStore, sessionId },
      }).compile(compile);
      const joined = await joinAnimaIdentityRuntime(options.identityRuntime, {
        clientId: `anima:${options.agent.name}`,
        surfaceId: options.surfaceId ?? "anima",
        compile,
        projection,
      });
      system = joined.projection;
      // The projection owns the full canonical prompt. Keeping it as the cache
      // prefix avoids rebuilding a second prompt shape in the host session.
      staticPrefix = system;
      staticHash = projection.promptStaticHash;
    } else {

    // Build SOUL tiers once; synthesize a Current Identity Summary from substrate if available.
    const soulContent = options.agent.soulContent ?? "";
    const tiered = tierSoul(soulContent);
    const identitySummary = produceIdentitySummary(tiered, 800);
    let currentIdentitySummary: string | undefined;
    try {
      currentIdentitySummary = await readCurrentIdentitySummary(options.agent.substrateAdapter, tiered, 800);
    } catch (err) {
      console.warn("[identity] failed to build current identity summary:", String(err));
    }

    let systemPromptResult: { full: string; staticPrefix: string; staticHash: string };
    if (executionPlan) {
      // Execute substrate retrieval plan declared by active cartridges
      let trustedMemories: RetrievedMemory[] = [];
      let unverifiedMemories: RetrievedMemory[] = [];
      if (executionPlan.substrateRetrievalPlan) {
        try {
          const fallbackTopK = options.agent.config.memory?.topK ?? 5;
          const retrieval = await executeRetrievalPlan(
            executionPlan.substrateRetrievalPlan,
            options.message,
            adapter as unknown as import("../cartridge/retrieval").MemoryAdapter,
            fallbackTopK,
          );
          trustedMemories = retrieval.memories.filter((m) => m.trusted);
          unverifiedMemories = retrieval.memories.filter((m) => !m.trusted);
          for (const event of retrieval.events) {
            this.append(options.agent.name, { ...event, sessionId } as Record<string, unknown> & { type: string; sessionId: string });
          }
          this.log("info", "substrate retrieval executed", {
            trusted: trustedMemories.length,
            unverified: unverifiedMemories.length,
            starved: retrieval.contextStarved,
          });
        } catch (err) {
          this.log("error", "substrate retrieval failed — continuing without cartridge retrieval", { error: String(err) });
        }
      }

      systemPromptResult = buildSystemPromptFromPlan(options.agent, executionPlan, {
        mode,
        recentEvents,
        identitySummary,
        currentIdentitySummary,
        trustedMemories,
        unverifiedMemories,
      });
    } else {
      systemPromptResult = buildSystemPrompt(options.agent, {
        mode,
        recentEvents,
        currentIdentitySummary,
        baseCartridges: activation.base,
        activeCartridge: activation.active,
      });
    }
    ({ full: system, staticPrefix, staticHash } = systemPromptResult);

    // Assemble scoped substrate view (SOUL, invariants, project history, etc.) if available.
    if (options.agent.substrateViewLayer && options.agent.substrateAdapter) {
      try {
        const view = await options.agent.substrateViewLayer.buildView({
          adapter: options.agent.substrateAdapter,
          agentDefaults: { agentId: options.agent.name },
          // Phase 0 (`continuity-ports`): real resolved cartridge policies only
          // when the flag is on — the [] placeholder is otherwise unchanged.
          cartridgePolicies: incarnationPortEnabled ? realCartridgePolicies(executionPlan) : [],
          maxTokens: options.agent.config.session.compactThreshold,
        });
        substrateView = view;
        const assembler = new DefaultPromptAssembler();
        const promptContext = assembler.assemble(view, {
          maxTokens: 2000,
          format: "markdown",
        });
        if (promptContext.blocks.length > 0) {
          const section = promptContext.blocks
            .map((b) => `## ${b.label}\n\n${b.content}`)
            .join("\n\n");
          system = `${system}\n\n${section}`;
          this.log("info", "substrate view assembled", {
            agent: options.agent.name,
            blocks: promptContext.blocks.length,
            estimatedTokens: promptContext.totalTokens,
          });
        }
      } catch (err) {
        this.log("error", "substrate view assembly failed — continuing without scoped context", {
          agent: options.agent.name,
          error: String(err),
        });
      }
    }

    for (const section of canonicalHostContext) system = `${system}\n\n${section}`;

    let recallEntries: string[] = [];
    try {
      const recalled = await adapter.recall(options.message, {
        namespace: options.agent.name,
        topK: options.agent.config.memory?.topK ?? 5,
        mode: options.agent.config.memory?.recallMode,
        recentDays: options.agent.config.memory?.recentDays,
        sessionStore: options.sessionStore,
        sessionId,
      });
      recallEntries = recalled.map((e) => e.content);
    } catch (err) {
      this.log("error", "memory recall failed — continuing without memory", {
        type: "memory_recall_error",
        agent: options.agent.name,
        sessionId,
        error: String(err),
      });
    }
    if (recallEntries.length > 0) {
      const memorySection = "[Memory Context]\n" + recallEntries.map((c) => `- ${c}`).join("\n");
      system = `${system}\n\n${memorySection}`;
    }

    const allowedToolsSet = new Set(options.agent.config.policy.allowedTools ?? []);
    const hasAnimaTools = [...allowedToolsSet].some((t) => (t as string).startsWith("anima_"));
    if (hasAnimaTools && memoryStore && !system.includes("[Memory Context]")) {
      try {
        const bootstrapEntries = await memoryStore.bootstrap({
          currentPrompt: options.message,
          maxEntries: 8,
        });
        if (bootstrapEntries.length > 0) {
          const memorySection = "[Memory Context]\n" + bootstrapEntries.map((e) => `- ${e.content}`).join("\n");
          system = `${system}\n\n${memorySection}`;
        }
      } catch (err) {
        this.log("error", "before_turn memory bootstrap failed — continuing", { error: String(err) });
      }
    }

    system = injectIdentityAnchor(system, options.agent);
    }

    let prior: ProviderMessage[] = [];
    if (options.priorMessages && options.priorMessages.length > 0) {
      prior = options.priorMessages;
    } else if (options.channelId && options.threadStore) {
      prior = options.threadStore.getThread(options.channelId, options.agent.name) as ProviderMessage[];
    } else if (options.sessionStore && options.sessionId) {
      // Fallback so callers that pass sessionId + sessionStore but forget
      // priorMessages still get conversation history instead of silently
      // talking to the model with zero context every turn.
      prior = options.sessionStore.getTurns(options.sessionId).map((t) => ({ role: t.role, content: t.content }));
    }
    const summaryPair = options.priorSummary ? priorSummaryMessages(options.priorSummary) : [];
    const summaryTokens = summaryPair.reduce((sum, message) => sum + messageTokens(message), 0);
    const kept = trimPriorHistory(prior, (options.priorHistoryTokenBudget ?? PRIOR_HISTORY_TOKEN_BUDGET) - summaryTokens);
    if (kept.messages.length < prior.length) {
      this.log("info", "prior history trimmed", {
        agent: options.agent.name,
        kept: kept.messages.length,
        dropped: prior.length - kept.messages.length,
        keptEstimatedTokens: kept.estimatedTokens,
      });
    }
    let messages: ProviderMessage[] = [...summaryPair, ...kept.messages, { role: "user" as const, content: options.message }];

    if (options.imageData) {
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        const textPart = options.message ? [{ type: "text" as const, text: options.message }] : [];
        last.content = [
          ...textPart,
          { type: "image_url" as const, image_url: { url: options.imageData } },
        ];
      }
    }

    // Phase 0 (`continuity-ports`) mint hook — manifest + lease over the prompt
    // just finalized above. Default off; a join() failure never blocks the turn.
    let manifest: ProjectionManifest | undefined;
    let leaseId: string | undefined;
    if (incarnationPortEnabled) {
      try {
        const writeScopesForLease = guardEntry?.memory?.writeScopes ?? [...DEFAULT_WRITE_SCOPES];
        const joined = await mintForTurn({
          agent: options.agent,
          surfaceId: options.surfaceId ?? "anima",
          executionPlan,
          prompt: { full: system, staticPrefix, staticHash },
          substrateView,
          writeScopes: writeScopesForLease,
          dbPath: options.continuityDbPath,
        });
        manifest = joined.manifest;
        leaseId = joined.lease.leaseId;
      } catch (err) {
        this.log("error", "incarnation join failed — continuing without continuity manifest", {
          agent: options.agent.name,
          error: String(err),
        });
      }
    }

    this.append(options.agent.name, {
      type: "user_message",
      sessionId,
      mode,
      body: options.message,
    });

    options.signal?.throwIfAborted();
    const mcpManager = !options.disableTools && options.agent.config.mcp?.servers.length
      ? this.mcpManagerFactory(options.agent.config.mcp.servers)
      : undefined;
    try {
      options.signal?.throwIfAborted();
      await mcpManager?.start(options.signal);
      options.signal?.throwIfAborted();
    } catch (error) {
      await mcpManager?.stop();
      throw error;
    }

    const tools = options.disableTools ? [] : buildToolDefinitions(options.agent.config.policy.allowedTools ?? []);
    const mcpTools = mcpManager?.getTools() ?? [];

    return {
      sessionId,
      mode,
      system,
      staticPrefix,
      staticHash,
      messages,
      memoryStore,
      adapter,
      mcpManager,
      autoGuard,
      tools: [...tools, ...mcpTools],
      manifest,
      leaseId,
    };
  }

  private async runToolLoop(context: TurnContext): Promise<ProviderResponse> {
    for await (const event of new TurnRunner().run(context)) {
      if (event.type === "done") return event.response;
      if (event.type === "error") throw event.error;
    }
    throw new Error("turn runner ended without a response");
  }

  private async evaluateResponse(
    options: RunAgentSessionOptions,
    responseText: string,
    sessionId: string,
  ): Promise<EvalOutput | null> {
    if (!this.evaluationPipeline) return null;

    const responseStr = typeof responseText === "string" ? responseText : JSON.stringify(responseText);
    try {
      return await this.evaluationPipeline.evaluate({
        agentId: options.agent.name,
        output: responseStr,
        domain: "communication",
        actionId: "telegram_send",
        recentStatements: [options.message],
        allowedTasks: options.agent.config.policy.allowedTools,
      });
    } catch (err) {
      this.log("error", "evaluation pipeline failed — allowing by default", {
        type: "eval_error",
        agent: options.agent.name,
        sessionId,
        error: String(err),
      });
      return null; // fail-open: allow action on pipeline error
    }
  }

  private append(agent: string, event: Record<string, unknown> & { type: string; sessionId: string }): void {
    const fullEvent: JsonlEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    } as JsonlEvent;
    this.store.append(agent, fullEvent);
    this.sessionEvents.push(fullEvent);
  }
}

function structuredLog(level: "info" | "error", msg: string, fields: LogFields = {}): void {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({
      level,
      ts: new Date().toISOString(),
      msg,
      ...fields,
    }),
  );
}
