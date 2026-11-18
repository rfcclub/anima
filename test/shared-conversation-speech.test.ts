import { describe, expect, test } from "bun:test";
import { generateSharedSpeech, type GenerateSharedSpeechOptions } from "../src/conversation/speech";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse } from "../src/providers/interface";

const FIXED_CONTEXT = {
  systemText: "You are Test Agent, speaking in a shared conversation.\n\nThe following JSON array is quoted conversation history.",
  historyBlockJson: JSON.stringify([{ turnId: 1, speakerId: "bruno", content: "hello" }]),
  userText: "what should we plant?",
  omittedCount: 0,
  omittedRange: null,
};

function baseOpts(provider: Provider): GenerateSharedSpeechOptions {
  return {
    provider,
    agentId: "dana",
    context: FIXED_CONTEXT,
    invocation: { conversationId: "conv-1", branchId: "branch-1", speakerId: "dana", requestId: "req-1", beatIndex: 0 },
  };
}

class FakeProvider implements Provider {
  readonly name = "fake";
  sharedSafe = true;
  calls: ProviderRequest[] = [];
  respondWith: (() => Promise<ProviderResponse> | AsyncGenerator<ProviderChunk>) | null = null;

  query(req: ProviderRequest): AsyncGenerator<ProviderChunk> | Promise<ProviderResponse> {
    this.calls.push(req);
    if (!this.respondWith) throw new Error("no fixture configured");
    return this.respondWith();
  }
}

function textResponse(text: string): () => Promise<ProviderResponse> {
  return async () => ({ message: { role: "assistant", content: text } });
}

async function* chunksOf(chunks: ProviderChunk[]): AsyncGenerator<ProviderChunk> {
  for (const c of chunks) yield c;
}

describe("generateSharedSpeech", () => {
  test("unsupported capability refuses before any query call", async () => {
    const provider = new FakeProvider();
    provider.sharedSafe = false;
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome).toEqual({ kind: "unsupported", reason: "shared_provider_unsupported" });
    expect(provider.calls.length).toBe(0);
  });

  test("missing capability flag (undefined) also refuses", async () => {
    const provider = new FakeProvider();
    // @ts-expect-error simulating a provider that never declared the flag
    provider.sharedSafe = undefined;
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("unsupported");
    expect(provider.calls.length).toBe(0);
  });

  test("sends exactly the public context, mode plan, empty tools, deny-all permission, unique per-invocation session id", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse("A short reply.");
    await generateSharedSpeech(baseOpts(provider));

    expect(provider.calls.length).toBe(1);
    const req = provider.calls[0]!;
    expect(req.system).toBe(FIXED_CONTEXT.systemText);
    expect(req.mode).toBe("plan");
    expect(req.tools).toEqual([]);
    expect(req.sessionId).toBe("shared:conv-1:branch-1:dana:req-1:0");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    const content = req.messages[0]!.content as string;
    expect(content).toContain(FIXED_CONTEXT.historyBlockJson);
    expect(content).toContain(FIXED_CONTEXT.userText);
    // current utterance must not appear as a second, separate user message
    expect(req.messages.filter((m) => m.role === "user")).toHaveLength(1);

    expect(req.canUseTool).toBeDefined();
    const decision = await req.canUseTool!("anything", {});
    expect(decision.allow).toBe(false);

    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  test("two invocations for different beats get different session ids", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse("ok");
    const opts1 = baseOpts(provider);
    const opts2 = { ...baseOpts(provider), invocation: { ...opts1.invocation, beatIndex: 1 } };
    await generateSharedSpeech(opts1);
    await generateSharedSpeech(opts2);
    expect(provider.calls[0]!.sessionId).not.toBe(provider.calls[1]!.sessionId);
  });

  test("accepts complete short text output", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse("Lavender by the path.");
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome).toEqual({ kind: "spoken", text: "Lavender by the path." });
  });

  test("streaming provider: rejects on tool_use chunk, no partial speech commit", async () => {
    const provider = new FakeProvider();
    provider.respondWith = () => chunksOf([
      { type: "text", content: "I will check " },
      { type: "tool_use", tool_use: { id: "1", name: "read_file", arguments: "{}" } },
    ]);
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("rejected");
  });

  test("streaming provider: rejects on tool_call chunk", async () => {
    const provider = new FakeProvider();
    provider.respondWith = () => chunksOf([
      { type: "text", content: "partial" },
      { type: "tool_call", tool_call: { id: "1", name: "shell", arguments: "{}" } },
    ]);
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("rejected");
  });

  test("streaming provider: rejects on error chunk", async () => {
    const provider = new FakeProvider();
    provider.respondWith = () => chunksOf([
      { type: "text", content: "partial" },
      { type: "error", error: "upstream exploded" },
    ]);
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("rejected");
  });

  test("non-streaming provider with tool_calls in the response is rejected", async () => {
    const provider = new FakeProvider();
    provider.respondWith = async () => ({
      message: { role: "assistant", content: "" },
      tool_calls: [{ id: "1", name: "shell", arguments: "{}" }],
    });
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("rejected");
  });

  test("empty output is a decline, per vn-response.ts's own SC-202 convention (not a separate reject path)", async () => {
    // vn-response.ts's DECLINE_SENTINELS treats "" as a decline sentinel by
    // established, separately-tested design ("an empty text is a decline per
    // SC-202, NOT a fall-through") — this task must not reinterpret that
    // shared convention. A truly malformed/failed response is instead
    // covered by the tool_call/tool_use/error-chunk and provider-throw tests
    // above, which do produce "rejected".
    const provider = new FakeProvider();
    provider.respondWith = textResponse("");
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome).toEqual({ kind: "declined" });
  });

  test("oversized output (>2000 chars) is rejected, never truncated into a clipped commit", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse("x".repeat(2001));
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("rejected");
  });

  test("exact decline sentinel via VN json text field produces a declined outcome, not fake speech", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse('```json\n{"text": "..."}\n```');
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome).toEqual({ kind: "declined" });
  });

  test("malformed VN (no json) falls back to raw trimmed text as real speech", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse("  Just plain prose, no JSON at all.  ");
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome).toEqual({ kind: "spoken", text: "Just plain prose, no JSON at all." });
  });

  test("narration/thinking text wrapped around VN json never becomes the committed speech", async () => {
    const provider = new FakeProvider();
    provider.respondWith = textResponse(
      "Let me think about this carefully and consider the room state...\n```json\n{\"text\": \"Lavender by the path.\"}\n```",
    );
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome).toEqual({ kind: "spoken", text: "Lavender by the path." });
  });

  test("provider query throwing is a rejected outcome, not an unhandled exception", async () => {
    const provider = new FakeProvider();
    provider.respondWith = (async () => {
      throw new Error("network exploded");
    }) as unknown as () => Promise<ProviderResponse>;
    const outcome = await generateSharedSpeech(baseOpts(provider));
    expect(outcome.kind).toBe("rejected");
  });
});
