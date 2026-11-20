import { version } from "../../package.json";
import type { ProviderDef, ProviderModelDef } from "../config/types";
import { ProviderError, type Provider, type ProviderMessage, type ProviderRequest, type ProviderResponse } from "./interface";

export function openCodeGoMetadata(
  config: Pick<ProviderDef, "id" | "baseUrl">,
  request: Pick<ProviderRequest, "agent" | "sessionId">,
): { userAgent: string; sessionId: string } | undefined {
  if (config.id !== "opencode-go-oai") {
    const url = URL.parse(config.baseUrl);
    if (url?.origin !== "https://opencode.ai" || !/^\/zen\/go(?:\/|$)/.test(url.pathname)) {
      return undefined;
    }
  }

  const agent = /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(request.agent) ? request.agent : "agent";
  const clientVersion = /^[a-z0-9][a-z0-9.+-]{0,63}$/i.test(version) ? version : "unknown";
  return {
    userAgent: `anima/${clientVersion} (${agent})`,
    sessionId: request.sessionId?.trim() || `anima:${request.agent}`,
  };
}

export class OpenAIv1ChatProvider implements Provider {
  readonly name: string;
  readonly sharedSafe: boolean;

  constructor(private readonly config: ProviderDef) {
    this.name = config.id;
    this.sharedSafe = config.sharedSafe ?? false;
  }

  // Providers using api: anthropic-messages that require explicit cache_control breakpoints.
  // OpenAI-format providers (exampleprov, neuralwatt, opencode) rely on backend prefix-stability caching — no injection needed.
  private static readonly CACHE_CONTROL_PROVIDERS = new Set(["anthropic", "xiaomi", "minimax"]);

  private get isAnthropic(): boolean {
    return this.config.api === "anthropic-messages";
  }

  async query(req: ProviderRequest): Promise<ProviderResponse> {
    const model = this.modelFor(req.model);
    const effortTokens: Record<string, number> = { fast: 512, normal: 4096, deep: 16384 };
    const maxTokens = req.effort ? effortTokens[req.effort] : undefined;

    const body = this.isAnthropic
      ? this.buildAnthropicBody(req, model, maxTokens)
      : this.buildOpenAIBody(req, model, maxTokens);

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 300_000);
    const signal = req.signal
      ? AbortSignal.any([req.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      const useCache = !!(req.cachePrefix && OpenAIv1ChatProvider.CACHE_CONTROL_PROVIDERS.has(this.config.id));
      const headers: Record<string, string> = this.isAnthropic
        ? {
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            ...(useCache ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
          }
        : {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          };

      const configuredHeaders = { ...headers, ...this.config.headers };
      const metadata = openCodeGoMetadata(this.config, req);
      let requestHeaders: HeadersInit = configuredHeaders;
      if (metadata) {
        const openCodeHeaders = new Headers(configuredHeaders);
        openCodeHeaders.set("User-Agent", metadata.userAgent);
        openCodeHeaders.set("x-opencode-session", metadata.sessionId);
        requestHeaders = openCodeHeaders;
      }

      response = await fetch(this.url(), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError("TIMEOUT", this.config.id, error.message);
      }
      throw new ProviderError("SERVER_ERROR", this.config.id, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new ProviderError(statusToCode(response.status), this.config.id, await response.text());
    }

    const parsed = !this.isAnthropic && body.stream === true
      ? await parseOpenAISSEStream(response)
      : await response.json();
    return this.isAnthropic
      ? this.parseAnthropicResponse(parsed as AnthropicResponse, model.id)
      : this.parseOpenAIResponse(parsed as OpenAIChatResponse, model.id);
  }

  // ── OpenAI body ──────────────────────────────────────────────────────────

  private buildOpenAIBody(req: ProviderRequest, model: ProviderModelDef, maxTokens?: number): Record<string, unknown> {
    const body: Record<string, unknown> = {
      // Default only — config (extraParams) can override, e.g. providers
      // that reject non-streaming requests with "streaming_required"
      // (openference/GLM). Must stay FIRST so the spreads below can win.
      stream: false,
      ...this.config.extraParams,
      ...model.extraParams,
      model: model.id,
      messages: this.messagesFor(req).map((m) => stripReasoningContent(m as Record<string, unknown>)),
      ...(req.promptCacheKey || req.agent ? { prompt_cache_key: req.promptCacheKey || req.agent } : {}),
      ...(req.tools ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: 'parameters' in t ? t.parameters : t.input_schema } })) } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    };
    // Streaming needs stream_options.include_usage or the final chunk never
    // carries usage — cost tracking would silently go blind.
    if (body.stream === true && body.stream_options === undefined) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private parseOpenAIResponse(parsed: OpenAIChatResponse, sentModel?: string): ProviderResponse {
    const message = parsed.choices?.[0]?.message;
    if (!message) {
      throw new ProviderError("SERVER_ERROR", this.config.id, "OpenAI-compatible response missing choices[0].message");
    }

    let tool_calls = message.tool_calls?.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));

    if ((!tool_calls || tool_calls.length === 0) && message.content) {
      const parsedXml = parseXmlToolCalls(message.content);
      if (parsedXml.length > 0) tool_calls = parsedXml;
    }

    // DeepSeek reports prompt_cache_hit_tokens / prompt_cache_miss_tokens.
    // OpenAI reports prompt_tokens_details.cached_tokens.
    // Normalize both into cache_read_tokens. DeepSeek doesn't report cache_write
    // separately (disk cache is write-through), so cache_write stays undefined.
    const cacheRead =
      (parsed.usage as any)?.prompt_cache_hit_tokens ??
      parsed.usage?.prompt_tokens_details?.cached_tokens ??
      undefined;

    return {
      message: { role: message.role ?? "assistant", content: message.content ?? "" },
      tool_calls: tool_calls,
      usage: parsed.usage
        ? {
            input_tokens: parsed.usage.prompt_tokens ?? 0,
            output_tokens: parsed.usage.completion_tokens ?? 0,
            cache_read_tokens: cacheRead,
            // For the cost ledger only: the serving model, and that prompt_tokens already
            // contains the cached tokens (OpenAI cached_tokens, DeepSeek prompt_cache_hit_tokens
            // are subsets of it). The four counts above keep their public meaning.
            model: parsed.model ?? sentModel,
            input_includes_cache: true,
            cache_categories_reported: true,
            input_reported: typeof parsed.usage.prompt_tokens === "number",
            output_reported: typeof parsed.usage.completion_tokens === "number",
          }
        : undefined,
    };
  }

  // ── Anthropic body ───────────────────────────────────────────────────────

  private buildAnthropicBody(req: ProviderRequest, model: ProviderModelDef, maxTokens?: number): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: model.id,
      messages: this.buildAnthropicMessages(req),
      max_tokens: maxTokens ?? 16384, // required field in Anthropic API spec
    };

    // System prompt at top level with optional cache_control
    if (req.system) {
      const useCache = req.cachePrefix && OpenAIv1ChatProvider.CACHE_CONTROL_PROVIDERS.has(this.config.id);
      if (useCache) {
        const blocks: Array<Record<string, unknown>> = [
          { type: "text", text: req.cachePrefix!, cache_control: { type: "ephemeral" } },
        ];
        const dynamicPart = req.system.slice(req.cachePrefix!.length);
        if (dynamicPart.trim()) {
          blocks.push({ type: "text", text: dynamicPart });
        }
        body.system = blocks;
      } else {
        body.system = req.system;
      }
    }

    // Tools in Anthropic format — tag last tool with cache_control so the
    // stable tool list stays cached across turns (Reasonix invariant).
    if (req.tools && req.tools.length > 0) {
      const useCache = req.cachePrefix && OpenAIv1ChatProvider.CACHE_CONTROL_PROVIDERS.has(this.config.id);
      body.tools = req.tools.map((t, i) => {
        const def: Record<string, unknown> = {
          name: t.name,
          description: t.description,
          input_schema: 'parameters' in t ? t.parameters : t.input_schema,
        };
        // Tag the last tool definition with cache_control — Anthropic caches
        // up to 4 breakpoints; system + tools + last message = 3.
        if (useCache && i === req.tools!.length - 1) {
          (def as any).cache_control = { type: "ephemeral" };
        }
        return def;
      });
    }

    return body;
  }

  private buildAnthropicMessages(req: ProviderRequest): unknown[] {
    const useCacheControl = req.cachePrefix && OpenAIv1ChatProvider.CACHE_CONTROL_PROVIDERS.has(this.config.id);
    const out: unknown[] = [];
    const msgs = req.messages;

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;

      // Batch consecutive tool results into one user turn (Anthropic requires this).
      if (msg.role === "tool") {
        const toolResults: Array<Record<string, unknown>> = [];
        while (i < msgs.length && msgs[i]!.role === "tool") {
          const tm = msgs[i]!;
          toolResults.push({ type: "tool_result", tool_use_id: tm.tool_call_id, content: tm.content });
          i++;
        }
        i--; // outer loop will increment
        out.push({ role: "user", content: toolResults });
        continue;
      }

      // Tag the LAST non-tool message's content blocks with cache_control so the
      // append-only log prefix stays cached (Reasonix AppendOnlyLog invariant).
      const isLast = i === msgs.length - 1 || msgs.slice(i + 1).every(m => m.role === "tool");
      const tagCache = !!useCacheControl && isLast;
      out.push(this.serializeAnthropicMessage(msg, tagCache));
    }
    return out;
  }

  private serializeAnthropicMessage(msg: ProviderMessage, tagCache = false): unknown {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      const rawText = typeof msg.content === "string" ? msg.content : "";
      const cleanText = rawText.includes("<think>") ? stripThinkTags(rawText) : rawText;
      if (cleanText.trim()) {
        const block: Record<string, unknown> = { type: "text", text: cleanText };
        if (tagCache) (block as any).cache_control = { type: "ephemeral" };
        content.push(block);
      }
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      return { role: "assistant", content };
    }
    if (msg.role === "tool") {
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content }],
      };
    }
    const text = typeof msg.content === "string" && msg.content.includes("<think>")
      ? stripThinkTags(msg.content) : msg.content;
    if (tagCache && typeof text === "string") {
      return { role: msg.role, content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
    }
    return { role: msg.role, content: text };
  }

  private parseAnthropicResponse(parsed: AnthropicResponse, sentModel?: string): ProviderResponse {
    const content = parsed.content ?? [];
    const textParts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    for (const block of content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    // Fallback: MiniMax returns tool calls as <minimax:tool_call> XML inside text blocks
    if (toolCalls.length === 0 && textParts.length > 0) {
      const joined = textParts.join("");
      if (joined.includes("<minimax:tool_call>")) {
        const parsed2 = parseMiniMaxToolCalls(joined);
        if (parsed2.length > 0) {
          const cleanText = joined.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "").trim();
          return {
            message: { role: "assistant", content: cleanText },
            tool_calls: parsed2,
            usage: parsed.usage ? {
              input_tokens: parsed.usage.input_tokens ?? 0,
              output_tokens: parsed.usage.output_tokens ?? 0,
              cache_read_tokens: parsed.usage.cache_read_input_tokens ?? undefined,
              cache_write_tokens: (parsed.usage as any).cache_creation_input_tokens ?? undefined,
              model: parsed.model ?? sentModel,
              input_includes_cache: false,
              cache_categories_reported: true,
              input_reported: typeof parsed.usage.input_tokens === "number",
              output_reported: typeof parsed.usage.output_tokens === "number",
            } : undefined,
          };
        }
      }
    }

    return {
      message: { role: "assistant", content: textParts.join("") },
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: parsed.usage
        ? {
            input_tokens: parsed.usage.input_tokens ?? 0,
            output_tokens: parsed.usage.output_tokens ?? 0,
            cache_read_tokens: parsed.usage.cache_read_input_tokens ?? undefined,
            cache_write_tokens: (parsed.usage as any).cache_creation_input_tokens ?? undefined,
            // For the cost ledger only: Anthropic input_tokens excludes the cache categories.
            model: parsed.model ?? sentModel,
            input_includes_cache: false,
            cache_categories_reported: true,
            input_reported: typeof parsed.usage.input_tokens === "number",
            output_reported: typeof parsed.usage.output_tokens === "number",
          }
        : undefined,
    };
  }

  // ── Shared helpers ───────────────────────────────────────────────────────

  private modelFor(modelId: string | undefined): ProviderModelDef {
    if (!modelId) {
      return this.config.models[0];
    }
    return this.config.models.find((model) => model.id === modelId) ?? { id: modelId };
  }

  private messagesFor(req: ProviderRequest): unknown[] {
    const useCacheControl = req.cachePrefix && OpenAIv1ChatProvider.CACHE_CONTROL_PROVIDERS.has(this.config.id);
    const out: unknown[] = [];
    if (req.system) {
      if (useCacheControl) {
        const dynamicPart = req.system.slice(req.cachePrefix!.length);
        const blocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [
          { type: "text", text: req.cachePrefix!, cache_control: { type: "ephemeral" } },
        ];
        if (dynamicPart.trim()) {
          blocks.push({ type: "text", text: dynamicPart });
        }
        out.push({ role: "system", content: blocks });
      } else {
        out.push({ role: "system", content: req.system });
      }
    }
    // Tag the LAST message with cache_control for append-only caching
    const lastIdx = req.messages.length - 1;
    for (let i = 0; i < req.messages.length; i++) {
      const tagCache = !!useCacheControl && i === lastIdx;
      out.push(serializeMessage(req.messages[i]!, tagCache));
    }
    return out;
  }

  private url(): string {
    const defaultEndpoint = this.isAnthropic ? "/v1/messages" : "/chat/completions";
    return `${this.config.baseUrl}${this.config.endpoint ?? defaultEndpoint}`;
  }
}

// ── OpenAI message serialization ───────────────────────────────────────────

function serializeMessage(msg: ProviderMessage, tagCache = false): unknown {
  if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
    const serialized: Record<string, unknown> = {
      role: "assistant",
      tool_calls: msg.tool_calls,
    };
    if (msg.content && typeof msg.content === "string" && msg.content.trim() !== "") {
      // OpenAI path: wrap in content blocks array with cache_control
      if (tagCache) {
        serialized.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      } else {
        serialized.content = msg.content;
      }
    }
    return serialized;
  }
  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: msg.tool_call_id,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    };
  }
  if (tagCache && typeof msg.content === "string") {
    return {
      role: msg.role,
      content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }],
      ...(msg.name ? { name: msg.name } : {}),
    };
  }
  return {
    role: msg.role,
    content: msg.content,
    ...(msg.name ? { name: msg.name } : {}),
  };
}

// Strip <think>...</think> blocks from content strings (DeepSeek-R1 / thinking models).
// These are volatile scratch — never useful in history and inflate prompt tokens significantly.
function stripThinkTags(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripReasoningContent(msg: Record<string, unknown>): Record<string, unknown> {
  const { reasoning_content, reasoning, ...rest } = msg as Record<string, unknown> & { reasoning_content?: unknown; reasoning?: unknown };
  if (typeof rest.content === "string" && rest.content.includes("<think>")) {
    rest.content = stripThinkTags(rest.content);
  }
  return rest;
}

// ── MiniMax tool call parser ───────────────────────────────────────────────
// MiniMax returns tool calls as XML inside text: <minimax:tool_call><invoke name="...">...</invoke></minimax:tool_call>
// Arguments can be JSON body or <parameter name="key">value</parameter> children.

function parseMiniMaxToolCalls(content: string): Array<{ id: string; name: string; arguments: string }> {
  const results: Array<{ id: string; name: string; arguments: string }> = [];
  const outerRegex = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/g;
  let outerMatch: RegExpExecArray | null;

  while ((outerMatch = outerRegex.exec(content)) !== null) {
    const inner = outerMatch[1]!.trim();
    const invokeMatch = inner.match(/<invoke\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/invoke>/);
    if (!invokeMatch) continue;

    const name = invokeMatch[1]!.trim();
    const body = invokeMatch[2]!.trim();
    if (!name) continue;

    let args: Record<string, unknown> = {};

    // Try JSON first
    if (body.startsWith("{")) {
      try { args = JSON.parse(body); } catch { /* fall through */ }
    }

    // Try <parameter name="key">value</parameter> children
    if (Object.keys(args).length === 0 && body.includes("<parameter")) {
      const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRegex.exec(body)) !== null) {
        const key = pm[1]!;
        const val = pm[2]!.trim();
        try { args[key] = JSON.parse(val); } catch { args[key] = val; }
      }
    }

    results.push({
      id: `mm_${name}_${results.length}`,
      name,
      arguments: JSON.stringify(args),
    });
  }

  return results;
}

// ── XML tool call fallback ─────────────────────────────────────────────────

function parseXmlToolCalls(content: string): Array<{ id: string; name: string; arguments: string }> {
  const xmlToolRegex = /<(?<tag>read|write|edit|bash|grep|glob|task|agent|anima_remember|anima_recall)\b[^>]*>(?<arg>.*?)<\/\1>/gs;
  const matches = content.matchAll(xmlToolRegex);
  const results: Array<{ id: string; name: string; arguments: string }> = [];
  for (const m of matches) {
    const tag = m.groups!.tag;
    const arg = m.groups!.arg.trim();
    let args = {};
    const colonMatch = arg.match(/^(?:file[:_]?path|file|command|content)\s*[:=]\s*(.+)$/im);
    if (colonMatch) {
      if (tag === "read" || tag === "grep" || tag === "glob") {
        args = { file_path: colonMatch[1].trim() };
      } else if (tag === "write" || tag === "edit") {
        args = { file_path: colonMatch[1].trim() };
      } else if (tag === "bash") {
        args = { command: colonMatch[1].trim() };
      }
    } else {
      try { args = JSON.parse(arg); } catch {
        if (tag === "read" || tag === "grep" || tag === "glob") {
          args = { file_path: arg };
        } else if (tag === "bash") {
          args = { command: arg };
        } else {
          args = { query: arg };
        }
      }
    }
    results.push({
      id: `xml_${tag}_${results.length}`,
      name: tag,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    });
  }
  return results;
}

// ── Response types ─────────────────────────────────────────────────────────

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  /** The model that served the request, when the API says so. */
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
}

interface AnthropicResponse {
  /** The model that served the request, when the API says so. */
  model?: string;
  content?: Array<{
    type: "text";
    text: string;
  } | {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ── Util ───────────────────────────────────────────────────────────────────

function statusToCode(status: number): "RATE_LIMITED" | "AUTH_ERROR" | "SERVER_ERROR" {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "AUTH_ERROR";
  return "SERVER_ERROR";
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

// ── OpenAI SSE stream parsing ───────────────────────────────────────────────
// Reconstructs an OpenAIChatResponse-shaped object from a streamed
// chat.completion.chunk SSE body, so parseOpenAIResponse() (tool-call XML
// fallback, cache-token normalization, etc.) needs zero changes — this is
// purely "how do we get `parsed`", not a new response shape.

async function parseOpenAISSEStream(response: Response): Promise<OpenAIChatResponse> {
  if (!response.body) {
    throw new ProviderError("SERVER_ERROR", "unknown", "SSE response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let role: string | undefined;
  let content = "";
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  let usage: OpenAIChatResponse["usage"];
  let servedModel: string | undefined;

  const consumeEvent = (raw: string) => {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (typeof parsed.model === "string") servedModel = parsed.model;
      const choice = (parsed.choices as any[])?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.role === "string") role = delta.role;
      if (typeof delta?.content === "string") content += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls as any[]) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const existing = toolCalls.get(idx) ?? { arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") existing.arguments += tc.function.arguments;
          toolCalls.set(idx, existing);
        }
      }
      if (parsed.usage) {
        const u = parsed.usage as Record<string, unknown>;
        usage = {
          // an absent count stays absent here so the parser can tell it from a measured zero
          prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
          completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
          prompt_tokens_details: u.prompt_tokens_details as { cached_tokens?: number } | undefined,
          prompt_cache_hit_tokens: typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : undefined,
        };
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) consumeEvent(event);
  }
  if (buffer.trim()) consumeEvent(buffer);

  const sortedToolCalls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({ id: tc.id ?? "", function: { name: tc.name ?? "", arguments: tc.arguments } }));

  return {
    choices: [
      {
        message: {
          role: (role as "assistant" | undefined) ?? "assistant",
          content: content || null,
          tool_calls: sortedToolCalls.length > 0 ? sortedToolCalls : undefined,
        },
      },
    ],
    model: servedModel,
    usage,
  };
}

/** @deprecated Use OpenAIv1ChatProvider */
export const OpenAICompatProvider = OpenAIv1ChatProvider;
