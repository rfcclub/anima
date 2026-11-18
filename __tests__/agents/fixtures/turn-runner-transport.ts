// One fresh process per case: no shared mock registry, real homes or network.
import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { LoadedAgent } from "../../../src/agents/loader";
import type { ExecuteToolOptions } from "../../../src/tools/executor";
import type { ProviderRequest, ProviderResponse } from "../../../src/providers/interface";

const [scenario, root, receipt] = process.argv.slice(2);
if (!root || !receipt) throw Error("owned root and receipt required");
mock.module("node:os", () => ({ ...os, homedir: () => root }));
require("node:os").homedir = () => root;
globalThis.fetch = (() => { throw Error("transport fixture network forbidden"); }) as unknown as typeof fetch;
const roomDir = join(root, "room"); mkdirSync(roomDir);
const failure = new Error("fixture failure");
const execution: ExecuteToolOptions[] = [];
const memoryStore = { remember: async () => { throw Error("fixture forbids writes"); }, forget: async () => {}, bootstrap: async () => [], recall: async () => [] };
const agent: LoadedAgent = {
  name: "transport-fixture", label: "Transport fixture", roomDir, soulPath: "SOUL.md",
  geneContent: "Fixture instructions.", soulContent: "Fixture identity.", sessionContextFiles: [], additionalContent: [],
  memoryAdapter: { store: async () => {}, recall: async () => [] }, memoryStore,
  config: {
    identity: { name: "transport-fixture", label: "Transport fixture" }, provider: { type: "claude", model: "fixture" },
    policy: { allowedRoots: [roomDir], readOnlyRoots: [], allowedTools: ["read", "anima_recall"], enforce: "block" },
    session: { defaultMode: "edit", autoModeOptIn: false, compactThreshold: 0 },
    boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] }, mcp: { servers: [] },
  },
};
mock.module("../../../src/tools/executor", () => ({ executeTool: async (_call: unknown, options: ExecuteToolOptions) => {
  execution.push(options);
  if (scenario === "execution-error") throw failure;
  return "output";
} }));
const requests: ProviderRequest[] = [];
const first = (): ProviderResponse => ({ message: { role: "assistant", content: "" },
  tool_calls: [{ id: "a", name: "anima_recall", arguments: '{"query":"fixture"}' }],
  ...(scenario === "initial-usage" ? { usage: { input_tokens: 1, output_tokens: 2 } } : {}),
});
const provider = { name: "fixture", query: async (request: ProviderRequest) => {
  requests.push({ ...request, messages: structuredClone(request.messages) });
  if (scenario === "initial-error" || (scenario === "query-error" && requests.length > 1)) throw failure;
  return requests.length === 1 ? first() : { message: { role: "assistant", content: "final" },
    ...(scenario === "later-usage" ? { usage: { input_tokens: 1, output_tokens: 2 } } : {}) } as ProviderResponse;
} };
mock.module("../../../src/providers/anthropic", () => ({ AnthropicProvider: class { name = "fixture"; query = provider.query; } }));
mock.module("../../../src/agents/loader", () => ({ AgentLoader: class { async load() { return agent; } }, SubstrateNotMountedError: class extends Error {} }));
const { SessionManager } = await import("../../../src/session/manager");
let compactions = 0;
SessionManager.prototype.checkCompaction = function () {
  compactions++;
  return { needed: false };
};
let stdout = "", stderr = "", caught: unknown;
const out = process.stdout.write, err = process.stderr.write;
process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof out;
process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof err;
try {
  const { main } = await import("../../../src/cli");
  await main(["talk", "--agent", agent.name, "--message", "start", "--permission", "edit"]);
} catch (error) { caught = error; }
finally { process.stdout.write = out; process.stderr.write = err; }
const { SessionStore } = await import("../../../src/memory/session-store");
const store = new SessionStore(process.env.ANIMA_SESSIONS_DB!);
const session = store.getLatestSession(agent.name, "talk");
const turns = session ? store.getTurns(session.id).map((turn) => [turn.role, turn.content]) : [];
store.close();
writeFileSync(receipt, JSON.stringify({
  queries: requests.length, providerSessions: requests.map((r) => r.sessionId === session?.id),
  execution: execution.map((e) => ({ cwd: e.cwd === roomDir, agent: e.agentName, policy: e.policy === agent.config.policy,
    memory: e.memoryStore === memoryStore, sessionId: e.sessionId ?? null, signal: e.signal ?? null, webChatClient: e.webChatClient ?? null })),
  turns, stdout, stderr, compactions, errorIdentity: caught === failure, error: caught instanceof Error ? caught.message : null,
}, null, 2));
