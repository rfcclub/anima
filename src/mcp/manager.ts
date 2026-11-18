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

  async start(): Promise<void> {
    await this.stop();

    for (const config of this.configs) {
      const client = this.clientFactory(config);
      const started = await client.start();
      if (!started) continue;

      this.clients.push(client);
      const tools = await client.listTools();
      for (const tool of tools) {
        this.tools.push(tool);
        this.routes.set(tool.name, { client, serverName: config.name });
      }
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
