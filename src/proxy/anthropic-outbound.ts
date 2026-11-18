import type { ProviderResponse } from "../providers/interface";

function msgId(): string {
  return `msg_${Math.random().toString(36).slice(2, 12)}`;
}

function sseEvent(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function toAnthropicResponse(res: ProviderResponse, model: string): object {
  const content: unknown[] = [];
  const text = typeof res.message.content === "string" ? res.message.content : "";

  if (text) {
    content.push({ type: "text", text });
  }

  if (res.tool_calls) {
    for (const tc of res.tool_calls) {
      let input: unknown;
      try { input = JSON.parse(tc.arguments); } catch { input = {}; }
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
  }

  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: res.tool_calls?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
    },
  };
}

export function toAnthropicStream(res: ProviderResponse, model: string): ReadableStream {
  const id = msgId();
  const text = typeof res.message.content === "string" ? res.message.content : "";
  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;

  const events = [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("ping", { type: "ping" }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ];

  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < events.length) {
        controller.enqueue(encoder.encode(events[i++]!));
      } else {
        controller.close();
      }
    },
  });
}
