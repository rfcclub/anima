import type { ExecuteToolOptions } from "../tools/executor";
import { currentToolBoundary } from "./tool-boundary";
import { webChatRuntime } from "./host";
const fields: Record<string, string[]> = {
  list: [],
  create: ["account"],
  resume: ["conversationId"],
  send: ["conversationId", "retryKey", "prompt"],
  result: ["requestId", "after"],
  cancel: ["requestId"],
  close: ["conversationId"],
  reconcile: ["requestId"],
};
export async function handleWebChatTool(
  args: Record<string, unknown>,
  opts: ExecuteToolOptions,
): Promise<string> {
  if (!opts.policy?.allowedTools?.includes("anima_web_chat"))
    throw Error("explicit anima_web_chat permission required");
  if (!opts.agentName || !opts.sessionId)
    throw Error("trusted runtime identity required");
  const operation = String(args.operation ?? ""),
    allowed = fields[operation];
  if (
    !allowed ||
    Object.keys(args).some((k) => k !== "operation" && !allowed.includes(k))
  )
    throw Error("invalid tool operation/fields");
  if (!currentToolBoundary())
    throw Error("web chat unavailable: OS isolation inactive");
  opts.signal?.throwIfAborted();
  const client = opts.webChatClient ?? webChatRuntime();
  if (!client) throw Error("web chat bridge unavailable");
  const result = await client.call(
    { agent: opts.agentName, session: opts.sessionId },
    { ...args, operation },
    opts.signal,
  );
  return JSON.stringify({ source: "external_chatbot_untrusted", result });
}
