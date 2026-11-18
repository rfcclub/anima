// Runs in a fresh child: mocks never contaminate another test's module registry.
import { mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { LoadedAgent } from "../../../src/agents/loader";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse, ProviderToolCall } from "../../../src/providers/interface";

const [surface, scenario, root, receipt] = process.argv.slice(2);
if (!root || !receipt) throw Error("fixture needs an owned directory and receipt path");
mock.module("node:os", () => ({ ...os, homedir: () => root }));
require("node:os").homedir = () => root;
globalThis.fetch = (() => { throw Error("network forbidden in loop characterization"); }) as unknown as typeof fetch;
const roomDir = join(root, "room");
mkdirSync(roomDir, { recursive: true });
writeFileSync(join(roomDir, "one.txt"), "one");
writeFileSync(join(roomDir, "two.txt"), "two");
const sentinel = join(roomDir, "sentinel.txt");
const agent: LoadedAgent = {
  name: "loop-fixture", label: "Loop fixture", roomDir, soulPath: "SOUL.md",
  geneContent: "Fixture instructions.", soulContent: "Fixture agent.",
  sessionContextFiles: [], additionalContent: [],
  memoryAdapter: { store: async () => {}, recall: async () => [] },
  config: {
    identity: { name: "loop-fixture", label: "Loop fixture" },
    provider: { type: "claude", model: "fixture" },
    policy: { allowedRoots: [roomDir], readOnlyRoots: [], allowedTools: scenario === "limit" ? ["read", "write"] : ["read"], enforce: "block" },
    session: { defaultMode: "edit", autoModeOptIn: true, compactThreshold: 0 },
    boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
    mcp: { servers: [] },
  },
};
const call = (id: string, path: string): ProviderToolCall => ({
  id, name: "read", arguments: JSON.stringify({ path }),
});
let queries = 0;
let lastMessages: ProviderRequest["messages"] = [];
const counts: number[] = [];
function answer(req: ProviderRequest): ProviderResponse {
  queries++;
  lastMessages = structuredClone(req.messages);
  counts.push(req.messages.length);
  const text = (content: string): ProviderResponse => ({ message: { role: "assistant", content } });
  if (scenario === "no-tools") return text("finished");
  if (scenario === "limit") {
    return { ...text("still working"), tool_calls: [{
      id: `c${queries}`, name: "write",
      arguments: JSON.stringify({ path: "iteration.txt", content: String(queries) }),
    }] };
  }
  if (queries > 1) return text("finished");
  let calls: ProviderToolCall[];
  if (scenario === "multi") calls = [call("c1", "one.txt"), call("c2", "two.txt")];
  else if (scenario === "error") calls = [
    { id: "c1", name: "read", arguments: "{" },
    call("c2", "missing.txt"), call("c3", "two.txt"),
  ];
  else if (scenario === "guard") calls = [{
    id: "c1", name: "write", arguments: JSON.stringify({ path: sentinel, content: "must not be written" }),
  }];
  else throw Error(`unknown scenario ${scenario}`);
  return { ...text("working"), tool_calls: calls };
}
const provider: Provider = {
  name: "fixture",
  query: surface === "stream-native"
    ? ((req: ProviderRequest) => (async function* (): AsyncGenerator<ProviderChunk> {
      const response = answer(req);
      yield { type: "text", content: String(response.message.content) };
      for (const tool_call of response.tool_calls ?? []) yield { type: "tool_call", tool_call };
    })()) as Provider["query"]
    : async (req: ProviderRequest) => answer(req),
};

// CLI still runs its real provider selection, loop, persistence and executor.
mock.module("../../../src/providers/anthropic", () => ({
  AnthropicProvider: class { name = "fixture"; query = provider.query; },
}));
mock.module("../../../src/agents/loader", () => ({
  AgentLoader: class { async load() { return agent; } },
  SubstrateNotMountedError: class extends Error {},
}));
const { AgentSession } = await import("../../../src/agents/session");
const { JsonlStore } = await import("../../../src/memory/jsonl-store");
const mode = scenario === "guard" ? "auto" : "edit";
const chunks: ProviderChunk[] = [];
let result: unknown = null;
let error: string | null = null;
let stdout = "";
let stderr = "";
const originalWrite = process.stdout.write.bind(process.stdout);
const originalErrorWrite = process.stderr.write.bind(process.stderr);
const originalConsoleError = console.error;
process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
console.error = (...args: unknown[]) => { stderr += args.map(String).join(" ") + "\n"; };
try {
  if (surface === "cli") {
    const { main } = await import("../../../src/cli");
    await main(["talk", "--agent", agent.name, "--message", "exercise tools", "--permission", mode]);
  } else {
    const session = new AgentSession({
      store: new JsonlStore(join(root, "events")),
      provider,
      log: () => {},
    });
    const options = { agent, message: "exercise tools", mode, sessionId: "fixture-session", continuityDbPath: join(root, "continuity.db") } as const;
    if (surface === "run") result = (await session.run(options)).response;
    else for await (const chunk of session.runStream(options)) chunks.push(chunk);
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
} finally {
  process.stdout.write = originalWrite;
  process.stderr.write = originalErrorWrite;
  console.error = originalConsoleError;
}
// Only nondeterministic transport metadata is normalized; message/event ordering is retained.
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value)
  .split(root).join("<root>")
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>")
  .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, "<session>"));
writeFileSync(receipt, JSON.stringify(normalize({
  surface, scenario, queries, messageCounts: counts,
  // At the cap, retain the final request tail; messageCounts pins every earlier request length.
  lastMessages: scenario === "limit" ? lastMessages.slice(-4) : lastMessages,
  chunks, result, error, stdout, stderr,
  sentinelExists: existsSync(sentinel),
  lastExecutedIteration: existsSync(join(roomDir, "iteration.txt")) ? readFileSync(join(roomDir, "iteration.txt"), "utf8") : null,
  files: [readFileSync(join(roomDir, "one.txt"), "utf8"), readFileSync(join(roomDir, "two.txt"), "utf8")],
}), null, 2));
