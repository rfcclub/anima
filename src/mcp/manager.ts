import type { McpServerConfig } from "../config/types";
import type { ProviderTool } from "../providers/interface";
import { McpClient } from "./client";

export interface McpClientLike {
  start(): Promise<boolean>;
  listTools(): Promise<ProviderTool[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

type ToolRoute = {
  client: McpClientLike;
  serverName: string;
};

export class McpManager {
  private readonly configs: McpServerConfig[];
  private readonly clientFactory: (config: McpServerConfig) => McpClientLike;
  private readonly clients: McpClientLike[] = [];
  private readonly tools: ProviderTool[] = [];
  private readonly routes = new Map<string, ToolRoute>();

  constructor(
    configs: McpServerConfig[] = [],
    options: { clientFactory?: (config: McpServerConfig) => McpClientLike } = {},
  ) {
    this.configs = configs;
    this.clientFactory = options.clientFactory ?? ((config) => new McpClient(config));
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.stop();

    let cleanup: Promise<void> | undefined;
    let cleanupError: unknown;
    let cleanupFailed = false;
    const stopOnAbort = () => {
      cleanup ??= this.stop().catch((error) => {
        cleanupFailed = true;
        cleanupError = error;
      });
    };
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      for (const config of this.configs) {
        signal?.throwIfAborted();
        const client = this.clientFactory(config);
        signal?.throwIfAborted();
        this.clients.push(client);
        const started = await client.start();
        if (!started) {
          const index = this.clients.indexOf(client);
          if (index >= 0) this.clients.splice(index, 1);
          signal?.throwIfAborted();
          continue;
        }

        signal?.throwIfAborted();
        const tools = await client.listTools();
        signal?.throwIfAborted();
        for (const tool of tools) {
          this.tools.push(tool);
          this.routes.set(tool.name, { client, serverName: config.name });
        }
      }
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) {
        await cleanup;
        await this.stop();
        if (cleanupFailed) throw cleanupError;
        signal.throwIfAborted();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
  }

  getTools(): ProviderTool[] {
    return [...this.tools];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const route = this.routes.get(name);
    if (!route) {
      throw new Error(`MCP tool not found: ${name}`);
    }
    return route.client.callTool(name, input);
  }

  async stop(): Promise<void> {
    const clients = this.clients.splice(0);
    this.tools.splice(0);
    this.routes.clear();
    await Promise.all(clients.map((client) => client.stop()));
  }
}
