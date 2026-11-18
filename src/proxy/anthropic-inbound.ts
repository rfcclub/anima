import type { ProviderMessage, ProviderRequest, ProviderTool } from "../providers/interface";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicSystemBlock {
  type: string;
  text: string;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  stream?: boolean;
  tools?: AnthropicTool[];
  max_tokens?: number;
}

function extractSystem(system: AnthropicMessagesBody["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

export function parseAnthropicRequest(body: AnthropicMessagesBody, caller = "proxy-gateway"): { req: ProviderRequest; stream: boolean } {
  const system = extractSystem(body.system);

  const messages: ProviderMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : (m.content as Array<{ type: string; [key: string]: unknown }>),
  }));

  const tools: ProviderTool[] | undefined = body.tools?.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.input_schema,
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
