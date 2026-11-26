import type {
  Provider, ProviderChunk, ProviderMessage, ProviderPermissionHandler, ProviderRequest,
  ProviderResponse, ProviderTool, ProviderToolCall, ProviderToolDefinition,
} from "../providers/interface";
import { isAsyncGenerator } from "../utils/async-generator";
import { executeTool, type ExecuteToolOptions } from "../tools/executor";

export type TurnEvent =
  | { type: "text-delta"; content: string }
  | { type: "tool-call"; call: ProviderToolCall; iteration: number }
  | { type: "tool-result"; call: ProviderToolCall; result: string; iteration: number; blocked: boolean }
  | { type: "provider-chunk"; chunk: ProviderChunk }
  | { type: "tools-disabled"; calls: ProviderToolCall[] }
  | { type: "done"; response: ProviderResponse }
  | { type: "error"; error: unknown };

/** Execution only: turn preparation, finalization and MCP lifetime belong to the caller. */
export interface TurnContext {
  provider: Provider;
  messages: ProviderMessage[];
  tools: Array<ProviderToolDefinition | ProviderTool>;
  policy: ExecuteToolOptions["policy"];
  agentName: string;
  cwd: string;
  sessionId?: string;
  mode: ProviderRequest["mode"];
  model?: string;
  system?: string;
  cachePrefix?: string;
  staticHash?: string;
  signal?: AbortSignal;
  memoryStore?: ExecuteToolOptions["memoryStore"];
  contextEngine?: ExecuteToolOptions["contextEngine"];
  webChatClient?: ExecuteToolOptions["webChatClient"];
  guard?: ProviderPermissionHandler;
  mcpManager?: {
    getTools(): ProviderTool[];
    callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  };
  limits: { maxIterations: number };
  /** Compatibility differences are explicit; changing them requires a behavior-change intent. */
  surface?: { kind: "stream"; disableTools?: boolean } | {
    kind: "talk"; first: ProviderResponse; onRoundError?: (round: number, error: unknown) => void;
  };
  /** Trusted legacy talk adapter seam. Production callers use the real executor below. */
  execute?: (call: ProviderToolCall) => Promise<string>;
  onEvent?: (event: TurnEvent) => void;
}

/** One sequential execution loop for response, stream and CLI talk adapters. */
export class TurnRunner {
  async *run(context: TurnContext): AsyncGenerator<TurnEvent> {
    const messages = [...context.messages];
    const mcpToolNames = new Set(context.mcpManager?.getTools().map((tool) => tool.name) ?? []);
    const emit = (event: TurnEvent): TurnEvent => { context.onEvent?.(event); return event; };
    const surface = context.surface;
    const talk = surface?.kind === "talk";
    let lastResponse: ProviderResponse | undefined;
    try {
      for (let iteration = 0; iteration < context.limits.maxIterations + (talk ? 1 : 0); iteration++) {
        if (context.signal?.aborted) {
          if (lastResponse) { yield emit({ type: "done", response: lastResponse }); return; }
          throw new Error("the turn was aborted before the provider was called");
        }
        let response: ProviderResponse;
        try {
          response = talk && iteration === 0 ? surface.first : yield* queryTurn(context, messages, emit);
        } catch (error) {
          // Talk historically recovers only post-tool query failures, never execution failures.
          if (!talk || !lastResponse) throw error;
          surface.onRoundError?.(iteration, error);
          yield emit({ type: "done", response: lastResponse }); return;
        }
        lastResponse = response;
        if (!response.tool_calls?.length || context.signal?.aborted || (talk && iteration >= context.limits.maxIterations)) {
          yield emit({ type: "done", response }); return;
        }
        if (surface?.kind === "stream" && surface.disableTools) {
          yield emit({ type: "tools-disabled", calls: response.tool_calls });
          yield emit({ type: "done", response }); return;
        }
        messages.push({
          role: "assistant", content: surface?.kind === "stream" ? response.message.content || null : response.message.content ?? null,
          tool_calls: response.tool_calls.map((tc) => ({
            id: tc.id, type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        for (const call of response.tool_calls) {
          if (context.signal?.aborted) break;
          yield emit({ type: "tool-call", call, iteration });
          if (context.signal?.aborted) break;
          if (context.guard) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(call.arguments); } catch {}
            const decision = await context.guard(call.name, input);
            if (context.signal?.aborted) break;
            if (!decision.allow) {
              const result = `Error: tool blocked — ${decision.message ?? "not allowed"}`;
              messages.push({ role: "tool", tool_call_id: call.id, content: result });
              yield emit({ type: "tool-result", call, result, iteration, blocked: true });
              continue;
            }
          }
          let result: string;
          if (context.mcpManager && mcpToolNames.has(call.name)) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(call.arguments); } catch {}
            result = formatMcpToolResult(await context.mcpManager.callTool(call.name, input));
          } else {
            result = context.execute ? await context.execute(call) : await executeTool(call, {
              cwd: context.cwd, agentName: context.agentName, sessionId: context.sessionId,
              signal: context.signal, webChatClient: context.webChatClient,
              memoryStore: context.memoryStore, contextEngine: context.contextEngine, policy: context.policy,
            });
          }
          yield emit({ type: "tool-result", call, result, iteration, blocked: false });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }
      if (talk) {
        yield emit({ type: "done", response: lastResponse ?? surface.first }); return;
      }
      if (surface?.kind === "stream" && lastResponse) {
        yield emit({ type: "done", response: lastResponse }); return;
      }
      throw new Error(`tool loop exceeded ${context.limits.maxIterations} iterations`);
    } catch (error) {
      yield emit({ type: "error", error });
    }
  }
}

/** Native chunks remain transport events, distinct from fatal execution errors. */
async function* queryTurn(
  context: TurnContext, messages: ProviderMessage[], emit: (event: TurnEvent) => TurnEvent,
): AsyncGenerator<TurnEvent, ProviderResponse> {
  const result = context.provider.query({
    agent: context.agentName, sessionId: context.sessionId, mode: context.mode,
    cwd: context.cwd, model: context.model, system: context.system,
    cachePrefix: context.cachePrefix, staticHash: context.staticHash,
    messages, tools: context.tools.length > 0 ? context.tools : undefined,
    canUseTool: context.guard, signal: context.signal,
  });
  if (context.surface?.kind === "stream") {
    let rawText = "";
    const calls: ProviderToolCall[] = [];
    let usage: ProviderResponse["usage"];
    // Inspect the original query return, just like the former streamProviderQuery.
    if (isAsyncGenerator<ProviderChunk>(result)) {
      for await (const chunk of result) {
        if (!(context.surface.disableTools && chunk.type === "tool_call")) {
          yield emit({ type: "provider-chunk", chunk });
        }
        if (chunk.type === "text" && chunk.content) rawText += chunk.content;
        if (chunk.type === "tool_call" && chunk.tool_call) calls.push(chunk.tool_call);
        if (chunk.usage) usage = chunk.usage;
      }
      return { message: { role: "assistant", content: rawText }, tool_calls: calls, usage };
    }
    const response = await result as ProviderResponse;
    rawText = typeof response.message.content === "string" ? response.message.content
      : response.message.content == null ? "" : JSON.stringify(response.message.content);
    yield emit({ type: "provider-chunk", chunk: { type: "text", content: rawText } });
    return { ...response, message: { ...response.message, content: rawText } };
  }
  const response = await result;
  if (isAsyncGenerator(response)) {
    throw new Error("streaming provider responses are not supported by AgentSession.runToolLoop");
  }
  if (context.surface?.kind !== "talk" && typeof response.message.content === "string") {
    yield emit({ type: "text-delta", content: response.message.content });
  }
  return response;
}

function formatMcpToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content
      .filter((item): item is { type: string; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text).join("\n");
    if (text.length > 0) return text;
  }
  return JSON.stringify(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
