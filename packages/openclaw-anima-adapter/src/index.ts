/**
 * @anima/openclaw-adapter — OpenClaw Anima Adapter Plugin
 *
 * Opt-in OpenClaw plugin that wraps @anima/context-engine and AnimaMemoryStore
 * as context engine. Registers "anima" context engine, injects shared memory
 * recall before each prompt, writes cross-session summaries on session end,
 * and keeps LCM tools operational.
 *
 * Coexists with lossless-claw — each agent uses the plugin specified in its config.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi, AnimaTool, MemoryScope } from "./types.js";
import { AnimaContextEngineAdapter } from "./adapter.js";
import { AnimaMemoryStore, type EmbeddingFn } from "./memory-store.js";
import { MemoryStoreBruno } from "./memory-store-bruno.js";
import { createLcmGrepTool } from "./tools/lcm-grep.js";
import { createLcmDescribeTool } from "./tools/lcm-describe.js";
import { createLcmExpandTool } from "./tools/lcm-expand.js";
import { createAnimaMemoryTools } from "./tools/anima-memory-tools.js";
import type { SummaryProvider } from "@anima/context-engine";
import {
  detectActionIntent,
  filterConfirmRules,
  formatConfirmGate,
} from "./confirm-gate.js";

/* ------------------------------------------------------------------ */
/*  abel-mem sync — direct SQLite write to the abel-mem database           */
/* ------------------------------------------------------------------ */

const TWOB_MEM_DB_PATH = join(homedir(), "work", "abel-mem", "data", "abel-mem.db");
let twobMemDb: DatabaseSync | null = null;

function get2bMemDb(): DatabaseSync | null {
  if (twobMemDb) return twobMemDb;
  if (!existsSync(TWOB_MEM_DB_PATH)) return null;
  try {
    twobMemDb = new DatabaseSync(TWOB_MEM_DB_PATH);
    twobMemDb.exec("PRAGMA journal_mode = WAL");
    twobMemDb.exec("PRAGMA busy_timeout = 5000");
    return twobMemDb;
  } catch {
    return null;
  }
}

function scopeTo2bMemType(scope: string): string {
  const map: Record<string, string> = {
    fact: "fact", observation: "behavior", episode: "skill",
    preference: "preference", insight: "learning", reflection: "learning",
  };
  return map[scope] ?? "fact";
}

function sync2bMem(content: string, tags: string[], source: string, scope: string): void {
  const db = get2bMemDb();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO memories (memory_type, content, confidence, tags, source_transcript_ids, is_active)
       VALUES (?, ?, 1.0, ?, ?, 1)`
    ).run(
      scopeTo2bMemType(scope),
      content,
      JSON.stringify(tags),
      JSON.stringify([source]),
    );
  } catch {
    // best-effort — don't break anima writes
  }
}

function wrap2bMemSync(store: AnimaMemoryStore): AnimaMemoryStore {
  const origRemember = store.remember.bind(store);
  store.remember = async (entry) => {
    const result = await origRemember(entry);
    sync2bMem(entry.content, entry.tags ?? [], entry.source ?? "openclaw", entry.scope ?? "fact");
    return result;
  };
  return store;
}

/** Plugin config shape — matches openclaw.plugin.json configSchema */
interface PluginConfig {
  enabled?: boolean;
  agents?: string[];
  geminiApiKey?: string;
  compactionConfig?: {
    leafChunkTokens?: number;
    condensedMinFanout?: number;
    condensedMinFanoutHard?: number;
    leafTargetTokens?: number;
    condensedTargetTokens?: number;
    freshTailCount?: number;
    maxSweepIterations?: number;
    sweepDeadlineMs?: number;
    maxRounds?: number;
    compactUntilUnderDeadlineMs?: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ANIMA_DATA_DIR = join(homedir(), ".anima", "agents");

function resolveContextDbPath(agentId: string): string {
  return join(ANIMA_DATA_DIR, agentId, "context.db");
}

function resolveMemoryDbPath(agentId: string): string {
  return join(ANIMA_DATA_DIR, agentId, "memory.db");
}

function ensureAgentDir(agentId: string): void {
  const dir = join(ANIMA_DATA_DIR, agentId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Per-agent plugin state                                             */
/* ------------------------------------------------------------------ */

export interface AgentPluginState {
  adapter: AnimaContextEngineAdapter;
  memoryStore: any; // AnimaMemoryStore | MemoryStoreBruno (different id types)
  agentId: string;
  platform: string;
}

const activeAgentStates = new Map<string, AgentPluginState>();

// Standalone memory stores — independent of context engine lifecycle
const standaloneMemoryStores = new Map<string, AnimaMemoryStore>();

// Per-agent message counter for batch bridge
const embedCounters = new Map<string, number>();
const EMBED_BATCH_SIZE = 5; // trigger bridge every N user messages

/** Strip tool calls from message content, keep only text blocks.
 *  Handles JSON array of content blocks + plain strings. */
export function stripToolcalls(rawContent: string): string {
  try {
    const blocks = JSON.parse(rawContent);
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b: any) => b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
    }
    if (typeof blocks === "object" && blocks !== null && blocks.type === "text") {
      return blocks.text;
    }
  } catch {
    // Not JSON — treat as plain text
  }
  return rawContent;
}

/** Extract agent ID from a session key like "agent:<agentId>:..." */
function extractAgentId(sessionKey: string | undefined): string {
  if (!sessionKey) return "main";
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1]?.trim() || "main";
  }
  return "main";
}

/** Get or create plugin state for a given agent. Returns null if not yet initialized. */
function getState(agentId: string): AgentPluginState | null {
  return activeAgentStates.get(agentId) ?? null;
}

/** Module-level embedding fn + model name (set in register()). */
let embeddingFn: EmbeddingFn | undefined;
let embeddingModelName: string | undefined;

/** Pending standalone-store initialization promises, keyed by agentId.
 *  Prevents TOCTOU races: concurrent callers share one init promise instead
 *  of each opening its own sqlite connection + store for the same agent. */
const pendingStandaloneInit = new Map<string, Promise<AnimaMemoryStore>>();

/**
 * Get or create a standalone AnimaMemoryStore for an agent.
 * Checks activeAgentStates first (no duplicate connections),
 * then standaloneMemoryStores, then lazy-init.
 * Works regardless of context engine setting.
 * Promise-gated so concurrent callers for the same agent share one init.
 */
export async function getOrCreateMemoryStore(agentId: string): Promise<AnimaMemoryStore> {
  // Check if context engine state already has a store
  const existing = activeAgentStates.get(agentId);
  if (existing?.memoryStore) return existing.memoryStore as AnimaMemoryStore;

  // Check standalone map
  const standalone = standaloneMemoryStores.get(agentId);
  if (standalone) return standalone;

  // Share an in-flight init if one exists for this agent (race guard)
  const inFlight = pendingStandaloneInit.get(agentId);
  if (inFlight) return inFlight;

  const initPromise = (async () => {
    try {
      // Re-check after acquiring — another caller may have finished init
      const recheck = standaloneMemoryStores.get(agentId);
      if (recheck) return recheck;

      ensureAgentDir(agentId);
      const isBruno = agentId === "bruno";
      const store = isBruno
        ? new MemoryStoreBruno(join(homedir(), "work", "bruno-entity", "data", "bruno.db"), agentId)
        : new AnimaMemoryStore(resolveMemoryDbPath(agentId));
      await store.initialize();

      if (embeddingFn) {
        store.setEmbeddingFn(embeddingFn, embeddingModelName ?? "unknown");
      }

      const finalStore = agentId === "abel" ? wrap2bMemSync(store as AnimaMemoryStore) : store;
      standaloneMemoryStores.set(agentId, finalStore as any);
      return finalStore as AnimaMemoryStore;
    } finally {
      pendingStandaloneInit.delete(agentId);
    }
  })();

  pendingStandaloneInit.set(agentId, initPromise);
  return initPromise;
}

/** Pending initialization promises, keyed by agentId. Prevents TOCTOU races. */
const pendingInit = new Map<string, Promise<AgentPluginState>>();

/**
 * Initialize the adapter and memory store for a given agent.
 * Called on first use (lazy init). Uses a promise gate to prevent
 * duplicate initialization under concurrent access.
 */
async function ensureState(
  agentId: string,
  platform: string,
  isAllowed: boolean,
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  summaryProvider?: SummaryProvider,
  embeddingFn?: EmbeddingFn,
  embeddingModelName?: string,
  compactionConfig?: PluginConfig["compactionConfig"],
): Promise<AgentPluginState> {
  if (!isAllowed) throw new Error(`Agent "${agentId}" is not in the anima allowlist`);
  const existing = activeAgentStates.get(agentId);
  if (existing) return existing;

  const alreadyPending = pendingInit.get(agentId);
  if (alreadyPending) return alreadyPending;

  const promise = (async () => {
    ensureAgentDir(agentId);

    const contextDbPath = resolveContextDbPath(agentId);

    const adapter = new AnimaContextEngineAdapter(contextDbPath, log);

    // Apply compaction config if provided (merge with defaults)
    if (compactionConfig) {
      adapter.setCompactionConfig(compactionConfig as any);
    }

    // Bruno uses shared bruno-entity DB; other agents use per-agent memory.db
    const isBruno = agentId === "bruno";
    const memoryStore = isBruno
      ? new MemoryStoreBruno(join(homedir(), "work", "bruno-entity", "data", "bruno.db"), agentId)
      : new AnimaMemoryStore(resolveMemoryDbPath(agentId));

    if (summaryProvider) {
      adapter.setSummaryProvider(summaryProvider);
    }

    try {
      await adapter.initialize(agentId, platform);
      await memoryStore.initialize();
    } catch (err) {
      // Clean up partial init: dispose any opened connections
      try { adapter.dispose(); } catch { /* best effort */ }
      try { memoryStore.close(); } catch { /* best effort */ }
      throw err;
    }

    if (embeddingFn) {
      memoryStore.setEmbeddingFn(embeddingFn, embeddingModelName ?? "unknown");
    }

    const state: AgentPluginState = { adapter, memoryStore, agentId, platform };
    activeAgentStates.set(agentId, state);

    log?.info?.(
      `[anima] Agent "${agentId}" initialized: context=${contextDbPath} memory=${memoryStore.getDbPath()}`,
    );

    return state;
  })();

  pendingInit.set(agentId, promise);
  try {
    return await promise;
  } finally {
    pendingInit.delete(agentId);
  }
}

/* ------------------------------------------------------------------ */
/*  Plugin definition                                                  */
/* ------------------------------------------------------------------ */

const animaAdapterPlugin = {
  id: "@anima/openclaw-adapter",
  name: "Anima Context Engine Adapter",
  description:
    "Anima context engine adapter — wraps @anima/context-engine (DAG compaction) " +
    "and AnimaMemoryStore (shared per-agent SQLite memory). " +
    "Activate per-agent with contextEngine: 'anima'. Coexists with lossless-claw.",

  /** Plugin config shape — must match openclaw.plugin.json configSchema */
  configSchema: {
    parse(value: unknown): PluginConfig {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as PluginConfig;
      }
      return { enabled: true };
    },
  },

  /** Default compaction config — can be overridden via plugin config */
  defaultCompactionConfig: {
    leafChunkTokens: 20_000,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    leafTargetTokens: 2_400,
    condensedTargetTokens: 2_000,
    freshTailCount: 64,
    maxSweepIterations: 12,
    sweepDeadlineMs: 120_000,
    maxRounds: 10,
    compactUntilUnderDeadlineMs: 300_000,
  },

  register(api: OpenClawPluginApi) {
    // ── Per-agent opt-in config ──
    const config = api.pluginConfig as PluginConfig | undefined;
    const agentAllowlist: Set<string> | null = config?.agents?.length ? new Set(config.agents) : null;

    /** Returns true if the given agent is opted into the anima adapter. */
    function isAgentAllowed(agentId: string): boolean {
      if (agentAllowlist) return agentAllowlist.has(agentId);
      // No allowlist → any agent with contextEngine: "anima" is opted in
      // (registerContextEngine only fires for opted-in agents)
      return true;
    }

    // ── SummaryProvider — bridge api.runtime.llm.complete → SummaryProvider ──
    const summaryProvider: SummaryProvider | undefined = api.runtime?.llm?.complete
      ? {
          async complete(params) {
            try {
              return await api.runtime.llm!.complete!({
                system: params.system,
                messages: params.messages,
                model: params.model,
                maxTokens: params.maxTokens,
                temperature: params.temperature,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              api.logger?.warn?.(`[anima] summaryProvider LLM error (non-fatal): ${msg}`);
              return { content: "" };
            }
          },
        }
      : undefined;

    if (!summaryProvider) {
      api.logger?.warn?.(
        "[anima] api.runtime.llm unavailable — compaction disabled. " +
        "Install an OpenClaw build with Plugin SDK runtime LLM support.",
      );
    }

    // ── EmbeddingFn — resolve from OpenClaw config (any provider) ──
    const resolvedEmbeddingFn = resolveEmbeddingFn(api, (msg) => api.logger?.info?.(`[anima] ${msg}`));

    if (!resolvedEmbeddingFn) {
      api.logger?.info?.("[anima] No embedding provider configured — vector search disabled, FTS only.");
    }

    // Assign to module-level so getOrCreateMemoryStore can use it
    embeddingFn = resolvedEmbeddingFn;
    const embeddingCfg = readEmbeddingConfig(api);
    embeddingModelName = embeddingCfg?.model;

    /* ----------------------------------------------------------------- */
    /*  Context engine                                                    */
    /* ----------------------------------------------------------------- */

    api.registerContextEngine("anima", (_ctx: any) => {
      // OpenClaw calls these methods per-agent. We track agentId from
      // initialize() and route subsequent calls to the correct adapter state.
      let currentAgentId = "";
      let currentPlatform = "";

      return {
        info: {
          id: "anima",
          name: "Anima Context Engine",
          version: "1.0.0",
          ownsCompaction: true,
          hostRequirements: {
            compact: {
              requiredCapabilities: ["runtime-llm-complete"],
            },
          },
        },
        initialize: async (agentId: string, platform: string) => {
          currentAgentId = agentId;
          currentPlatform = platform;
          const embedCfg = readEmbeddingConfig(api);
          const compactionCfg = readCompactionConfig(api);
          await ensureState(agentId, platform, isAgentAllowed(agentId), api.logger, summaryProvider, embeddingFn, embedCfg?.model, compactionCfg);
        },
        bootstrap: async (input: any) => {
          // OC sends { sessionId, sessionKey?, sessionFile } → adapter expects { conversationId?, messages? }
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) {
            const embedCfg = readEmbeddingConfig(api);
            const compactionCfg = readCompactionConfig(api);
            await ensureState(agentId, "openclaw", isAgentAllowed(agentId), api.logger, summaryProvider, embeddingFn, embedCfg?.model, compactionCfg);
            state = getState(agentId);
          }
          if (!state) throw new Error(`[anima] No adapter for agent "${agentId}"`);
          return state.adapter.bootstrap({
            conversationId: input?.sessionId ?? input?.conversationId,
            messages: input?.messages,
          });
        },
        ingest: async (input: any) => {
          // OC sends { sessionId, sessionKey?, message: AgentMessage } → adapter expects { conversationId, message: MessageRecord }
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          const msgRole = input?.message?.role;
          api.logger?.info?.(`[anima] ingest agent=${agentId} role=${msgRole}`);
          let state = getState(agentId);
          if (!state) {
            const embedCfg = readEmbeddingConfig(api);
            const compactionCfg = readCompactionConfig(api);
            await ensureState(agentId, "openclaw", isAgentAllowed(agentId), api.logger, summaryProvider, embeddingFn, embedCfg?.model, compactionCfg);
            state = getState(agentId);
          }
          if (!state) throw new Error(`[anima] No adapter for agent "${agentId}"`);
          const conversationId = input?.sessionId ?? input?.conversationId;
          const ocMessage = input?.message;
          const msgRecord = ocMessage
            ? mapAgentMessageToMessageRecord(ocMessage, conversationId)
            : null;
          if (!msgRecord) return { ingested: false } as any; // skip error/aborted messages + empty content
          await state.adapter.ingest({
            conversationId,
            message: msgRecord,
            // Pass raw message for structured message_parts (lossless-claw parity)
            rawAgentMessage: ocMessage,
            sessionId: input?.sessionId ?? conversationId,
          });

          // Batch bridge from context.db: every N user messages, persist batch to memory
          if (msgRole === "user") {
            const count = (embedCounters.get(agentId) ?? 0) + 1;
            embedCounters.set(agentId, count);
            if (count >= EMBED_BATCH_SIZE) {
              const batchNumber = count / EMBED_BATCH_SIZE;
              embedCounters.set(agentId, 0);
              // Fire-and-forget: don't block ingest
              batchBridgeFromContext(agentId, conversationId, batchNumber, api.logger).catch(() => {});
            }
          }

          return { ingested: true } as any;
        },
        assemble: async (input: any) => {
          // OC sends { sessionId, sessionKey?, messages[], tokenBudget, ... } → adapter expects { conversationId, prompt?, tokenBudget? }
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) {
            const embedCfg = readEmbeddingConfig(api);
            const compactionCfg = readCompactionConfig(api);
            await ensureState(agentId, "openclaw", isAgentAllowed(agentId), api.logger, summaryProvider, embeddingFn, embedCfg?.model, compactionCfg);
            state = getState(agentId);
          }
          if (!state) throw new Error(`[anima] No adapter for agent "${agentId}"`);
          return state.adapter.assemble({
            conversationId: input?.sessionId ?? input?.conversationId,
            prompt: input?.prompt,
            tokenBudget: input?.tokenBudget,
          });
        },
        compact: async (input: any) => {
          // OC sends { sessionId, sessionKey?, sessionFile, tokenBudget, ... } → adapter expects { conversationId, targetTokens?, currentTokens? }
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) {
            const embedCfg = readEmbeddingConfig(api);
            const compactionCfg = readCompactionConfig(api);
            await ensureState(agentId, "openclaw", isAgentAllowed(agentId), api.logger, summaryProvider, embeddingFn, embedCfg?.model, compactionCfg);
            state = getState(agentId);
          }
          if (!state) throw new Error(`[anima] No adapter for agent "${agentId}"`);
          
          // Pass runtimeContext through to adapter for per-compaction LLM access
          const compactInput = {
            conversationId: input?.sessionId ?? input?.conversationId,
            targetTokens: input?.tokenBudget ?? input?.targetTokens,
            currentTokens: input?.currentTokens ?? input?.currentTokenCount,
            runtimeContext: input?.runtimeContext,
          };
          
          return state.adapter.compact(compactInput);
        },
        search: async (query: string, opts?: any) => {
          const agentId = opts?.sessionKey ? extractAgentId(opts.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) {
            const embedCfg = readEmbeddingConfig(api);
            const compactionCfg = readCompactionConfig(api);
            await ensureState(agentId, "openclaw", isAgentAllowed(agentId), api.logger, summaryProvider, embeddingFn, embedCfg?.model, compactionCfg);
            state = getState(agentId);
          }
          if (!state) return [];
          return state.adapter.search(query, opts);
        },
        checkIntegrity: async () => {
          const state = getState(currentAgentId);
          if (!state) return { healthy: false, checks: [] };
          return state.adapter.checkIntegrity();
        },
        dispose: () => {
          const state = getState(currentAgentId);
          if (state) {
            state.adapter.dispose();
            state.memoryStore.close();
            activeAgentStates.delete(currentAgentId);
          }
        },
      };
    });

    /* ----------------------------------------------------------------- */
    /*  before_prompt_build — inject shared memory recall + confirm gate   */
    /*  NOTE: must use api.on() — api.registerHook() is NOT wired in the   */
    /*  current OpenClaw plugin runtime (conv-store and prompt-optimizer  */
    /*  use api.on() and run; registerHook never fires). Context is        */
    /*  appended (not prepended) so recall + gate rules                    */
    /*  sit at the END of the system prompt, closest to the user message.  */
    /* ----------------------------------------------------------------- */

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      const agentId = extractAgentId(ctx?.sessionKey);
      if (!isAgentAllowed(agentId)) { api.logger?.info?.(`[anima] before_prompt_build SKIP: agent "${agentId}" not allowed`); return; }

      const userMessage = extractUserMessage(event);
      if (!userMessage) { api.logger?.info?.(`[anima] before_prompt_build SKIP: no userMessage for "${agentId}"`); return; }

      try {
        const store = await getOrCreateMemoryStore(agentId);
        const appendParts: string[] = [];

        // 1) Shared memory recall (general context)
        const entries = await store.recall(userMessage, { topK: 5 });
        if (entries.length > 0) {
          appendParts.push(formatMemoryRecall(entries as any));
          api.logger?.info?.(`[anima] before_prompt_build: injected ${entries.length} entries for "${agentId}"`);
        } else {
          api.logger?.info?.(`[anima] before_prompt_build: recall=0 for "${agentId}" q="${userMessage.substring(0, 80)}"`);
        }

        // 2) Confirm-before-action gate — only when the message looks like
        //    an imperative action command. Pull rule-like neurons
        //    (heuristic/decision/axiom) and enforce them if they mandate
        //    asking for confirmation first.
        if (detectActionIntent(userMessage)) {
          const ruleEntries = await store.recall(userMessage, {
            topK: 10,
            scopes: ["heuristic", "decision", "axiom"] as any,
          });
          const gateHits = filterConfirmRules(ruleEntries as any);
          const gate = formatConfirmGate(gateHits);
          if (gate) {
            appendParts.push(gate);
            api.logger?.info?.(`[anima] before_prompt_build: GATE active for "${agentId}" (${gateHits.length} rule(s))`);
          }
        }

        if (appendParts.length === 0) return;
        return { appendSystemContext: appendParts.join("\n\n") };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        api.logger?.warn?.(`[anima] Memory recall error (non-fatal): ${errMsg}`);
      }
    });

    /* ----------------------------------------------------------------- */
    /*  session_end — write cross-session summary to AnimaMemoryStore     */
    /* ----------------------------------------------------------------- */

    api.on("session_end", async (event: any) => {
      const sessionKey = event?.sessionKey;
      const agentId = extractAgentId(sessionKey);
      api.logger?.info?.(`[anima] session_end CALLED agent="${agentId}" sk="${sessionKey}" sid="${event?.sessionId}"`);
      if (!isAgentAllowed(agentId)) { api.logger?.info?.(`[anima] session_end SKIP: agent "${agentId}" not allowed`); return; }

      const conversationId = event?.sessionId ?? event?.nextSessionId;
      if (!conversationId) { api.logger?.info?.(`[anima] session_end SKIP: no conversationId for "${agentId}"`); return; }

      try {
        const store = await getOrCreateMemoryStore(agentId);
        const state = getState(agentId);

        // If we have adapter (contextEngine: anima), compact
        if (state?.adapter) {
          const compactResult = await state.adapter.compact({ conversationId });

          if (!compactResult.compacted || compactResult.summariesCreated === 0) {
            api.logger?.info?.(`[anima] session_end: nothing compacted for "${agentId}"`);
            return;
          }

          await store.remember({
            content: `Session summary (${conversationId}): Compacted ${compactResult.summariesCreated} summaries (${compactResult.tokensBefore} -> ${compactResult.tokensAfter} tokens)`,
            scope: "episode" as MemoryScope,
            tags: ["openclaw", "session_summary", agentId],
            confidence: 0.8,
            source: "openclaw",
            metadata: {
              conversationId,
              tokensBefore: compactResult.tokensBefore,
              tokensAfter: compactResult.tokensAfter,
              summariesCreated: compactResult.summariesCreated,
              sessionKey,
            },
          } as any);

          api.logger?.info?.(
            `[anima] Cross-session summary written: conv=${conversationId} agent=${agentId}`,
          );
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        api.logger?.warn?.(`[anima] session_end error (non-fatal): ${errMsg}`);
      }
    });

    /* ----------------------------------------------------------------- */
    /*  after_compaction - notify user when compaction completes          */
    /* ----------------------------------------------------------------- */

    api.on("after_compaction", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;
      const agentId = extractAgentId(sessionKey);
      if (!isAgentAllowed(agentId)) return;
      const state = getState(agentId);
      if (!state) return;

      const compactedCount = event?.compactedCount ?? 0;
      const tokensAfter = event?.tokensAfter ?? 0;
      const tokensBefore = event?.tokensBefore ?? 0;
      if (compactedCount === 0) return; // Nothing was compacted

      const msg = "[anima] compaction complete - " + compactedCount + " messages, " + tokensBefore + " -> " + tokensAfter + " tokens (saved " + (tokensBefore - tokensAfter) + ")";

      try {
        await (api as any).session.workflow.enqueueNextTurnInjection({
          sessionKey,
          injection: {
            type: "system",
            content: msg,
            priority: "low",
          },
        });
      } catch {
        // enqueueNextTurnInjection may fail if workflow not available; just log
        api.logger?.info?.("[anima] compaction notify enqueue failed");
      }
    });

    /* ----------------------------------------------------------------- */
    /*  LCM tools                                                         */
    /* ----------------------------------------------------------------- */

    // Each tool factory captures the current agent context and routes to
    // the per-agent adapter's database handle.
    const toolFactories: Array<(ctx: any) => AnimaTool> = [
      (ctx: any) => {
        const agentId = extractAgentId(ctx?.sessionKey);
        return createLcmGrepTool(() => getState(agentId)?.adapter.getDb() ?? null);
      },
      (ctx: any) => {
        const agentId = extractAgentId(ctx?.sessionKey);
        return createLcmDescribeTool(() => getState(agentId)?.adapter.getDb() ?? null);
      },
      (ctx: any) => {
        const agentId = extractAgentId(ctx?.sessionKey);
        return createLcmExpandTool(() => getState(agentId)?.adapter.getDb() ?? null);
      },
    ];

    api.registerTool(toolFactories[0], { name: "lcm_grep" });
    api.registerTool(toolFactories[1], { name: "lcm_describe" });
    api.registerTool(toolFactories[2], { name: "lcm_expand" });

    // ── Anima memory tools (from Hermes provider) ──
    // Each tool is registered with a factory that resolves the calling agent
    // from session context, preventing cross-agent IDOR.
    // v2: tools route through getOrCreateMemoryStore (standalone memory map),
    // NOT through getState() which requires contextEngine: "anima".
    const templateTools = createAnimaMemoryTools(async () => {
      // This fallback should never be reached — proper resolution happens
      // in the factory below. Here just in case.
      return getOrCreateMemoryStore("main");
    });
    for (const template of templateTools) {
      const toolName = template.name;
      api.registerTool((ctx: any) => {
        const agentId = extractAgentId(ctx?.sessionKey);
        return createAnimaMemoryTools(async () => getOrCreateMemoryStore(agentId)).find(t => t.name === toolName)!;
      }, { name: toolName });
    }

    // ── Memory plugin capability (only for kind: "memory" plugins) ──
    // registerMemoryCapability requires kind: "memory" in manifest.
    // For now, memory is provided via anima_* tools + hooks.
    // When kind includes "memory", uncomment the block below.

    // ── Debug tools (self-access only — resolved per invocation) ──
    function createDebugTools(agentId: string): AnimaTool[] {
      return [
        {
          name: "anima_debug_context",
          description: `Show context.db stats for the current agent (${agentId}): messages by role, latest content.`,
          parameters: { type: "object", properties: {}, required: [] },
          execute: async (_toolCallId: string, _params: unknown) => {
            const state = getState(agentId);
            if (!state) return { content: [{ type: "text", text: `No state for "${agentId}". Active: ${[...activeAgentStates.keys()].join(", ") || "none"}` }] };
            const db = state.adapter.getDb();
            if (!db) return { content: [{ type: "text", text: "No DB connection" }] };
            const total = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
            const roles = db.prepare("SELECT role, COUNT(*) as c FROM messages GROUP BY role").all() as any[];
            const latest = db.prepare("SELECT role, substr(content,1,120) as preview, created_at FROM messages ORDER BY rowid DESC LIMIT 5").all() as any[];
            return {
              content: [{ type: "text", text: JSON.stringify({
                agent: agentId,
                totalMessages: total,
                byRole: Object.fromEntries(roles.map((r: any) => [r.role, r.c])),
                latest: latest.map((r: any) => ({ role: r.role, preview: r.preview, at: r.created_at })),
              }, null, 2) }],
            };
          },
        },
        {
          name: "anima_debug_reset_context",
          description: `Delete all messages from context.db for the current agent (${agentId}). Use confirm:true.`,
          parameters: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] },
          execute: async (_toolCallId: string, params: unknown) => {
            if (!(params as any)?.confirm) return { content: [{ type: "text", text: "Set confirm: true to execute" }] };
            const state = getState(agentId);
            if (!state) return { content: [{ type: "text", text: `No state for "${agentId}"` }] };
            const db = state.adapter.getDb();
            if (!db) return { content: [{ type: "text", text: "No DB connection" }] };
            const before = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
            db.exec("DELETE FROM messages");
            db.exec("DELETE FROM context_items");
            return { content: [{ type: "text", text: `Deleted ${before} messages from context.db for ${agentId}` }] };
          },
        },
      ];
    }

    const templateDebugTools = createDebugTools("main");
    for (const template of templateDebugTools) {
      const toolName = template.name;
      api.registerTool((ctx: any) => {
        const agentId = extractAgentId(ctx?.sessionKey);
        return createDebugTools(agentId).find(t => t.name === toolName)!;
      }, { name: toolName });
    }

    api.logger?.info?.("[anima] Plugin registered: @anima/openclaw-adapter v2 (3 LCM + 19 memory tools + 2 debug + 3 hooks, standalone memory map)");
  },
};

export default animaAdapterPlugin;

// Named exports required by OpenClaw plugin loader (CJS interop via jiti/require)
export const register = () => animaAdapterPlugin;
export const activate = () => animaAdapterPlugin;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractUserMessage(event: any): string | null {
  if (!event) return null;

  // OC sends event.prompt (the current user query), not event.userMessage
  if (typeof event.prompt === "string" && event.prompt.trim()) {
    return event.prompt.trim();
  }

  if (typeof event.userMessage === "string" && event.userMessage.trim()) {
    return event.userMessage.trim();
  }

  if (event.messages && Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg?.role === "user" && typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }
    }
  }

  return null;
}

/** Map OC's AgentMessage shape to the adapter's MessageRecord shape.
 *  AgentMessage has { role, content, timestamp?, ... }.
 *  MessageRecord needs { id, role, content, created_at, seq, conversation_id?, ... }.
 *
 *  === Lossless-claw parity: error message filter ===
 *  Assistant messages with stopReason="error" or "aborted" and empty content are
 *  skipped — they pollute the context DB and create tool-loop feedback. */
function mapAgentMessageToMessageRecord(msg: any, conversationId?: string): import("@anima/context-engine").MessageRecord | null {
  const id = msg?.id ?? msg?.messageId ?? crypto.randomUUID();
  // Normalize OC role names to DB CHECK constraint values
  const rawRole = (msg?.role as string) ?? "user";
  const roleMap: Record<string, string> = {
    toolResult: "tool",
    custom: "system",   // OC uses 'custom' for injected system/context blocks
    developer: "system", // Claude-style dev messages
  };
  const role = roleMap[rawRole] ?? (['user','assistant','system','tool'].includes(rawRole) ? rawRole : 'system');

  // ── Error message filter (mirrors lossless-claw engine.ts:6674-6693) ──
  if (role === "assistant") {
    const topLevel = msg as Record<string, unknown>;
    const stopReason =
      typeof topLevel.stopReason === "string"
        ? topLevel.stopReason
        : typeof topLevel.stop_reason === "string"
          ? topLevel.stop_reason
          : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      const content = topLevel.content;
      const isEmpty =
        content === undefined ||
        content === null ||
        content === "" ||
        (Array.isArray(content) && content.length === 0);
      if (isEmpty) {
        return null; // Skip — error/aborted with no content
      }
    }
  }

  // Store content as text — structured parts go into message_parts table.
  // Like lossless-claw: the content column has a plain-text fallback;
  // message_parts rehydrates structured/raw blocks for tool tracking.
  const content = typeof msg?.content === "string"
    ? msg.content
    : Array.isArray(msg?.content)
      ? extractTextFromContentBlocks(msg.content)
      : JSON.stringify(msg?.content ?? "");

  if (!content.trim()) return null;

  return {
    id: String(id),
    role: role as any,
    content,
    created_at: msg?.timestamp ?? msg?.created_at ?? msg?.createdAt ?? new Date().toISOString(),
    seq: typeof msg?.seq === "number" ? msg.seq : 0,
    conversation_id: msg?.conversation_id ?? msg?.conversationId ?? conversationId,
    token_count: typeof msg?.token_count === "number" ? msg.token_count : undefined,
  };
}

/** Extract human-readable text from structured content blocks for the messages.content column.
 *  Tool calls, tool results, and other structured blocks are stored in message_parts;
 *  the content column gets a plain-text fallback. */
function extractTextFromContentBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const blockType = (b.type as string) ?? "";
    if (blockType === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (blockType === "toolCall" || blockType === "tool_use") {
      const name = (b.name as string) ?? (b.toolName as string) ?? "unknown";
      parts.push(`[Tool Call: ${name}]`);
    } else if (blockType === "toolResult" || blockType === "tool_result") {
      const output = typeof b.content === "string" ? b.content : typeof b.output === "string" ? b.output : "";
      const preview = output.substring(0, 200);
      parts.push(`[Tool Result: ${preview}${output.length > 200 ? "…" : ""}]`);
    } else if (blockType === "reasoning" && typeof b.text === "string") {
      parts.push(`[Reasoning: ${b.text.substring(0, 200)}]`);
    }
  }
  return parts.join("\n") || JSON.stringify(blocks);
}

/** Build structured message_parts rows from an AgentMessage, mirroring
 *  lossless-claw's buildMessageParts (engine.ts:980-1160).
 *  Decomposes content blocks into typed parts for tool tracking. */
function buildMessageParts(params: {
  sessionId: string;
  message: any;
  fallbackContent: string;
}): import("@anima/context-engine").MessagePartInput[] {
  const { sessionId, message, fallbackContent } = params;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const topLevel = message as Record<string, unknown>;
  const topLevelToolCallId =
    (topLevel.toolCallId as string) ??
    (topLevel.tool_call_id as string) ??
    (topLevel.toolUseId as string) ??
    (topLevel.tool_use_id as string) ??
    (topLevel.call_id as string) ??
    (topLevel.id as string);
  const topLevelToolName =
    (topLevel.toolName as string) ??
    (topLevel.tool_name as string);
  const topLevelIsError =
    topLevel.isError === true ||
    topLevel.is_error === true;

  // BashExecutionMessage shape
  if (!("content" in message) && "command" in message && "output" in message) {
    return [{
      partType: "text", ordinal: 0, textContent: fallbackContent,
      metadata: JSON.stringify({ originalRole: role, source: "bash-exec", command: String((message as any).command ?? "") }),
    }];
  }

  if (!("content" in message)) {
    return [{
      partType: "agent", ordinal: 0, textContent: fallbackContent || null,
      metadata: JSON.stringify({ originalRole: role, source: "unknown-message-shape" }),
    }];
  }

  if (typeof message.content === "string") {
    return [{
      partType: "text", ordinal: 0, textContent: message.content,
      metadata: JSON.stringify({
        originalRole: role,
        toolCallId: topLevelToolCallId ?? null,
        toolName: topLevelToolName ?? null,
        isError: topLevelIsError || undefined,
      }),
    }];
  }

  if (!Array.isArray(message.content)) {
    return [{
      partType: "agent", ordinal: 0, textContent: fallbackContent || null,
      metadata: JSON.stringify({ originalRole: role, source: "non-array-content" }),
    }];
  }

  const parts: import("@anima/context-engine").MessagePartInput[] = [];
  for (let ordinal = 0; ordinal < message.content.length; ordinal++) {
    const block = message.content[ordinal] as Record<string, unknown> | null;
    if (!block || typeof block !== "object") continue;

    const rawBlockType = (block.type as string) ?? (block.partType as string) ?? "unknown";
    const partType = toPartType(rawBlockType);
    const toolCallId =
      (block.toolCallId as string) ??
      (block.tool_call_id as string) ??
      (block.toolUseId as string) ??
      (block.tool_use_id as string) ??
      (block.call_id as string) ??
      (partType === "tool" ? (block.id as string) : undefined) ??
      topLevelToolCallId;

    const toolOutput = extractToolOutput(block, partType);
    const toolInput = extractToolInput(block, partType);

    parts.push({
      partType,
      ordinal,
      textContent: (block.text as string) ?? toolOutput ?? null,
      toolCallId: toolCallId ?? null,
      toolName: ((block.name as string) ?? (block.toolName as string) ?? topLevelToolName) ?? null,
      toolStatus: (block.status as string) ?? (topLevelIsError ? "error" : null),
      toolInput: toolInput ?? null,
      toolOutput: partType === "tool" ? (toolOutput ?? null) : null,
      toolError: topLevelIsError ? (toolOutput ?? null) : null,
      metadata: JSON.stringify({ rawType: rawBlockType }),
    });
  }

  return parts;
}

/** Map content block type strings to message_parts part_type enum values. */
function toPartType(rawType: string): string {
  switch (rawType) {
    case "text": return "text";
    case "reasoning": case "reasoning_content": return "reasoning";
    case "toolCall": case "tool_call": case "tool_use": return "tool";
    case "toolResult": case "tool_result": return "tool";
    case "patch": return "patch";
    case "file": return "file";
    case "subtask": return "subtask";
    case "compaction": return "compaction";
    case "step_start": return "step_start";
    case "step_finish": return "step_finish";
    case "snapshot": return "snapshot";
    case "agent": return "agent";
    case "retry": return "retry";
    default: return "text";
  }
}

/** Extract tool output from a content block for tool_result types. */
function extractToolOutput(block: Record<string, unknown>, partType: string): string | undefined {
  if (partType !== "tool") return undefined;
  // toolResult blocks carry output in content or output field
  if (typeof block.content === "string") return block.content;
  if (typeof block.output === "string") return block.output;
  if (typeof block.result === "string") return block.result;
  if (block.content && typeof block.content === "object") return JSON.stringify(block.content);
  return undefined;
}

/** Extract tool input from a content block for tool_call types. */
function extractToolInput(block: Record<string, unknown>, _partType: string): string | undefined {
  const args = block.arguments ?? block.input ?? block.args;
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return undefined;
}

function formatMemoryRecall(entries: Array<{
  id: string;
  content: string;
  scope: string;
  tags: string[];
  confidence: number;
  source: string;
  createdAt: string;
}>): string {
  const lines: string[] = [
    "## Anima Memory Recall",
    "",
    "The following entries were recalled from the agent's shared knowledge memory.",
    "",
  ];

  for (const entry of entries) {
    lines.push(`### ${entry.scope}:${entry.id.slice(0, 8)}`);
    lines.push(`- **Source:** ${entry.source}`);
    lines.push(`- **Confidence:** ${entry.confidence}`);
    lines.push(`- **Created:** ${entry.createdAt}`);
    if (entry.tags.length > 0) {
      lines.push(`- **Tags:** ${entry.tags.join(", ")}`);
    }
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Embedding provider resolution — OpenClaw config aware             */
/* ------------------------------------------------------------------ */

interface EmbeddingProviderConfig {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  outputDimensionality?: number;
}

/** Read memorySearch config from OpenClaw runtime snapshot. Falls back to Gemini defaults. */
function readEmbeddingConfig(api: OpenClawPluginApi): EmbeddingProviderConfig {
  try {
    const cfg = api.runtime?.config?.current?.() ?? {};
    const agents = cfg.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const memorySearch = defaults?.memorySearch as Record<string, unknown> | undefined;

    // No memorySearch config → fallback to Gemini defaults
    if (!memorySearch || memorySearch.enabled === false) {
      return {
        provider: "gemini",
        model: "gemini-embedding-2",
        apiKey: resolveEnvApiKey("gemini") ?? "",
      };
    }

    const provider = (memorySearch.provider as string) ?? "gemini";

    // Resolve provider details from models.providers
    const providers = (cfg.models as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[provider] as Record<string, unknown> | undefined;

    return {
      provider,
      model: (memorySearch.model as string) ?? (providerCfg?.models as Array<{ id: string }>)?.[0]?.id ?? "gemini-embedding-2",
      apiKey: (providerCfg?.apiKey as string) ?? resolveEnvApiKey(provider) ?? "",
      baseUrl: (providerCfg?.baseUrl as string) ?? (memorySearch.remote as Record<string, string>)?.baseUrl,
      headers: (memorySearch.remote as Record<string, unknown>)?.headers as Record<string, string> | undefined,
      outputDimensionality: memorySearch.outputDimensionality as number | undefined,
    };
  } catch {
    // Ultimate fallback: Gemini with env key
    return {
      provider: "gemini",
      model: "gemini-embedding-2",
      apiKey: resolveEnvApiKey("gemini") ?? "",
    };
  }
}

/** Read compaction config from plugin config. Falls back to defaults. */
function readCompactionConfig(api: OpenClawPluginApi): PluginConfig["compactionConfig"] {
  try {
    const pluginCfg = api.pluginConfig as PluginConfig | undefined;
    if (!pluginCfg) return undefined;

    const compaction = pluginCfg.compactionConfig;
    if (!compaction) return undefined;

    // Only return known keys to avoid passing invalid config
    const allowedKeys = [
      "leafChunkTokens",
      "condensedMinFanout",
      "condensedMinFanoutHard",
      "leafTargetTokens",
      "condensedTargetTokens",
      "freshTailCount",
      "maxSweepIterations",
      "sweepDeadlineMs",
      "maxRounds",
      "compactUntilUnderDeadlineMs",
    ] as const;

    const filtered: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (compaction[key] !== undefined) {
        filtered[key] = compaction[key];
      }
    }

    return Object.keys(filtered).length > 0 ? filtered as PluginConfig["compactionConfig"] : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve API key from known env vars per provider. */
function resolveEnvApiKey(provider: string): string | undefined {
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    voyage: "VOYAGE_API_KEY",
    mistral: "MISTRAL_API_KEY",
    deepinfra: "DEEPINFRA_API_KEY",
    "github-copilot": "COPILOT_GITHUB_TOKEN",
    ollama: "OLLAMA_API_KEY",
  };
  const envVar = envMap[provider] ?? envMap[provider.split("-")[0]];
  return envVar ? process.env[envVar] : undefined;
}

/** Build EmbeddingFn from OpenClaw config. Supports openai-compatible, gemini, ollama. */
function resolveEmbeddingFn(api: OpenClawPluginApi, log?: (msg: string) => void): EmbeddingFn | undefined {
  const cfg = readEmbeddingConfig(api);
  const { provider, model, apiKey, baseUrl, headers, outputDimensionality } = cfg;

  if (!model) {
    log?.(`Embedding provider "${provider}" configured but no model found.`);
    return undefined;
  }

  if (!apiKey) {
    log?.(`Embedding provider "${provider}" no API key available.`);
    return undefined;
  }

  // OpenAI-compatible (includes OpenAI, DeepInfra, Voyage, Mistral, local proxies)
  if (provider === "openai" || provider === "openai-compatible" || provider === "deepinfra" || provider === "voyage" || provider === "mistral" || provider === "github-copilot" || (baseUrl && !provider.startsWith("gemini"))) {
    const endpoint = baseUrl
      ? `${baseUrl.replace(/\/$/, "")}/embeddings`
      : "https://api.openai.com/v1/embeddings";
    const key = apiKey ?? "";
    const modelName = model;
    const extraHeaders = headers ?? {};

    log?.(`Embedding provider: ${provider} (OpenAI-compatible) model=${modelName}`);

    return async (text: string): Promise<number[]> => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, ...extraHeaders },
        body: JSON.stringify({ model: modelName, input: text }),
      });
      if (!res.ok) throw new Error(`${provider} embedding HTTP ${res.status}`);
      const json = await res.json() as { data?: Array<{ embedding: number[] }> };
      return json.data?.[0]?.embedding ?? [];
    };
  }

  // Gemini
  if (provider === "gemini" || provider.startsWith("gemini")) {
    const key = apiKey ?? "";
    const modelName = model;
    const dims = outputDimensionality;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${key}`;

    log?.(`Embedding provider: ${provider} (Gemini) model=${modelName}`);

    return async (text: string): Promise<number[]> => {
      const body: Record<string, unknown> = { content: { parts: [{ text }] } };
      if (dims) body.outputDimensionality = dims;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Gemini embedding HTTP ${res.status}`);
      const json = await res.json() as { embedding?: { values?: number[] } };
      return json.embedding?.values ?? [];
    };
  }

  // Ollama
  if (provider === "ollama" || provider.startsWith("ollama")) {
    const endpoint = baseUrl
      ? `${baseUrl.replace(/\/$/, "")}/api/embeddings`
      : "http://localhost:11434/api/embeddings";
    const modelName = model;

    log?.(`Embedding provider: ${provider} (Ollama) model=${modelName}`);

    return async (text: string): Promise<number[]> => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embedding HTTP ${res.status}`);
      const json = await res.json() as { embedding?: number[] };
      return json.embedding ?? [];
    };
  }

  log?.(`Embedding provider "${provider}" not supported by anima adapter.`);
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Batch embedding from context.db                                    */
/* ------------------------------------------------------------------ */

async function batchEmbedFromContext(
  state: AgentPluginState,
  agentId: string,
  conversationId: string,
  log?: { info?: (m: string) => void; warn?: (m: string) => void },
): Promise<void> {
  const db = state.adapter.getDb();
  if (!db) return;

  // Get recent messages for this conversation (last 20)
  const rows = db.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE conversation_id = ?
     ORDER BY created_at DESC LIMIT 20`,
  ).all(conversationId) as Array<{ role: string; content: string; created_at: string }>;

  if (rows.length === 0) return;

  // Build a simple summary: concatenate user messages (most valuable)
  const userMessages = rows
    .filter((r) => r.role === "user")
    .map((r) => r.content?.substring(0, 300) ?? "")
    .filter((c) => c.length > 20);

  if (userMessages.length === 0) return;

  const summary = userMessages.join("\n---\n");
  const lastMsg = rows[0];
  const turnCount = rows.filter((r) => r.role === "user").length;

  await state.memoryStore.remember({
    content: summary.substring(0, 2000),
    scope: "episode" as any,
    tags: ["batch-embed", agentId, conversationId],
    confidence: 0.6,
    source: "context-batch",
    metadata: {
      conversationId,
      turnCount,
      lastMessageAt: lastMsg.created_at,
      embedMethod: "batch-from-context",
    },
  });

  log?.info?.(`[anima] batch embed OK agent=${agentId} turns=${turnCount} msgs=${userMessages.length}`);
}

/* ------------------------------------------------------------------ */
/*  Batch bridge from context.db (every 5 user turns)                 */
/* ------------------------------------------------------------------ */

async function batchBridgeFromContext(
  agentId: string,
  conversationId: string,
  batchNumber: number,
  log?: { info?: (m: string) => void; warn?: (m: string) => void },
): Promise<void> {
  const contextDbPath = resolveContextDbPath(agentId);
  if (!existsSync(contextDbPath)) return;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(contextDbPath, { readOnly: true });

    // Query the batch: offset = (batchNumber - 1) * 5, limit = 10 (5 user + 5 assistant)
    const offset = (batchNumber - 1) * EMBED_BATCH_SIZE;
    const rows = db.prepare(
      `SELECT role, content, created_at FROM messages
       WHERE conversation_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`,
    ).all(conversationId, EMBED_BATCH_SIZE * 2, offset) as Array<{ role: string; content: string; created_at: string }>;

    if (rows.length === 0) return;

    // Strip toolcalls, extract natural language
    const stripped = rows
      .map(r => stripToolcalls(r.content))
      .filter(c => c.length > 20);

    if (stripped.length === 0) return;

    const store = await getOrCreateMemoryStore(agentId);
    await store.remember({
      content: stripped.join("\n---\n").substring(0, 2000),
      scope: "episode" as any,
      tags: ["conv-bridge", agentId, conversationId, `batch-${batchNumber}`],
      confidence: 0.7,
      source: "conv-bridge",
    });

    log?.info?.(`[anima] batch bridge OK agent=${agentId} batch=${batchNumber} msgs=${stripped.length}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn?.(`[anima] batch bridge error (non-fatal): ${msg}`);
  } finally {
    if (db) try { db.close(); } catch { /* best effort */ }
  }
}

/* ------------------------------------------------------------------ */
/*  Memory Plugin Runtime — wraps AnimaMemoryStore as OC MemorySearch  */
/* ------------------------------------------------------------------ */

function createAnimaMemoryRuntime(params: {
  getMemoryStore: (agentId: string) => AnimaMemoryStore | null;
  log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}) {
  return {
    getMemorySearchManager: async (ctx: { cfg: unknown; agentId: string; purpose?: string }) => {
      const store = params.getMemoryStore(ctx.agentId);
      if (!store) return { manager: null };

      const manager = {
        search: async (query: string, opts?: { maxResults?: number; minScore?: number; sessionKey?: string }) => {
          const entries = await store.recall(query, {
            topK: opts?.maxResults ?? 5,
            minConfidence: opts?.minScore,
          });
          return entries.map((e, i) => ({
            path: `memory://${ctx.agentId}/${e.id}`,
            startLine: 0,
            endLine: 1,
            score: 1 - (i * 0.05), // decaying score by rank
            snippet: e.content.substring(0, 300),
            source: "memory" as const,
            citation: `[memory:${e.scope}:${e.id}]`,
          }));
        },
        readFile: async (_params: { relPath: string; from?: number; lines?: number }) => {
          return { text: "", path: _params.relPath, truncated: false };
        },
        status: () => {
          const stats = store.getStats();
          return {
            backend: "builtin" as const,
            provider: "anima",
            dbPath: store.getDbPath(),
            files: 0,
            chunks: Number(stats.total_neurons ?? 0),
            sources: ["memory" as const],
            vector: { enabled: false, available: false },
            fts: { enabled: true, available: true },
          };
        },
        probeEmbeddingAvailability: async () => ({ ok: false, checked: true }),
        probeVectorAvailability: async () => false,
      };
      return { manager };
    },
    resolveMemoryBackendConfig: (_ctx: { cfg: unknown; agentId: string }) => ({
      backend: "builtin" as const,
    }),
  };
}
