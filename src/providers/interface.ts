import type { PermissionMode } from "../config/types";

export type ProviderName = "claude" | "gemini" | "qwen" | "codex" | "router" | (string & {});
export type ProviderType = string;

export type ProviderErrorCode =
  | "QUOTA_EXHAUSTED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH_ERROR";

/** Maps each error code to whether it is safe to retry. */
const RETRYABLE_CODES: Record<ProviderErrorCode, boolean> = {
  QUOTA_EXHAUSTED: true,
  SERVER_ERROR: true,
  TIMEOUT: true,
  RATE_LIMITED: true,
  AUTH_ERROR: false,
};

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: ProviderName,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return RETRYABLE_CODES[this.code];
  }
}

export interface ProviderToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ProviderMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; [key: string]: unknown }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ProviderToolCallRef[];
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface ProviderTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderPermissionDecision {
  allow: boolean;
  message?: string;
}

export type ProviderPermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ProviderPermissionDecision> | ProviderPermissionDecision;

/** Links a call to the castle work it was made for (anima #135), so a work's cost can be summed across sessions. */
export interface WorkCallLink {
  workId: string;
  jobId: string;
  claimId: string;
  sessionNo: number;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  tools?: Array<ProviderToolDefinition | ProviderTool>;
  system?: string;
  /** Agent name (e.g. "cleo") for logging and routing. */
  agent: string;
  /** Stable conversation identity for providers that use session-aware routing. */
  sessionId?: string;
  /** The permission mode the agent is operating in. */
  mode: PermissionMode;
  /** Working directory for provider execution. */
  cwd?: string;
  /** Provider model override. */
  model?: string;
  /** Optional provider-level permission gate called before tool execution. */
  canUseTool?: ProviderPermissionHandler;
  /** Optional signal to cancel an in-flight query. */
  signal?: AbortSignal;
  /** The castle work this call is made for; recorded on the call's ledger row. */
  work?: WorkCallLink;
  /** Extended thinking budget (Claude only). */
  thinking?: { budget: 'low' | 'medium' | 'high' };
  /** Response effort tier — maps to max_tokens. */
  effort?: 'fast' | 'normal' | 'deep';
  /** Cache key for the static prefix. Set by providers that support cache_control breakpoints (DeepSeek, MiniMax, Anthropic). */
  staticHash?: string;
  /** Optional provider routing key for a shared headless prompt and its granted tool schemas. */
  promptCacheKey?: string;
  /** Static prefix portion of system prompt. Providers with cache_control use this as the cacheable block. Must be a prefix of `system`. */
  cachePrefix?: string;
}

/** One model's usage inside a result that spans several models. */
export interface ProviderUsageModel {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/**
 * Token usage as the provider reports it. The four counts keep their public
 * meaning; the optional fields below only tell the cost ledger how to read them
 * (cost-ledger-accuracy, anima #134) and are never sent to callers of the proxy.
 */
export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** The model that actually served the request, when the API says so. */
  model?: string;
  /** Per-model usage when one result spans several models. The four counts above are then their aggregate and are not billed again. */
  models?: ProviderUsageModel[];
  /** `input_tokens` already includes cached tokens (OpenAI `prompt_tokens`). */
  input_includes_cache?: boolean;
  /** The wire format carries cache categories, so a missing one means none were used. */
  cache_categories_reported?: boolean;
  /** `false` when the wire carried no input / output count: the public `input_tokens` / `output_tokens` are then
   *  0 for callers, but the ledger records the count as unknown (cost-ledger-accuracy CL-9). */
  input_reported?: boolean;
  output_reported?: boolean;
}

export interface ProviderResponse {
  message: ProviderMessage;
  tool_calls?: ProviderToolCall[];
  usage?: ProviderUsage;
}

/** A single streaming chunk from a provider. */
export interface ProviderChunk {
  type: "text" | "tool_call" | "tool_use" | "error";
  content?: string;
  tool_call?: ProviderToolCall;
  tool_use?: ProviderToolCall;
  error?: string;
  /** Final usage stats (set on last chunk by streaming providers that support it). */
  usage?: ProviderUsage;
}

/**
 * Provider interface that all provider implementations must implement.
 *
 * `query()` may return either:
 * - A `Promise<ProviderResponse>` for non-streaming providers
 * - An `AsyncGenerator<ProviderChunk>` for streaming providers
 */
export interface Provider {
  readonly name: ProviderName;
  /** design.md §5.2: explicit opt-in capability for the room-scoped-context-
   *  channels shared speech runner — caller-only prompt, no implicit local
   *  boot, no native tools, no hidden conversation resume. Absent/false fails
   *  closed with `shared_provider_unsupported` before any provider.query call.
   *  Protocol compatibility (e.g. speaking OpenAI's chat format) never implies
   *  this on its own; it must be explicitly configured true per endpoint. */
  readonly sharedSafe?: boolean;
  query(
    req: ProviderRequest,
  ): AsyncGenerator<ProviderChunk> | Promise<ProviderResponse>;
}

/** Convenience: check if the retryable flag on a thrown error is true. */
export function isRetryableError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable;
}
