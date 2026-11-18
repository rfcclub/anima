/**
 * @anima/openclaw-adapter-bruno — OpenClaw plugin variant backed by an
 * bruno-entity shared DB.
 *
 * Connects to the bruno-entity DB for context engine + memory. Coexists with
 * the generic @anima/openclaw-adapter used by other agents.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { AnimaContextEngineAdapter } from "@anima/openclaw-adapter/dist/adapter.js";
import { createAnimaMemoryTools } from "@anima/openclaw-adapter/dist/tools/anima-memory-tools.js";
import { createLcmGrepTool } from "@anima/openclaw-adapter/dist/tools/lcm-grep.js";
import { createLcmDescribeTool } from "@anima/openclaw-adapter/dist/tools/lcm-describe.js";
import { createLcmExpandTool } from "@anima/openclaw-adapter/dist/tools/lcm-expand.js";
import { MemoryStoreBruno, resolveBrunoMemoryDbPath, type EmbeddingFn } from "./memory-store.js";
import type { OpenClawPluginApi, MemoryScope } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ANIMA_DATA_DIR = join(homedir(), ".anima", "agents");

function resolveContextDbPath(agentId: string): string {
  return join(ANIMA_DATA_DIR, agentId, "context.db");
}

function ensureAgentDir(agentId: string): void {
  const dir = join(ANIMA_DATA_DIR, agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/*  Per-agent state                                                    */
/* ------------------------------------------------------------------ */

interface BrunoPluginState {
  adapter: AnimaContextEngineAdapter;
  memory: MemoryStoreBruno;
  agentId: string;
}

const activeStates = new Map<string, BrunoPluginState>();

function getState(agentId: string): BrunoPluginState | null {
  return activeStates.get(agentId) ?? null;
}

function extractAgentId(sessionKey: string | undefined): string {
  if (!sessionKey) return "bruno";
  const parts = sessionKey.split(":");
  return (parts.length >= 2 && parts[0] === "agent") ? (parts[1]?.trim() || "bruno") : "bruno";
}

const pendingInit = new Map<string, Promise<BrunoPluginState>>();

async function ensureState(
  agentId: string,
  log?: { info?: (m: string) => void; warn?: (m: string) => void },
  embeddingFn?: EmbeddingFn,
  embeddingModel?: string,
): Promise<BrunoPluginState> {
  const existing = activeStates.get(agentId);
  if (existing) return existing;

  const pending = pendingInit.get(agentId);
  if (pending) return pending;

  const promise = (async () => {
    ensureAgentDir(agentId);
    const ctxPath = resolveContextDbPath(agentId);
    const memPath = resolveBrunoMemoryDbPath();

    const adapter = new AnimaContextEngineAdapter(ctxPath, log ? { info: log.info ?? (() => {}), warn: log.warn ?? (() => {}), error: () => {} } : undefined);
    const memory = new MemoryStoreBruno(memPath, agentId);

    await adapter.initialize(agentId, "openclaw");
    await memory.initialize();

    if (embeddingFn) memory.setEmbeddingFn(embeddingFn, embeddingModel ?? "gemini-embedding-2");

    const state: BrunoPluginState = { adapter, memory, agentId };
    activeStates.set(agentId, state);
    log?.info?.(`[bruno-anima] Agent "${agentId}" initialized: ctx=${ctxPath} mem=${memPath}`);
    return state;
  })();

  pendingInit.set(agentId, promise);
  try { return await promise; } finally { pendingInit.delete(agentId); }
}

/* ------------------------------------------------------------------ */
/*  Helpers — message mapping                                         */
/* ------------------------------------------------------------------ */

/** Map OC AgentMessage to context-engine MessageRecord. Keep structured content like lossless-claw. */
function mapMessage(msg: any, conversationId?: string): import("@anima/context-engine").MessageRecord | null {
  const rawRole = (msg?.role as string) ?? "user";
  const role = rawRole === "toolResult" ? "tool" : rawRole;
  const content = typeof msg?.content === "string"
    ? msg.content
    : JSON.stringify(msg?.content ?? "");
  if (!content.trim()) return null;
  return {
    id: msg?.id ?? msg?.messageId ?? crypto.randomUUID(),
    role: role as any,
    content,
    created_at: msg?.timestamp ?? msg?.created_at ?? msg?.createdAt ?? new Date().toISOString(),
    seq: typeof msg?.seq === "number" ? msg.seq : 0,
    conversation_id: msg?.conversation_id ?? msg?.conversationId ?? conversationId,
    token_count: typeof msg?.token_count === "number" ? msg.token_count : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Embedding provider                                                */
/* ------------------------------------------------------------------ */

function resolveEmbeddingFn(api: OpenClawPluginApi, log?: (msg: string) => void): EmbeddingFn | undefined {
  try {
    const cfg = (api.runtime?.config?.current?.() ?? {}) as Record<string, unknown>;
    const agents = cfg.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const memSearch = defaults?.memorySearch as Record<string, unknown> | undefined;

    const provider = (memSearch?.provider as string) ?? "gemini";
    const model = (memSearch?.model as string) ?? "gemini-embedding-2";
    const providers = (cfg.models as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[provider] as Record<string, unknown> | undefined;
    const apiKey = (providerCfg?.apiKey as string) ?? process.env.GEMINI_API_KEY ?? "";

    if (!apiKey) { log?.(`[bruno-anima] No API key for ${provider}, embeddings disabled`); return undefined; }

    log?.(`[bruno-anima] Embedding: ${provider}/${model}`);
    const endpoint = provider === "gemini" || provider.startsWith("gemini")
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`
      : `${(providerCfg?.baseUrl as string) ?? "https://api.openai.com/v1"}/embeddings`;

    return async (text: string): Promise<number[]> => {
      const body = provider === "gemini" || provider.startsWith("gemini")
        ? JSON.stringify({ content: { parts: [{ text }] } })
        : JSON.stringify({ model, input: text });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider === "gemini" || provider.startsWith("gemini")) {
        headers["x-goog-api-key"] = apiKey;
      } else {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const res = await fetch(endpoint, { method: "POST", headers, body });
      if (!res.ok) throw new Error(`${provider} embedding HTTP ${res.status}`);
      const json = await res.json() as any;
      return json.embedding?.values ?? json.data?.[0]?.embedding ?? [];
    };
  } catch (err) {
    log?.(`[bruno-anima] Embedding config error: ${String(err)}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  Batch embed from context.db                                       */
/* ------------------------------------------------------------------ */

const embedCounters = new Map<string, number>();
const EMBED_BATCH = 5;

async function batchEmbed(state: BrunoPluginState, agentId: string, conversationId: string): Promise<void> {
  const db = state.adapter.getDb();
  if (!db) return;
  const rows = db.prepare(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20",
  ).all(conversationId) as Array<{ role: string; content: string; created_at: string }>;
  if (rows.length === 0) return;

  const userMsgs = rows.filter((r) => r.role === "user").map((r) => r.content?.substring(0, 300) ?? "").filter((c) => c.length > 20);
  if (userMsgs.length === 0) return;

  await state.memory.remember({
    content: userMsgs.join("\n---\n").substring(0, 2000),
    scope: "episode",
    tags: ["batch-embed", agentId, conversationId],
    confidence: 0.6,
    source: "context-batch",
    metadata: { conversationId, turnCount: rows.filter((r) => r.role === "user").length, embedMethod: "batch-from-context" },
  });
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

const brunoAdapterPlugin = {
  id: "@anima/openclaw-adapter-bruno",
  name: "Bruno's Anima Adapter",
  description: "OpenClaw adapter that connects to an bruno-entity shared memory DB.",
  configSchema: { parse: (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}) },

  register(api: OpenClawPluginApi) {
    const embeddingFn = resolveEmbeddingFn(api, (msg) => api.logger?.info?.(`[bruno-anima] ${msg}`));

    /* ── Context engine ── */
    api.registerContextEngine("anima-bruno", (_ctx: any) => {
      let currentAgentId = "bruno";

      return {
        info: { id: "anima-bruno", name: "Bruno Anima Context Engine", version: "1.0.0", ownsCompaction: true },
        initialize: async (agentId: string) => { currentAgentId = agentId; },
        bootstrap: async (input: any) => {
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) { await ensureState(agentId, api.logger, embeddingFn); state = getState(agentId); }
          if (!state) throw new Error(`[bruno-anima] No state for ${agentId}`);
          return state.adapter.bootstrap({ conversationId: input?.sessionId ?? input?.conversationId, messages: input?.messages });
        },
        ingest: async (input: any) => {
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) { await ensureState(agentId, api.logger, embeddingFn); state = getState(agentId); }
          if (!state) throw new Error(`[bruno-anima] No state for ${agentId}`);
          const convId = input?.sessionId ?? input?.conversationId;
          const msg = mapMessage(input?.message, convId);
          if (!msg) return { ingested: false } as any;
          await state.adapter.ingest({ conversationId: convId, message: msg });

          // Batch embed from context.db
          if (input?.message?.role === "user") {
            const cnt = (embedCounters.get(agentId) ?? 0) + 1;
            embedCounters.set(agentId, cnt);
            if (cnt >= EMBED_BATCH) { embedCounters.set(agentId, 0); batchEmbed(state, agentId, convId).catch(() => {}); }
          }
          return { ingested: true } as any;
        },
        assemble: async (input: any) => {
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) { await ensureState(agentId, api.logger, embeddingFn); state = getState(agentId); }
          if (!state) throw new Error(`[bruno-anima] No state for ${agentId}`);
          return state.adapter.assemble({ conversationId: input?.sessionId ?? input?.conversationId, prompt: input?.prompt, tokenBudget: input?.tokenBudget });
        },
        compact: async (input: any) => {
          const agentId = input?.sessionKey ? extractAgentId(input.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) { await ensureState(agentId, api.logger, embeddingFn); state = getState(agentId); }
          if (!state) throw new Error(`[bruno-anima] No state for ${agentId}`);
          return state.adapter.compact({ conversationId: input?.sessionId ?? input?.conversationId, targetTokens: input?.tokenBudget, currentTokens: input?.currentTokenCount });
        },
        search: async (query: string, opts?: any) => {
          const agentId = opts?.sessionKey ? extractAgentId(opts.sessionKey) : currentAgentId;
          let state = getState(agentId);
          if (!state) { await ensureState(agentId, api.logger, embeddingFn); state = getState(agentId); }
          if (!state) return [];
          return state.adapter.search(query, opts);
        },
        checkIntegrity: async () => {
          const state = getState("bruno");
          if (!state) return { healthy: false, checks: [] };
          return state.adapter.checkIntegrity();
        },
        dispose: () => {
          const state = getState(currentAgentId);
          if (state) { state.adapter.dispose(); state.memory.close(); activeStates.delete(currentAgentId); }
        },
      };
    });

    /* ── before_prompt_build — inject memory recall ── */
    api.registerHook("before_prompt_build", async (event: any, ctx: any) => {
      const agentId = extractAgentId(ctx?.sessionKey);
      const state = getState(agentId);
      if (!state) return;
      const userMsg = event?.prompt ?? event?.userMessage;
      if (!userMsg && (!event?.messages || !Array.isArray(event.messages))) return;
      const query = typeof userMsg === "string" ? userMsg
        : event.messages.filter((m: any) => m?.role === "user").map((m: any) => m.content).join(" ").substring(0, 500);
      if (!query) return;

      try {
        const entries = await state.memory.recall(query, { topK: 5 });
        if (entries.length === 0) return;
        const lines = ["## Memory Recall", ""];
        for (const e of entries) {
          lines.push(`### ${e.scope} [${e.id}]`);
          lines.push(`- Confidence: ${e.confidence} | Source: ${e.source}`);
          lines.push(e.content.substring(0, 400));
          lines.push("");
        }
        return { prependSystemContext: lines.join("\n") };
      } catch { /* non-fatal */ }
    });

    /* ── session_end — write cross-session summary ── */
    api.registerHook("session_end", async (event: any) => {
      const agentId = extractAgentId(event?.sessionKey);
      const state = getState(agentId);
      if (!state) return;
      const sessionId = event?.sessionId ?? event?.nextSessionId;
      if (!sessionId) return;
      try {
        const compact = await state.adapter.compact({ conversationId: sessionId });
        if (!compact.compacted || compact.summariesCreated === 0) return;
        await state.memory.remember({
          content: `Session ${sessionId}: ${compact.summariesCreated} summaries (${compact.tokensBefore}→${compact.tokensAfter} tokens)`,
          scope: "episode",
          tags: ["session-end", agentId],
          confidence: 0.7,
          source: "session-end",
          metadata: { sessionId, tokensBefore: compact.tokensBefore, tokensAfter: compact.tokensAfter },
        });
        api.logger?.info?.(`[bruno-anima] Session summary written for ${agentId}`);
      } catch { /* non-fatal */ }
    });

    /* ── Tools ── */
    const toolCtx = (ctx: any) => extractAgentId(ctx?.sessionKey);

    // Get or create a database getter for a given agentId
    const dbGetter = (agentId: string) => () => getState(agentId)?.adapter.getDb() ?? null;

    api.registerTool((ctx: any) => createLcmGrepTool(dbGetter(toolCtx(ctx))), { name: "lcm_grep" });
    api.registerTool((ctx: any) => createLcmDescribeTool(dbGetter(toolCtx(ctx))), { name: "lcm_describe" });
    api.registerTool((ctx: any) => createLcmExpandTool(dbGetter(toolCtx(ctx))), { name: "lcm_expand" });

    // Anima memory tools — each registered with a factory that resolves
    // the calling agent from session context, preventing cross-agent IDOR.
    const dummyMemCtx = { sessionKey: "agent:bruno:0" };
    const templateTools = createAnimaMemoryTools(() => {
      const state = getState("bruno");
      return state ? { adapter: state.adapter, memoryStore: state.memory as any, agentId: state.agentId, platform: "openclaw" } : null;
    });
    for (const template of templateTools) {
      const toolName = template.name;
      api.registerTool((ctx: any) => {
        const agentId = toolCtx(ctx);
        return createAnimaMemoryTools(() => {
          const state = getState(agentId);
          return state ? { adapter: state.adapter, memoryStore: state.memory as any, agentId: state.agentId, platform: "openclaw" } : null;
        }).find(t => t.name === toolName)!;
      }, { name: toolName });
    }

    api.logger?.info?.("[bruno-anima] Plugin registered: Bruno-Anima (3 LCM + 19 memory + 2 hooks) → bruno-entity");
  },
};

export default brunoAdapterPlugin;
