/**
 * types.ts — Types for the bruno-specific OpenClaw adapter.
 */

export type MemoryScope =
  | "fact" | "preference" | "observation" | "episode"
  | "decision" | "project" | "identity" | "insight" | "dream";

export interface OpenClawPluginApi {
  id: string;
  pluginConfig?: unknown;
  registerHook: (events: string | string[], handler: (event: any, ctx: any) => any) => void;
  registerContextEngine: (id: string, factory: (ctx: any) => any) => void;
  registerTool: (tool: any, opts?: { name?: string }) => void;
  runtime: {
    config: { loadConfig: () => Record<string, unknown>; current?: () => Record<string, unknown> };
    llm?: { complete: (params: any) => Promise<{ content: string }> };
  };
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}
