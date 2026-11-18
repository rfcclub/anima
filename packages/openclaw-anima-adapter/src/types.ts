/**
 * Local types for the OpenClaw Anima Adapter.
 *
 * These bridge the @anima/context-engine and OpenClaw plugin SDK concepts
 * without importing OpenClaw host types directly.
 */

import type {
  ContextEngine,
  BootstrapInput,
  BootstrapResult,
  IngestInput,
  AssembleInput,
  AssembleResult,
  CompactInput,
  CompactResult,
} from "@anima/context-engine";

/* ------------------------------------------------------------------ */
/*  MemoryScope — mirrors the contract type but kept local to avoid    */
/*  depending on @anima/context-engine's internal enum                 */
/* ------------------------------------------------------------------ */

export type MemoryScope =
  | "episode"
  | "fact"
  | "observation"
  | "scent"
  | "preference"
  | "private"
  | "scar"
  | "decision"
  | "project"
  | "heartwood"
  | "growth_ring"
  | "canopy"
  | "identity";

/* ------------------------------------------------------------------ */
/*  OpenClaw Plugin SDK — subset we use                                */
/* ------------------------------------------------------------------ */

export interface OpenClawPluginApi {
  id: string;
  pluginConfig?: unknown;
  config?: Record<string, unknown>;
  /** Typed hook registration. NOTE: in the current OpenClaw
   *  runtime this is NOT wired for external plugins — use `on` instead. */
  registerHook: (events: string | string[], handler: (event: any, ctx: any) => any, opts?: any) => void;
  /** Event subscription — the live path for external plugins (verified:
   *  conv-store + prompt-optimizer run via `on`, registerHook never fires). */
  on: (event: string, handler: (event: any, ctx: any) => any) => void;
  registerContextEngine: (id: string, factory: (ctx: any) => ContextEngine | Promise<ContextEngine>) => void;
  registerMemoryCapability?: (capability: {
    promptBuilder?: (params: { availableTools: Set<string>; citationsMode?: string }) => string[];
    flushPlanResolver?: (params: { cfg?: unknown; nowMs?: number }) => { softThresholdTokens: number; forceFlushTranscriptBytes: number; reserveTokensFloor: number; model?: string; prompt: string; systemPrompt: string; relativePath: string } | null;
    runtime?: {
      getMemorySearchManager: (params: { cfg: unknown; agentId: string; purpose?: string }) => Promise<{ manager: {
        search: (query: string, opts?: { maxResults?: number; minScore?: number; sessionKey?: string }) => Promise<Array<{ path: string; startLine: number; endLine: number; score: number; snippet: string; source: "memory" | "sessions"; citation?: string }>>;
        readFile: (params: { relPath: string; from?: number; lines?: number }) => Promise<{ text: string; path: string; truncated?: boolean }>;
        status: () => { backend: "builtin" | "qmd"; provider: string; model?: string; dbPath?: string; files?: number; chunks?: number; sources?: Array<"memory" | "sessions">; vector?: { enabled: boolean; available: boolean }; fts?: { enabled: boolean; available: boolean } };
        probeEmbeddingAvailability: () => Promise<{ ok: boolean; checked?: boolean; error?: string }>;
        probeVectorAvailability: () => Promise<boolean>;
      } | null; error?: string }>;
      resolveMemoryBackendConfig: (params: { cfg: unknown; agentId: string }) => { backend: "builtin" | "qmd" };
    };
  }) => void;
  registerTool: (
    tool: AnimaTool | ((ctx: { sessionKey: string; sessionId?: string }) => AnimaTool),
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
  runtime: {
    config: {
      loadConfig: () => Record<string, unknown>;
      current?: () => Record<string, unknown>;
    };
    llm?: {
      complete: (params: {
        system?: string;
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        agentId?: string;
      }) => Promise<{ content: string; model?: string; usage?: { inputTokens: number; outputTokens: number } }>;
    };
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface AnimaTool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: unknown[] }>;
}

/* ------------------------------------------------------------------ */
/*  Plugin config                                                      */
/* ------------------------------------------------------------------ */

export interface AnimaAdapterConfig {
  /** Base directory for agent data (~/.anima/agents) */
  dataDir?: string;
  /**
   * Agent allowlist. If set, ONLY these agents use the adapter.
   * If empty/omitted, any agent with `contextEngine: "anima"` in config
   * is automatically opted in. Use this to exclude agents
   * that use custom memory backends.
   */
  agents?: string[];
  /**
   * Gemini API key for vector embeddings. Falls back to GEMINI_API_KEY env var.
   * When absent, recall uses FTS only (no semantic vector search).
   */
  geminiApiKey?: string;
}

/* ------------------------------------------------------------------ */
/*  Re-export context-engine types for convenience                     */
/* ------------------------------------------------------------------ */

export type {
  ContextEngine,
  BootstrapInput,
  BootstrapResult,
  IngestInput,
  AssembleInput,
  AssembleResult,
  CompactInput,
  CompactResult,
};
