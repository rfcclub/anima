import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AgentSession } from "../src/agents/session";
import { JsonlStore } from "../src/memory/jsonl-store";
import type { LoadedAgent } from "../src/agents/loader";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

function writeFilesystemServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "anima-mcp-fs-server-"));
  const serverPath = join(dir, "filesystem-server.ts");
  writeFileSync(serverPath, `
const decoder = new TextDecoder();
let buffer = "";
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "filesystem", version: "1.0.0" } } });
      } else if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] } });
      } else if (message.method === "tools/call") {
        const text = await Bun.file(message.params.arguments.path).text();
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
      }
    }
    newline = buffer.indexOf("\\n");
  }
}
`);
  return serverPath;
}

test("agent with filesystem MCP server reads a file during session", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "anima-mcp-session-"));
  const targetFile = join(tempDir, "note.txt");
  writeFileSync(targetFile, "hello from mcp");
  mkdirSync(join(tempDir, "store"), { recursive: true });

  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "claude",
    query: async (req) => {
      requests.push(req);
      if (requests.length === 1) {
        return {
          message: { role: "assistant", content: "Reading" },
          tool_calls: [{ id: "toolu_fs", name: "read_file", arguments: JSON.stringify({ path: targetFile }) }],
        };
      }
      expect(req.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "toolu_fs", content: "hello from mcp" });
      return { message: { role: "assistant", content: "File says: hello from mcp" } };
    },
  };

  const agent: LoadedAgent = {
    name: "cleo",
    label: "Cleo",
    roomDir: tempDir,
    soulPath: "SOUL.md",
    geneContent: "Core.",
    soulContent: "Soul.",
    sessionContextFiles: [],
    additionalContent: [],
    memoryAdapter: undefined as any,
    config: {
      identity: { name: "cleo", label: "Cleo" },
      provider: { type: "claude" },
      policy: { allowedRoots: [tempDir], readOnlyRoots: [], allowedTools: [] },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 60000 },
      boot: { gene: "SOUL.md", sessionContext: [] },
      mcp: { servers: [{ name: "filesystem", command: "bun", args: [writeFilesystemServer()] }] },
    },
  };

  const session = new AgentSession({
    store: new JsonlStore(join(tempDir, "store")),
    provider,
    log: () => {},
  });

  const result = await session.run({ agent, message: "read note", sessionId: "mcp-session" });

  expect(result.response.message.content).toBe("File says: hello from mcp");
  expect(requests[0].tools).toContainEqual(expect.objectContaining({ name: "read_file" }));
});
