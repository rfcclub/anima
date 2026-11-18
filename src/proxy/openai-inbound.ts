import type { ProviderMessage, ProviderRequest, ProviderToolDefinition, ProviderToolCallRef } from "../providers/interface";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIChatBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  tools?: OpenAITool[];
  max_tokens?: number;
}

export function parseOpenAIRequest(body: OpenAIChatBody, caller = "proxy-gateway"): { req: ProviderRequest; stream: boolean } {
  const systemMsg = body.messages.find((m) => m.role === "system");
  const system = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

  const messages: ProviderMessage[] = body.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const msg: ProviderMessage = {
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
      };
      if (m.name) msg.name = m.name;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) {
        msg.tool_calls = m.tool_calls.map((tc): ProviderToolCallRef => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      return msg;
    });

  const tools: ProviderToolDefinition[] | undefined = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters,
  }));

  const req: ProviderRequest = {
    agent: caller,
    mode: "auto",
    messages,
    model: body.model,
    ...(system !== undefined ? { system } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };

  return { req, stream: body.stream === true };
}
