/**
 * The session model gateway (rfcclub/anima#238, cartridge-worker-dispatch): the only way an external task worker
 * reaches a model. One OpenAI-compatible listener per session on 127.0.0.1, gated by an unguessable bearer token,
 * serving only the work's pinned provider and model. It reuses `src/proxy`'s OpenAI translation but not its model
 * resolver or overrides, so the pin cannot be bypassed. The token is a bearer capability shared with the worker's
 * tools; it is never logged.
 *
 * Admission fails closed: a call is admitted only while the lease and generation hold (`admit`) and the admitted
 * calls (each counted from admission, so in-flight ones too) stay within the session budget. `revoke()` refuses new calls and aborts in-flight
 * ones; an aborted call may already have reached the provider, so it is recorded as uncertain, never as unsent.
 */

import { timingSafeEqual } from "node:crypto";
import type { Provider, ProviderChunk, ProviderResponse, ProviderToolCall, WorkCallLink } from "../providers/interface";
import { parseOpenAIRequest, type OpenAIChatBody } from "../proxy/openai-inbound";
import { toOpenAIChatResponse } from "../proxy/openai-outbound";

export interface GatewayCall {
  status: "ok" | "failed" | "uncertain";
  link: WorkCallLink;
}

export interface SessionGatewayOptions {
  /** The work's pinned provider. */
  provider: Provider;
  /** The work's pinned model; a request for any other model is refused. */
  model: string;
  /** Admitted calls allowed for the session, in flight included. */
  budget: number;
  /** Attributes every call to the work and session (the provider's ledger row). */
  link: WorkCallLink;
  /** True while the session holds the lease and the current generation. */
  admit: () => boolean;
  onCall?: (call: GatewayCall) => void;
  log?: (line: string) => void;
}

export interface SessionGateway {
  /** `http://127.0.0.1:<port>` once started. */
  url: string;
  token: string;
  start(): Promise<void>;
  revoke(): void;
  stop(): Promise<void>;
  stats(): { admitted: number; inFlight: number; revoked: boolean };
}

const ROUTE = "/v1/chat/completions";

function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function sameToken(header: string | null, token: string): boolean {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The cap on a worker's request body; the worker is untrusted, so the default (about 128 MiB) is too generous. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks the shape `parseOpenAIRequest` relies on, so a malformed request is refused before admission instead of
 * throwing inside the provider call (where it would spend budget and be recorded as a provider failure).
 */
export function validChatBody(body: unknown): body is OpenAIChatBody {
  if (!isObject(body) || !Array.isArray(body.messages)) return false;
  for (const m of body.messages) {
    if (!isObject(m) || typeof m.role !== "string" || !ROLES.has(m.role)) return false;
    if (m.content !== null && m.content !== undefined && typeof m.content !== "string") return false;
    if (m.tool_calls !== undefined && m.tool_calls !== null) {
      if (!Array.isArray(m.tool_calls)) return false;
      for (const tc of m.tool_calls) {
        if (!isObject(tc) || typeof tc.id !== "string" || !isObject(tc.function)) return false;
        if (typeof tc.function.name !== "string" || typeof tc.function.arguments !== "string") return false;
      }
    }
  }
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) return false;
    for (const t of body.tools) {
      if (!isObject(t) || !isObject(t.function) || typeof t.function.name !== "string") return false;
    }
  }
  return true;
}

const error = (status: number, message: string) => Response.json({ error: { message, type: "invalid_request_error" } }, { status });

export function createSessionGateway(options: SessionGatewayOptions): SessionGateway {
  const token = newToken();
  const controller = new AbortController();
  let server: ReturnType<typeof Bun.serve> | null = null;
  let admitted = 0;
  let inFlight = 0;
  let revoked = false;
  const log = (line: string) => options.log?.(line);
  const record = (status: GatewayCall["status"]) => options.onCall?.({ status, link: options.link });

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || path !== ROUTE) return error(404, "not found");
    if (revoked || !sameToken(req.headers.get("authorization"), token)) return error(401, "unauthorized");
    let body: OpenAIChatBody;
    try {
      body = await req.json() as OpenAIChatBody;
    } catch {
      return error(400, "invalid JSON body");
    }
    if (body?.model !== options.model) return error(400, `this session serves only ${options.model}`);
    if (!validChatBody(body)) return error(400, "malformed chat completion request");
    let parsed: ReturnType<typeof parseOpenAIRequest>;
    try {
      parsed = parseOpenAIRequest(body, "work-gateway");
    } catch {
      return error(400, "malformed chat completion request");
    }
    // The body may arrive after a revoke; such a request was never admitted, so refuse it here.
    if (revoked) return error(401, "unauthorized");
    if (!options.admit()) return error(409, "the session no longer holds the work");
    if (admitted >= options.budget) return error(429, "the session's model-call budget is spent");
    admitted++;
    inFlight++;
    try {
      const { req: providerReq, stream } = parsed;
      providerReq.model = options.model;
      providerReq.work = options.link;
      providerReq.signal = controller.signal;
      const result = options.provider.query(providerReq);
      const res = isAsyncGenerator(result) ? await collect(result) : await result;
      if (revoked) throw new RevokedError();
      record("ok");
      return stream
        ? new Response(toolCallStream(res, options.model), { headers: { "content-type": "text/event-stream" } })
        : Response.json(toOpenAIChatResponse(res, options.model));
    } catch (err) {
      if (revoked || controller.signal.aborted || err instanceof RevokedError) {
        record("uncertain");
        return error(503, "the session's gateway was revoked");
      }
      record("failed");
      return error(502, "the provider call failed");
    } finally {
      inFlight--;
    }
  }

  const gateway: SessionGateway = {
    url: "",
    token,
    async start() {
      if (server) return;
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        fetch: async (req) => {
          const res = await handle(req);
          log(`${req.method} ${new URL(req.url).pathname} ${res.status} admitted=${admitted} inFlight=${inFlight}`);
          return res;
        },
      });
      gateway.url = `http://127.0.0.1:${server.port}`;
    },
    revoke() {
      revoked = true;
      controller.abort();
    },
    async stop() {
      gateway.revoke();
      server?.stop(true);
      server = null;
    },
    stats: () => ({ admitted, inFlight, revoked }),
  };
  return gateway;
}

class RevokedError extends Error {}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<ProviderChunk> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

async function collect(gen: AsyncGenerator<ProviderChunk>): Promise<ProviderResponse> {
  let text = "";
  let usage: ProviderResponse["usage"] | undefined;
  const toolCalls: ProviderToolCall[] = [];
  for await (const chunk of gen) {
    if (chunk.type === "error") throw new Error(chunk.error ?? "provider stream error");
    if (chunk.type === "text" && chunk.content) text += chunk.content;
    const call = chunk.tool_call ?? chunk.tool_use;
    if (call) toolCalls.push(call);
    if (chunk.usage) usage = chunk.usage;
  }
  return { message: { role: "assistant", content: text }, tool_calls: toolCalls.length > 0 ? toolCalls : undefined, usage };
}

/**
 * The buffered response as an OpenAI SSE stream, tool calls included: one content delta, one delta per tool call
 * (index, id, name, arguments), then the finish reason. `src/proxy`'s stream helper is text-only, which would drop
 * the tool calls a worker's tool loop needs.
 */
function toolCallStream(res: ProviderResponse, model: string): ReadableStream {
  const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const text = typeof res.message.content === "string" ? res.message.content : "";
  const calls = res.tool_calls ?? [];
  const events = [
    chunk({ role: "assistant", content: text }, null),
    ...calls.map((tc, index) => chunk({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }, null)),
    chunk({}, calls.length > 0 ? "tool_calls" : "stop"),
    "data: [DONE]\n\n",
  ];
  return new Response(events.join("")).body!;
}
