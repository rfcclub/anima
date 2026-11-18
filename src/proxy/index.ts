import type { ProviderChunk, ProviderResponse, ProviderToolCall } from "../providers/interface";
import { ProviderError } from "../providers/interface";
import type { ProviderRegistry } from "../providers/registry";
import { parseAnthropicRequest, type AnthropicMessagesBody } from "./anthropic-inbound";
import { parseOpenAIRequest, type OpenAIChatBody } from "./openai-inbound";
import { toAnthropicResponse, toAnthropicStream } from "./anthropic-outbound";
import { toOpenAIChatResponse, toOpenAIChatStream } from "./openai-outbound";
import { mapProviderError } from "./errors";
import { resolveModel } from "./model-resolver";
import { resolveOverride } from "./model-override";
import { detectCaller } from "./caller";
import { streamProxyRequest } from "./stream";

export async function handleProxyRequest(req: Request, registry: ProviderRegistry): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const caller = detectCaller(req);

  if (req.method !== "POST") {
    return Response.json({ error: { message: "method not allowed", type: "invalid_request_error" } }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  if (pathname === "/ai/v1/messages") {
    return handleAnthropic(body as AnthropicMessagesBody, registry, req, caller);
  }

  if (pathname === "/ai/v1/chat/completions" || pathname === "/ai/v1/responses") {
    return handleOpenAI(body as OpenAIChatBody, registry, req, caller);
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function handleAnthropic(
  body: AnthropicMessagesBody,
  registry: ProviderRegistry,
  httpReq: Request,
  caller: string,
): Promise<Response> {
  const { req, stream } = parseAnthropicRequest(body, caller);

  // Override resolution runs before registry lookup
  const override = await resolveOverride(body.model, registry);
  const resolved = override ?? resolveModel(body.model, registry);

  if (!resolved) {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: `model not found: ${body.model}` } },
      { status: 400 },
    );
  }

  if (override) {
    process.stderr.write(JSON.stringify({ level: "info", msg: "proxy override", from: body.model, to: `${resolved.providerDef.id}/${resolved.modelId}`, caller }) + "\n");
  }

  req.model = resolved.modelId;

  try {
    if (stream) {
      return await streamProxyRequest(req, resolved.providerDef, "anthropic", httpReq.signal);
    }

    const result = resolved.provider.query(req);
    const res = isAsyncGenerator(result) ? await collectChunks(result) : await result;
    return Response.json(toAnthropicResponse(res, resolved.modelId));
  } catch (err) {
    if (err instanceof ProviderError) return mapProviderError(err, "anthropic");
    return Response.json(
      { type: "error", error: { type: "api_error", message: String(err) } },
      { status: 500 },
    );
  }
}

async function handleOpenAI(
  body: OpenAIChatBody,
  registry: ProviderRegistry,
  httpReq: Request,
  caller: string,
): Promise<Response> {
  const { req, stream } = parseOpenAIRequest(body, caller);

  const override = await resolveOverride(body.model, registry);
  const resolved = override ?? resolveModel(body.model, registry);

  if (!resolved) {
    return Response.json(
      { error: { message: `model not found: ${body.model}`, type: "invalid_request_error", code: "model_not_found" } },
      { status: 400 },
    );
  }

  if (override) {
    process.stderr.write(JSON.stringify({ level: "info", msg: "proxy override", from: body.model, to: `${resolved.providerDef.id}/${resolved.modelId}`, caller }) + "\n");
  }

  req.model = resolved.modelId;

  try {
    if (stream) {
      return await streamProxyRequest(req, resolved.providerDef, "openai", httpReq.signal);
    }

    const result = resolved.provider.query(req);
    const res = isAsyncGenerator(result) ? await collectChunks(result) : await result;
    return Response.json(toOpenAIChatResponse(res, resolved.modelId));
  } catch (err) {
    if (err instanceof ProviderError) return mapProviderError(err, "openai");
    return Response.json(
      { error: { message: String(err), type: "api_error", code: "internal_error" } },
      { status: 500 },
    );
  }
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<ProviderChunk> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

async function collectChunks(gen: AsyncGenerator<ProviderChunk>): Promise<ProviderResponse> {
  let text = "";
  let usage: ProviderResponse["usage"] | undefined;
  const toolCalls: ProviderToolCall[] = [];

  for await (const chunk of gen) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
    const tc = chunk.tool_call ?? chunk.tool_use;
    if (tc) toolCalls.push(tc);
    if (chunk.usage) usage = chunk.usage;
  }

  return {
    message: { role: "assistant", content: text },
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}
