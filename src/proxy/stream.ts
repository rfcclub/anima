import type { ProviderDef } from "../config/types";
import type { ProviderMessage, ProviderRequest, ProviderTool, ProviderToolDefinition } from "../providers/interface";

type Protocol = "anthropic" | "openai";

function providerProtocol(api: string): Protocol {
  return api === "anthropic-messages" ? "anthropic" : "openai";
}

export async function streamProxyRequest(
  req: ProviderRequest,
  def: ProviderDef,
  inbound: Protocol,
  signal?: AbortSignal,
): Promise<Response> {
  const upstream = providerProtocol(def.api);
  const url = buildUrl(def, upstream);
  const headers = buildHeaders(req, def, upstream);
  const body = buildBody(req, def, upstream);

  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(300_000)])
    : AbortSignal.timeout(300_000);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (err) {
    throw err;
  }

  if (!upstreamResp.ok || !upstreamResp.body) {
    const text = await upstreamResp.text().catch(() => "upstream error");
    const encoder = new TextEncoder();
    const errorSse = buildErrorSse(upstreamResp.status, text, inbound);
    return new Response(
      new ReadableStream({ start(c) { c.enqueue(encoder.encode(errorSse)); c.close(); } }),
      { headers: sseHeaders() },
    );
  }

  // Same protocol → passthrough bytes
  if (upstream === inbound) {
    return new Response(upstreamResp.body, { headers: sseHeaders() });
  }

  // Cross-protocol → transform
  const modelId = req.model ?? def.models[0]?.id ?? "unknown";
  const transform = upstream === "openai" && inbound === "anthropic"
    ? openAIToAnthropicTransform(modelId)
    : anthropicToOpenAITransform(modelId);

  return new Response(upstreamResp.body.pipeThrough(transform), { headers: sseHeaders() });
}

// ── URL & headers ─────────────────────────────────────────────────────────────

function buildUrl(def: ProviderDef, upstream: Protocol): string {
  const defaultEndpoint = upstream === "anthropic" ? "/v1/messages" : "/chat/completions";
  return `${def.baseUrl}${def.endpoint ?? defaultEndpoint}`;
}

function buildHeaders(req: ProviderRequest, def: ProviderDef, upstream: Protocol): Record<string, string> {
  const base: Record<string, string> = upstream === "anthropic"
    ? { "x-api-key": def.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
    : { "Authorization": `Bearer ${def.apiKey}`, "Content-Type": "application/json" };
  return {
    ...base,
    ...def.headers,
    ...(isOpenCodeGo(def) ? { "x-opencode-session": openCodeSessionId(req) } : {}),
  };
}

function isOpenCodeGo(def: ProviderDef): boolean {
  return def.id === "opencode-go-oai" || def.baseUrl.includes("opencode.ai/zen/go");
}

function openCodeSessionId(req: ProviderRequest): string {
  return req.sessionId?.trim() || `anima:${req.agent}`;
}

function sseHeaders(): Record<string, string> {
  return { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" };
}

// ── Request body builders ─────────────────────────────────────────────────────

function buildBody(req: ProviderRequest, def: ProviderDef, upstream: Protocol): Record<string, unknown> {
  const modelId = req.model ?? def.models[0]?.id ?? "";
  return upstream === "anthropic"
    ? buildAnthropicBody(req, modelId)
    : buildOpenAIBody(req, modelId);
}

function buildAnthropicBody(req: ProviderRequest, modelId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: req.messages.map(anthropicMsg),
    max_tokens: 16384,
    stream: true,
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: (t as ProviderTool).input_schema ?? (t as ProviderToolDefinition).parameters ?? {},
    }));
  }
  return body;
}

function buildOpenAIBody(req: ProviderRequest, modelId: string): Record<string, unknown> {
  const messages: unknown[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push(...req.messages.map(openAIMsg));

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: (t as ProviderToolDefinition).parameters ?? (t as ProviderTool).input_schema ?? {},
      },
    }));
  }
  return body;
}

function anthropicMsg(msg: ProviderMessage): unknown {
  if (msg.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content }] };
  }
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const content: unknown[] = [];
    if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content });
    for (const tc of msg.tool_calls) {
      let input: unknown;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
    return { role: "assistant", content };
  }
  return { role: msg.role, content: msg.content };
}

function openAIMsg(msg: ProviderMessage): unknown {
  if (msg.role === "tool") {
    return { role: "tool", tool_call_id: msg.tool_call_id, content: typeof msg.content === "string" ? msg.content : "" };
  }
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    return {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }
  return { role: msg.role, content: msg.content };
}

// ── SSE event parsing ─────────────────────────────────────────────────────────

function parseSse(raw: string): { event?: string; data?: string } {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  return { event, data };
}

// ── OpenAI SSE → Anthropic SSE ───────────────────────────────────────────────

function openAIToAnthropicTransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const msgId = `msg_${Math.random().toString(36).slice(2, 12)}`;
  let buffer = "";
  let started = false;
  let inputTokens = 0;
  let outputTokens = 0;

  function emit(event: string, data: object): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const { data } = parseSse(part.trim());
        if (!data || data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { continue; }

        const choice = (parsed.choices as any[])?.[0];
        const delta = choice?.delta as Record<string, unknown> | undefined;
        const finishReason = choice?.finish_reason as string | null;
        const usage = parsed.usage as Record<string, number> | undefined;

        if (!started && delta) {
          started = true;
          controller.enqueue(emit("message_start", {
            type: "message_start",
            message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
          }));
          controller.enqueue(emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          controller.enqueue(emit("ping", { type: "ping" }));
        }

        if (typeof delta?.content === "string" && delta.content) {
          controller.enqueue(emit("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          }));
        }

        if (usage) {
          inputTokens = (usage.prompt_tokens ?? 0);
          outputTokens = (usage.completion_tokens ?? 0);
        }

        if (finishReason) {
          controller.enqueue(emit("content_block_stop", { type: "content_block_stop", index: 0 }));
          controller.enqueue(emit("message_delta", {
            type: "message_delta",
            delta: { stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }));
          controller.enqueue(emit("message_stop", { type: "message_stop" }));
        }
      }
    },
  });
}

// ── Anthropic SSE → OpenAI SSE ───────────────────────────────────────────────

function anthropicToOpenAITransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const chatId = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;

  function emitData(data: object): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  function chunk(delta: object, finish: string | null = null): object {
    return { id: chatId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  return new TransformStream({
    transform(c, controller) {
      buffer += decoder.decode(c, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const { event, data } = parseSse(part.trim());
        if (!data || data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { continue; }

        if (event === "message_start") {
          inputTokens = ((parsed.message as any)?.usage?.input_tokens ?? 0);
          controller.enqueue(emitData(chunk({ role: "assistant", content: "" })));
        } else if (event === "content_block_delta") {
          const text = (parsed.delta as any)?.text;
          if (typeof text === "string") controller.enqueue(emitData(chunk({ content: text })));
        } else if (event === "message_delta") {
          outputTokens = (parsed.usage as any)?.output_tokens ?? 0;
          const stopReason = (parsed.delta as any)?.stop_reason;
          controller.enqueue(emitData(chunk({}, stopReason === "tool_use" ? "tool_calls" : "stop")));
          controller.enqueue(emitData({
            ...chunk({}, null),
            usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
          }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      }
    },
  });
}

// ── Error SSE ─────────────────────────────────────────────────────────────────

function buildErrorSse(status: number, message: string, protocol: Protocol): string {
  if (protocol === "anthropic") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream ${status}: ${message}` } })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message: `upstream ${status}: ${message}`, type: "api_error" } })}\n\ndata: [DONE]\n\n`;
}
