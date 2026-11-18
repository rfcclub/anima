import { expect, test } from "bun:test";
import { McpManager } from "../src/mcp/manager";
import type { McpServerConfig } from "../src/config/types";
import type { ProviderTool } from "../src/providers/interface";

class FakeClient {
  constructor(
    readonly config: McpServerConfig,
    private readonly tools: ProviderTool[],
    private readonly started = true,
  ) {}

  async start(): Promise<boolean> {
    return this.started;
  }

  async listTools(): Promise<ProviderTool[]> {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return { server: this.config.name, name, input };
  }

  async stop(): Promise<void> {}
}

test("McpManager starts clients, merges tools, routes tool calls, and skips failed servers", async () => {
  const configs = [
    { name: "files", command: "files", args: [] },
    { name: "browser", command: "browser", args: [] },
    { name: "missing", command: "missing", args: [] },
  ];
  const manager = new McpManager(configs, {
    clientFactory: (config) =>
      new FakeClient(
        config,
        config.name === "files"
          ? [{ name: "read_file", description: "Read", input_schema: { type: "object" } }]
          : [{ name: "click", description: "Click", input_schema: { type: "object" } }],
        config.name !== "missing",
      ),
  });

  await manager.start();

  expect(manager.getTools().map((tool) => tool.name)).toEqual(["read_file", "click"]);
  expect(await manager.callTool("click", { selector: "button" })).toEqual({
    server: "browser",
    name: "click",
    input: { selector: "button" },
  });
  await expect(manager.callTool("unknown", {})).rejects.toThrow("MCP tool not found: unknown");

  await manager.stop();
  expect(manager.getTools()).toEqual([]);
});
