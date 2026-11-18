import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { McpClient } from "../src/mcp/client";

function writeMockServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "anima-mcp-client-"));
  const serverPath = join(dir, "mock-server.ts");
  writeFileSync(serverPath, `
const decoder = new TextDecoder();
let buffer = "";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });
      } else if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }] } });
      } else if (message.method === "tools/call") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "file contents" }] } });
      }
    }
    newline = buffer.indexOf("\\n");
  }
}
`);
  return serverPath;
}

function writeBurstFrameServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "anima-mcp-frames-"));
  const serverPath = join(dir, "burst-server.ts");
  writeFileSync(serverPath, `
const decoder = new TextDecoder();
let buffer = "";

function writeFrames(messages) {
  process.stdout.write(messages.map((message) => JSON.stringify(message)).join("\\n") + "\\n");
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        writeFrames([
          { jsonrpc: "2.0", method: "notifications/progress", params: { message: "hello" } },
          { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "burst", version: "1.0.0" } } },
        ]);
      } else if (message.method === "tools/list") {
        writeFrames([
          { jsonrpc: "2.0", id: message.id, result: { tools: [] } },
          { jsonrpc: "2.0", method: "notifications/progress", params: { message: "ignored" } },
        ]);
      }
    }
    newline = buffer.indexOf("\\n");
  }
}
`);
  return serverPath;
}

test("McpClient starts, lists tools, calls tools, and stops a stdio MCP server", async () => {
  const client = new McpClient({
    name: "mock",
    command: "bun",
    args: [writeMockServer()],
  });

  await client.start();
  try {
    expect(client.isRunning()).toBe(true);
    expect(await client.listTools()).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object" },
      },
    ]);
    expect(await client.callTool("read_file", { path: "note.txt" })).toEqual({
      content: [{ type: "text", text: "file contents" }],
    });
  } finally {
    await client.stop();
  }

  expect(client.isRunning()).toBe(false);
});

test("McpClient handles newline-delimited JSON-RPC frames from stdout", async () => {
  const client = new McpClient({
    name: "burst",
    command: "bun",
    args: [writeBurstFrameServer()],
  });

  await client.start();
  try {
    expect(await client.listTools()).toEqual([]);
  } finally {
    await client.stop();
  }
});

test("McpClient handles server startup failure gracefully", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const client = new McpClient(
    {
      name: "missing",
      command: "anima-missing-mcp-command",
      args: [],
    },
    {
      log: (level, message) => logs.push({ level, message }),
    },
  );

  expect(await client.start()).toBe(false);
  expect(client.isRunning()).toBe(false);
  expect(logs).toEqual([
    {
      level: "warn",
      message: "MCP server failed to start: missing",
    },
  ]);
});
