import type { ProviderResponse } from "../providers/interface";

function chatId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

export function toOpenAIChatResponse(res: ProviderResponse, model: string): object {
  const text = typeof res.message.content === "string" ? res.message.content : "";

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text,
  };

  if (res.tool_calls?.length) {
    message.tool_calls = res.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return {
    id: chatId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: res.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: res.usage?.input_tokens ?? 0,
      completion_tokens: res.usage?.output_tokens ?? 0,
      total_tokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
    },
  };
}

export function toOpenAIChatStream(res: ProviderResponse, model: string): ReadableStream {
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  const text = typeof res.message.content === "string" ? res.message.content : "";

  const events = [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    `data: [DONE]\n\n`,
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
