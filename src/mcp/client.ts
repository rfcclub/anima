import type { McpServerConfig } from "../config/types";
import type { ProviderTool } from "../providers/interface";

type JsonRpcId = number;
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: Timer;
};

type McpClientLog = (level: "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class McpClient {
  private readonly serverConfig: McpServerConfig;
  private readonly log: McpClientLog;
  private process?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private readTask?: Promise<void>;

  constructor(serverConfig: McpServerConfig, options: { log?: McpClientLog } = {}) {
    this.serverConfig = serverConfig;
    this.log = options.log ?? defaultLog;
  }

  async start(): Promise<boolean> {
    if (this.process) return true;

    try {
      this.process = Bun.spawn([this.serverConfig.command, ...this.serverConfig.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(this.serverConfig.env ?? {}) },
      });

      this.readTask = this.readResponses(this.process.stdout);
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "anima", version: "0.1.0" },
      });
      this.notify("notifications/initialized", {});
      return true;
    } catch (error) {
      this.log("warn", `MCP server failed to start: ${this.serverConfig.name}`, {
        server: this.serverConfig.name,
        error: String(error),
      });
      await this.stop();
      return false;
    }
  }

  isRunning(): boolean {
    return this.process !== undefined && this.process.exitCode === null;
  }

  async listTools(): Promise<ProviderTool[]> {
    const result = await this.request("tools/list", {});
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools.map((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        throw new Error(`invalid MCP tool from ${this.serverConfig.name}`);
      }
      return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        input_schema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
      };
    });
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: input }, DEFAULT_TOOL_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    const proc = this.process;
    this.process = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MCP server stopped before response: ${id}`));
    }
    this.pending.clear();

    if (!proc) return;
    proc.kill();
    await proc.exited.catch(() => {});
    await this.readTask?.catch(() => {});
    this.readTask = undefined;
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.writeMessage(message);
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const stdin = this.process?.stdin;
    if (!stdin) {
      throw new Error(`MCP server is not running: ${this.serverConfig.name}`);
    }
    stdin.write(JSON.stringify(message) + "\n");
  }

  private async readResponses(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stdout.getReader();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            this.handleLine(line);
          }
          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleLine(line: string): void {
    const message = JSON.parse(line) as JsonRpcResponse;
    if (typeof message.id !== "number") return;

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultLog(level: "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  console[level === "error" ? "error" : "warn"](JSON.stringify({ level, message, ...fields }));
}
