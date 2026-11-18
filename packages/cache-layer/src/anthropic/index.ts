import type { AnthropicTool, CacheableMessage, CacheOptions, TextBlock } from "../types.js";

export function buildSystemPromptBlocks(
  system: string,
  cachePrefix: string | undefined
): TextBlock[] {
  if (!system) return [];
  if (!cachePrefix) return [{ type: "text", text: system }];

  const staticBlock: TextBlock = { type: "text", text: cachePrefix, cache_control: { type: "ephemeral" } };
  const dynamicText = system.slice(cachePrefix.length);
  if (!dynamicText.trim()) return [staticBlock];
  return [staticBlock, { type: "text", text: dynamicText }];
}

export function injectMessageCacheControl(
  messages: CacheableMessage[],
  opts: CacheOptions
): CacheableMessage[] {
  if (!opts.enabled || messages.length === 0) return messages;

  let lastNonToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" && m.tool_call_id == null) {
      lastNonToolIdx = i;
      break;
    }
  }
  if (lastNonToolIdx === -1) return messages;

  const target = messages[lastNonToolIdx]!;

  let blocks: TextBlock[];
  if (typeof target.content === "string") {
    blocks = [{ type: "text", text: target.content }];
  } else if (Array.isArray(target.content)) {
    blocks = (target.content as TextBlock[]).map((b) => ({ ...b }));
  } else {
    return messages;
  }

  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.type === "text") { lastTextIdx = i; break; }
  }

  if (lastTextIdx === -1) {
    blocks.push({ type: "text", text: "", cache_control: { type: "ephemeral" } });
  } else {
    if (blocks[lastTextIdx]!.cache_control != null) return messages;
    blocks[lastTextIdx] = { ...blocks[lastTextIdx]!, cache_control: { type: "ephemeral" } };
  }

  const cloned = [...messages];
  cloned[lastNonToolIdx] = { ...target, content: blocks };
  return cloned;
}

export function injectToolCacheControl(
  tools: AnthropicTool[],
  opts: CacheOptions
): AnthropicTool[] {
  if (!opts.enabled || tools.length === 0) return tools;
  return tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool
  );
}
