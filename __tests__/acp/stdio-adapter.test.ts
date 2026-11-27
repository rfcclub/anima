import { describe, expect, test } from "bun:test";
import {
  AcpStdioAdapter,
  acpEnabled,
  type AcpHost,
  type AcpTurnRequest,
} from "../../src/acp/stdio-adapter";

/** Feeds JSON-RPC lines in and records JSON-RPC lines out. */
function harness(host: AcpHost) {
  const out: Array<Record<string, unknown>> = [];
  const adapter = new AcpStdioAdapter({
    host,
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    adapter,
    out,
    send: (message: unknown) => adapter.handleLine(JSON.stringify(message)),
    request: (id: number | string, method: string, params?: unknown) => adapter.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
  };
}

function host(overrides: Partial<AcpHost> = {}): AcpHost & { prompts: AcpTurnRequest[] } {
  const prompts: AcpTurnRequest[] = [];
  return {
    prompts,
    newSession: async () => ({ sessionId: "s-1" }),
    prompt: async (request) => {
      prompts.push(request);
      request.onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      });
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    ...overrides,
  };
}

describe("ACP stdio adapter: the four methods the prototype must answer", () => {
  test("initialize advertises the protocol version and no client file-system access", async () => {
    const { request, out } = harness(host());
    await request(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    const reply = out.at(-1) as { result: { protocolVersion: number; agentCapabilities: Record<string, unknown> } };
    expect(reply.result.protocolVersion).toBe(1);
    // The client must not be told it may read or write the local file system.
    expect(reply.result.agentCapabilities.fs).toBeUndefined();
    expect(reply.result.agentCapabilities.loadSession).toBe(false);
  });

  test("session/new returns a session handle and never an absolute path", async () => {
    const { request, out } = harness(host());
    await request(2, "session/new", { cwd: "/home/user/rooms/agent-a", mcpServers: [] });
    const reply = out.at(-1) as { result: { sessionId: string } };
    expect(reply.result.sessionId).toBe("s-1");
    expect(JSON.stringify(reply)).not.toContain("/home/user");
  });

  test("session/prompt streams one agent_message_chunk and ends the turn", async () => {
    const { request, out } = harness(host());
    await request(30, "session/new", {});
    await request(3, "session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "hi" }] });
    const updates = out.filter((line) => line.method === "session/update") as Array<{ params: { update: { sessionUpdate: string } } }>;
    expect(updates.map((line) => line.params.update.sessionUpdate)).toEqual(["agent_message_chunk"]);
    expect(out.at(-1)).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
  });

  test("session/cancel aborts the in-flight prompt and the turn reports cancelled", async () => {
    let aborted = false;
    const cancelled = host({
      prompt: async (request) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        return { stopReason: request.signal.aborted ? "cancelled" : "end_turn" };
      },
    });
    const { request, out } = harness(cancelled);
    await request(40, "session/new", {});
    const pending = request(4, "session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "long" }] });
    await request(5, "session/cancel", { sessionId: "s-1" });
    await pending;
    expect(aborted).toBe(true);
    expect(out.at(-1)).toEqual({ jsonrpc: "2.0", id: 4, result: { stopReason: "cancelled" } });
  });

  test("a permission request is a session/request_permission the client answers, not an auto-allow", async () => {
    const replies: Array<{ outcome: { outcome: string } }> = [];
    const asking = host({
      prompt: async (request) => {
        const decision = await request.requestPermission({
          toolCall: { toolCallId: "t-1", title: "write file", kind: "edit" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        replies.push(decision);
        return { stopReason: "end_turn" };
      },
    });
    const { request, out, adapter } = harness(asking);
    await request(50, "session/new", {});
    const pending = request(6, "session/prompt", { sessionId: "s-1", prompt: [{ type: "text", text: "edit" }] });
    await Bun.sleep(0);
    const ask = out.find((line) => line.method === "session/request_permission") as { id: number };
    expect(ask).toBeDefined();
    adapter.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ask.id, result: { outcome: { outcome: "selected", optionId: "reject" } } }));
    await pending;
    expect(replies).toEqual([{ outcome: { outcome: "selected", optionId: "reject" } }]);
  });

  test("client file-system and terminal methods are refused, so no local path is served", async () => {
    const { request, out } = harness(host());
    await request(7, "fs/read_text_file", { sessionId: "s-1", path: "/etc/passwd" });
    const reply = out.at(-1) as { error?: { code: number; message: string } };
    expect(reply.error?.code).toBe(-32601);
    expect(JSON.stringify(reply)).not.toContain("/etc/passwd");
  });

  test("a payload that mentions an absolute path is refused at session/new", async () => {
    const { request, out } = harness(host());
    await request(8, "session/new", { cwd: "/Users/user/substrate/agent-a" });
    const reply = out.at(-1) as { error?: { code: number } };
    expect(reply.error?.code).toBe(-32602);
  });
});

describe("ACP is off unless the flag names one agent", () => {
  test("no flag means disabled", () => {
    expect(acpEnabled({})).toBe(false);
  });
  test("the flag must name an agent", () => {
    expect(acpEnabled({ ANIMA_ACP_AGENT: "agent-a" })).toBe(true);
    expect(acpEnabled({ ANIMA_ACP_AGENT: "" })).toBe(false);
    expect(acpEnabled({ ANIMA_ACP_AGENT: "../agent-a" })).toBe(false);
  });
});
