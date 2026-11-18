import { resolve, isAbsolute } from "node:path";
import type { ProviderToolCall, ProviderToolDefinition } from "../providers/interface";
import { executeTool } from "./executor";
import { isPathInside } from "./policy-enforcer";
import { buildToolDefinitions } from "./definitions";

export type ScopeTarget = "machine" | "world";

const MACHINE_ALLOW = ["read", "grep", "glob"];
const WORLD_ALLOW = ["web_search", "web_fetch"];

export interface ScopedExecutorOptions {
  target: ScopeTarget;
  projectRoot: string;
  agentName?: string;
}

/** Read-only, allowlisted tool executor for expedition sessions (castle-social-expeditions). */
export class ScopedExecutor {
  constructor(private readonly opts: ScopedExecutorOptions) {}

  private allowlist(): string[] {
    return this.opts.target === "machine" ? MACHINE_ALLOW : WORLD_ALLOW;
  }

  canCall(tool: string): boolean {
    return this.allowlist().includes(tool);
  }

  /** Only meaningful for the `machine` scope — resolves the path against the project root. */
  pathInScope(path: string): boolean {
    const root = resolve(this.opts.projectRoot);
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    return isPathInside(root, target);
  }

  toolDefinitions(): ProviderToolDefinition[] {
    return buildToolDefinitions(this.allowlist());
  }

  async call(toolCall: ProviderToolCall): Promise<string> {
    if (!this.canCall(toolCall.name)) {
      return `Error: tool ${toolCall.name} not allowed in ${this.opts.target} scope`;
    }
    if (this.opts.target === "machine") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        return `Error: could not parse tool arguments: ${toolCall.arguments}`;
      }
      if (typeof args.path === "string" && !this.pathInScope(args.path)) {
        return `Error: path ${args.path} outside machine scope (${this.opts.projectRoot})`;
      }
    }
    return executeTool(toolCall, { cwd: this.opts.projectRoot, agentName: this.opts.agentName, policy: null });
  }
}
