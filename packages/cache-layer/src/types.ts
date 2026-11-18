export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface CacheableMessage {
  role: string;
  content: string | TextBlock[] | unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  cache_control?: { type: "ephemeral" };
  [key: string]: unknown;
}

export interface CacheOptions {
  enabled: boolean;
}

export interface NormalizedUsage {
  cache_read_tokens: number | undefined;
  cache_write_tokens: number | undefined;
}

export type UsageFormat = "anthropic" | "openai" | "deepseek";

export const ANTHROPIC_CACHE_BREAKPOINT_LIMIT = 4;
