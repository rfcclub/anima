import type { ProviderPermissionHandler } from "../providers/interface";

interface BlockedToolEvent {
  type: "tool_blocked";
  tool: string;
  reason: "not_in_allowedTools";
  message: string;
}

export interface AutoGuard {
  handler: ProviderPermissionHandler;
  complete(): void;
}

/** Callers supply their existing event store and completion log sinks. */
export function createAutoGuard(
  appendFn: (event: BlockedToolEvent) => void,
  allowedTools: string[] | undefined,
  onComplete: (stats: { tools: string[]; count: number }) => void,
): AutoGuard {
  const allowed = new Set(allowedTools ?? []);
  const toolCounts = new Map<string, number>();
  return {
    handler: (toolName) => {
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
      if (!allowed.has(toolName)) {
        const message = `tool '${toolName}' not in allowedTools for this agent`;
        appendFn({ type: "tool_blocked", tool: toolName, reason: "not_in_allowedTools", message });
        return { allow: false, message };
      }
      return { allow: true };
    },
    complete: () => onComplete({
      tools: [...toolCounts.keys()],
      count: [...toolCounts.values()].reduce((sum, value) => sum + value, 0),
    }),
  };
}
