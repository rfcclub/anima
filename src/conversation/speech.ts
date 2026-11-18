import { detectDecline, extractSpokenText } from "../narrative/vn-response";
import type { Provider, ProviderChunk, ProviderResponse } from "../providers/interface";
import { MAX_GENERATED_SPEECH_CHARS, type SharedContextResult } from "./context";

/** Fresh per-invocation identity — conversation, branch,
 *  speaker, request and beat — never an agent-global fallback. */
export interface SharedSpeechInvocation {
  conversationId: string;
  branchId: string;
  speakerId: string;
  requestId: string;
  beatIndex: number;
}

export interface GenerateSharedSpeechOptions {
  provider: Provider;
  /** Passed through as ProviderRequest.agent for logging/routing only. */
  agentId: string;
  context: SharedContextResult;
  invocation: SharedSpeechInvocation;
  signal?: AbortSignal;
}

export type SharedSpeechOutcome =
  | { kind: "spoken"; text: string }
  | { kind: "declined" }
  | { kind: "unsupported"; reason: "shared_provider_unsupported" }
  | { kind: "rejected"; reason: string };

// 60s was too tight against a reasoning model
// (GLM-5.3-Flash) on a non-trivial prompt — the abort itself counted as a
// circuit-breaker failure and, combined with the 2-failure threshold,
// locked out every subsequent request (including trivial ones) for the
// full 5-minute cooldown. Raised to give real replies room to finish.
const SPEECH_TIMEOUT_MS = 5 * 60_000;

function sharedInvocationSessionId(inv: SharedSpeechInvocation): string {
  return `shared:${inv.conversationId}:${inv.branchId}:${inv.speakerId}:${inv.requestId}:${inv.beatIndex}`;
}

function isAsyncGenerator(value: AsyncGenerator<ProviderChunk> | Promise<ProviderResponse>): value is AsyncGenerator<ProviderChunk> {
  return typeof (value as AsyncGenerator<ProviderChunk>)[Symbol.asyncIterator] === "function";
}

interface CollectedOutput {
  ok: boolean;
  text: string;
  reason?: string;
}

/** Stricter than the general-purpose proxy collector: any tool_call/tool_use
 *  or error chunk fails the whole outcome — no partial speech is ever
 *  committed. */
async function collectStreamed(gen: AsyncGenerator<ProviderChunk>): Promise<CollectedOutput> {
  let text = "";
  for await (const chunk of gen) {
    if (chunk.type === "tool_call" || chunk.type === "tool_use") {
      return { ok: false, text: "", reason: "shared speech rejected: provider attempted tool use" };
    }
    if (chunk.type === "error") {
      return { ok: false, text: "", reason: chunk.error ?? "shared speech rejected: provider error chunk" };
    }
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return { ok: true, text };
}

function collectNonStreamed(response: ProviderResponse): CollectedOutput {
  if (response.tool_calls && response.tool_calls.length > 0) {
    return { ok: false, text: "", reason: "shared speech rejected: provider response included tool_calls" };
  }
  const content = response.message.content;
  return { ok: true, text: typeof content === "string" ? content : "" };
}

/** The one bounded speech runner for
 *  shared (room-scoped) conversation turns. Deliberately does not call
 *  AgentSession.prepareTurn — its inputs are exactly one SharedContextResult
 *  (already ACL-checked, already budgeted, already public-identity-only) and
 *  one fresh per-invocation session id. No private store, tool registry or
 *  identity-runtime handle is reachable from this function's type signature,
 *  which is itself part of the isolation guarantee, not just its behavior. */
export async function generateSharedSpeech(opts: GenerateSharedSpeechOptions): Promise<SharedSpeechOutcome> {
  if (!opts.provider.sharedSafe) {
    return { kind: "unsupported", reason: "shared_provider_unsupported" };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), SPEECH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutController.signal]) : timeoutController.signal;

  let collected: CollectedOutput;
  try {
    const result = opts.provider.query({
      agent: opts.agentId,
      sessionId: sharedInvocationSessionId(opts.invocation),
      mode: "plan",
      tools: [],
      canUseTool: () => ({ allow: false, message: "shared speech never grants tool permissions" }),
      system: opts.context.systemText,
      messages: [{
        role: "user",
        content: `${opts.context.historyBlockJson}\n\n${opts.context.userText}`,
      }],
      signal,
    });
    collected = isAsyncGenerator(result) ? await collectStreamed(result) : collectNonStreamed(await result);
  } catch (error) {
    return { kind: "rejected", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }

  if (!collected.ok) {
    return { kind: "rejected", reason: collected.reason ?? "shared speech rejected" };
  }

  // vn-response.ts (existing, separately tested parser): extractSpokenText
  // strips narration/thinking wrapped around a VN JSON block, returning only
  // the `text` field (or empty on an empty `text`) — proven safe by this
  // module's own tests before reuse.
  if (detectDecline(collected.text)) {
    return { kind: "declined" };
  }
  const spoken = extractSpokenText(collected.text).trim();
  if (!spoken) {
    return { kind: "rejected", reason: "shared speech rejected: empty output" };
  }
  if (spoken.length > MAX_GENERATED_SPEECH_CHARS) {
    return { kind: "rejected", reason: `shared speech rejected: output exceeds ${MAX_GENERATED_SPEECH_CHARS} characters` };
  }
  return { kind: "spoken", text: spoken };
}
