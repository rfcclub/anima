import { denyNativeCarrier } from "../web-chat/tool-boundary";
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type PermissionMode as ClaudePermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import {
  ProviderError,
  type Provider,
  type ProviderErrorCode,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderToolCall,
} from "./interface";

type LogFields = Record<string, unknown>;

export interface AnthropicProviderOptions {
  roomsDir?: string;
  log?: (level: "info" | "error", msg: string, fields?: LogFields) => void;
}

/** @deprecated Use AnthropicProviderOptions */
export type ClaudeProviderOptions = AnthropicProviderOptions;

export class AnthropicProvider implements Provider {
  readonly name = "claude" as const;

  private readonly roomsDir: string;
  private readonly log: (level: "info" | "error", msg: string, fields?: LogFields) => void;

  constructor(options: AnthropicProviderOptions = {}) {
    this.roomsDir = options.roomsDir ?? join(process.cwd(), "rooms");
    this.log = options.log ?? structuredLog;
  }

  async query(req: ProviderRequest): Promise<ProviderResponse> {
    denyNativeCarrier();
    const startedAt = Date.now();
    this.log("info", "claude query start", { agent: req.agent, mode: req.mode });

    try {
      const systemMessages: ProviderMessage[] = [];
      const conversationMessages: ProviderMessage[] = [];
      for (const message of req.messages) {
        if (message.role === "system") {
          systemMessages.push(message);
        } else {
          conversationMessages.push(message);
        }
      }

      const extraSystemContent = systemMessages.length > 0
        ? systemMessages
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n\n")
        : "";

      let systemPrompt: string | string[] | undefined;
      if (req.cachePrefix && req.system) {
        const dynamicPart = req.system.slice(req.cachePrefix.length);
        const parts: string[] = [req.cachePrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
        if (dynamicPart.trim()) parts.push(dynamicPart);
        if (extraSystemContent) parts.push(extraSystemContent);
        systemPrompt = parts;
      } else {
        let sp = req.system;
        if (extraSystemContent) {
          sp = sp ? `${sp}\n\n---\n\n${extraSystemContent}` : extraSystemContent;
        }
        systemPrompt = sp;
      }

      const prompt = conversationMessages.map(formatPromptMessage).join("\n\n").trim();
      let resultText = "";
      let assistantMessage: ProviderMessage | undefined;
      let toolCalls: ProviderToolCall[] | undefined;
      let usage: ProviderResponse["usage"];

      const stream = query({
        prompt,
        options: {
          cwd: req.cwd ?? process.cwd(),
          model: req.model,
          systemPrompt: systemPrompt,
          tools: req.tools?.map(t => t.name),
          permissionMode: toClaudePermissionMode(req.mode),
          allowedTools: req.mode === "auto" ? undefined : [],
          canUseTool: req.canUseTool
            ? async (toolName, input) => {
                const decision = await req.canUseTool!(toolName, input);
                if (decision.allow) {
                  return { behavior: "allow" };
                }
                return {
                  behavior: "deny",
                  message: decision.message ?? `tool '${toolName}' is blocked for this agent`,
                };
              }
            : undefined,
          sandbox: {
            enabled: true,
            filesystem: {
              denyWrite: [join(this.roomsDir, req.agent, "mount", "**")],
            },
          },
        },
      });

      if (req.signal) {
        req.signal.addEventListener("abort", () => {
          stream.close();
        }, { once: true });
      }

      for await (const message of stream) {
        if (message.type === "assistant") {
          toolCalls = extractToolCalls(message);
          assistantMessage = {
            role: "assistant",
            content: extractAssistantText(message),
          };
        }

        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
            const modelUsageEntries = Object.values(message.modelUsage ?? {});
            usage = {
              input_tokens: message.usage.input_tokens,
              output_tokens: message.usage.output_tokens,
              cache_read_tokens: modelUsageEntries.reduce((s, m) => s + (m.cacheReadInputTokens ?? 0), 0),
              cache_write_tokens: modelUsageEntries.reduce((s, m) => s + (m.cacheCreationInputTokens ?? 0), 0),
              // For the cost ledger only: one entry per model the SDK reports. The four counts
              // above stay the aggregate and are not billed again when `models` is present.
              models: Object.entries(message.modelUsage ?? {}).map(([model, m]) => ({
                model,
                input_tokens: m.inputTokens ?? 0,
                output_tokens: m.outputTokens ?? 0,
                cache_read_tokens: m.cacheReadInputTokens ?? 0,
                cache_write_tokens: m.cacheCreationInputTokens ?? 0,
              })),
              input_includes_cache: false,
              cache_categories_reported: true,
            };
          } else {
            throw providerErrorFromResult(message);
          }
        }
      }

      const response = {
        message: assistantMessage ?? { role: "assistant" as const, content: resultText },
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        usage,
      };

      this.log("info", "claude query complete", {
        agent: req.agent,
        mode: req.mode,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const providerError = toProviderError(error);
      this.log("error", "claude query failed", {
        agent: req.agent,
        mode: req.mode,
        code: providerError.code,
        retryable: providerError.retryable,
        durationMs: Date.now() - startedAt,
      });
      throw providerError;
    }
  }
}

function formatPromptMessage(message: ProviderMessage): string {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  return `${message.role.toUpperCase()}:\n${content}`;
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return message.message.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractToolCalls(message: Extract<SDKMessage, { type: "assistant" }>): ProviderToolCall[] {
  return message.message.content
    .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => {
      return block.type === "tool_use" && typeof (block as any).id === "string" && typeof (block as any).name === "string";
    })
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    }));
}

function toClaudePermissionMode(mode: ProviderRequest["mode"]): ClaudePermissionMode {
  switch (mode) {
    case "plan":
      return "plan";
    case "auto":
      return "auto";
    case "edit":
      return "dontAsk";
  }
}

function providerErrorFromResult(message: Extract<SDKMessage, { type: "result"; subtype: string }>): ProviderError {
  const text = "errors" in message ? message.errors.join("; ") : "Claude query failed";
  const status = "api_error_status" in message ? message.api_error_status : undefined;
  return new ProviderError(errorCodeFromStatus(status, text), "claude", text || "Claude query failed");
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = readStatus(error);
  return new ProviderError(errorCodeFromStatus(status, message), "claude", message);
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown; api_error_status?: unknown };
  for (const value of [candidate.status, candidate.statusCode, candidate.api_error_status]) {
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function errorCodeFromStatus(status: number | null | undefined, message: string): ProviderErrorCode {
  const lower = message.toLowerCase();
  if (status === 401 || status === 403 || lower.includes("auth") || lower.includes("api key")) {
    return "AUTH_ERROR";
  }
  if (status === 429 && (lower.includes("quota") || lower.includes("billing") || lower.includes("credit"))) {
    return "QUOTA_EXHAUSTED";
  }
  if (status === 429 || lower.includes("rate limit")) {
    return "RATE_LIMITED";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return "TIMEOUT";
  }
  return "SERVER_ERROR";
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

/** @deprecated Use AnthropicProvider */
export const ClaudeProvider = AnthropicProvider;
