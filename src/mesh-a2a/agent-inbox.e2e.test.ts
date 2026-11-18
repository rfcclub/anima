import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivationBroker } from "../continuity/activation-broker";
import { ActivationBudget } from "../continuity/activation-budget";
import { ActivationExecutor } from "../continuity/activation-executor";
import { ActivationStore } from "../continuity/activation-store";
import { MeshActivationRuntime } from "../continuity/mesh-activation-runtime";
import { createMeshSessionHandlers } from "../continuity/mesh-session-handlers";
import { a2aConversation, AgentInboxes } from "./agent-inbox";
import { AnimaMeshPresence, presenceRunDir } from "./agent-presence";

/** rfcclub/anima#103 slice 2 against the real colony-meshd gateway and identity-runtime (child process). */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function meshStack(agents: string[]): Promise<{ meshUrl: string; identityUrl: string }> {
  const root = tempDir("ms-");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "mesh-stack-host.ts")], {
    env: { ...process.env, MESH_STACK_ROOT: root, MESH_STACK_AGENTS: agents.join(",") }, stdout: "pipe", stderr: "inherit",
  });
  cleanups.push(async () => { child.kill(); await child.exited; });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const part = await reader.read();
    if (part.done) throw new Error("mesh stack host exited before it was ready");
    text += new TextDecoder().decode(part.value);
  }
  reader.releaseLock();
  return JSON.parse(text.split("\n")[0]!);
}

async function started(stack: { meshUrl: string; identityUrl: string }, agents: string[]) {
  const home = tempDir("ah-");
  const presence = new AnimaMeshPresence({ agents, animaHome: home, identityUrl: stack.identityUrl, meshUrl: stack.meshUrl, heartbeatIntervalMs: 500, log: () => {} });
  cleanups.push(() => presence.stop());
  await presence.start();
  return { presence, home };
}

/** Reads inbox items for a capability until `stop` says enough. */
async function readInbox(meshUrl: string, capability: string, enough: (items: any[]) => boolean, timeoutMs = 10_000): Promise<any[]> {
  const items: any[] = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(`${meshUrl}/a2a/inbox/events?after=0`, { headers: { authorization: `Bearer ${capability}` }, signal: abort.signal });
    const reader = response.body!.getReader();
    let buffer = "";
    while (!enough(items)) {
      const part = await reader.read();
      if (part.done) break;
      buffer += new TextDecoder().decode(part.value);
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) items.push(JSON.parse(data.slice(6)));
      }
    }
    await reader.cancel().catch(() => {});
  } catch { /* timed out */ } finally {
    clearTimeout(timer);
  }
  return items;
}

/** The gate-mode path the server wires: inbox → durable ingress → broker → session → A2A reply. */
function hostedFinn(options: {
  meshUrl: string; presence: AnimaMeshPresence; home: string;
  runTurn: () => Promise<string>; conversationFetch?: typeof fetch; attemptTimeoutMs?: number;
}) {
  const dir = tempDir("st-");
  const store = new ActivationStore(join(dir, "memory.db"));
  cleanups.push(() => store.close());
  const broker = new ActivationBroker({
    armTimer: () => {}, store,
    budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
    executor: new ActivationExecutor(store),
  });
  let turns = 0;
  const conversation = a2aConversation({
    url: `${options.meshUrl}/a2a`, capability: () => options.presence.inbox("finn")?.capability ?? null, fetch: options.conversationFetch,
  });
  const runtime = new MeshActivationRuntime({
    store, broker, now: () => Date.now(), attemptTimeoutMs: options.attemptTimeoutMs,
    ...createMeshSessionHandlers({
      runTurn: async () => { turns += 1; return options.runTurn(); },
      conversation: () => conversation,
      markReplied: (agentId, sourceRef) => store.markMeshReplied(agentId, sourceRef, Date.now()),
    }),
  });
  const dispatches: Array<Promise<unknown>> = [];
  const inboxes = new AgentInboxes({
    agents: ["finn"], inbox: (agent) => options.presence.inbox(agent), runDir: presenceRunDir(options.home), url: `${options.meshUrl}/a2a`, pollMs: 50,
    deliver: (agent, request) => {
      const outcome = runtime.ingestA2A(agent, request);
      if (outcome.disposition === "retry") throw new Error("ingress could not store the request");
      if (outcome.route === "candidate") dispatches.push(runtime.dispatch(agent, `a2a:${request.conversationId}`));
    },
  });
  inboxes.start();
  cleanups.push(() => inboxes.stop());
  return { store, dispatches, turns: () => turns };
}

async function conversationEvents(meshUrl: string, capability: string, conversationId: string): Promise<string[]> {
  const response = await fetch(`${meshUrl}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { conversationId } }),
  });
  const body = await response.json() as { result: { events: Array<{ type: string }> } };
  return body.result.events.map((event) => event.type);
}

describe("an ANIMA agent's A2A inbox and reply against a real gateway", () => {
  test("AJ-7 a request sent to finn's mesh ID is answered into the sender's own inbox", async () => {
    const stack = await meshStack(["finn", "bruno"]);
    const finn = await started(stack, ["finn"]);
    const sender = await started(stack, ["bruno"]);
    const hosted = hostedFinn({ meshUrl: stack.meshUrl, presence: finn.presence, home: finn.home, runTurn: async () => "pong KINGFISHER" });
    const sent = await sender.presence.send("bruno", { target: finn.presence.meshId("finn")!, content: "ping" });
    const conversationId = (sent.body as any).results[finn.presence.meshId("finn")!].conversationId as string;
    const replies = await readInbox(stack.meshUrl, sender.presence.inbox("bruno")!.capability, (items) => items.some((item) => item.replyTo));
    await Promise.all(hosted.dispatches);
    const reply = replies.find((item) => item.replyTo);
    expect(reply?.replyTo).toBe(conversationId);
    expect(reply?.content).toBe(`[mesh reply from ${finn.presence.meshId("finn")} re conversation_id=${conversationId}]\npong KINGFISHER`);
    expect(hosted.turns()).toBe(1);
  }, 30_000);

  test("AJ-9 visible committed, then replied fails once: one replied, no visible -> visible, one turn", async () => {
    const stack = await meshStack(["finn", "bruno"]);
    const finn = await started(stack, ["finn"]);
    const sender = await started(stack, ["bruno"]);
    let failedOnce = false;
    const flaky = (async (input: string | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (!failedOnce && body?.method === "tasks/report" && body.params.type === "replied") { failedOnce = true; throw new Error("socket hang up"); }
      return fetch(input, init);
    }) as typeof fetch;
    const hosted = hostedFinn({ meshUrl: stack.meshUrl, presence: finn.presence, home: finn.home, runTurn: async () => "pong", conversationFetch: flaky });
    const sent = await sender.presence.send("bruno", { target: finn.presence.meshId("finn")!, content: "ping" });
    const conversationId = (sent.body as any).results[finn.presence.meshId("finn")!].conversationId as string;
    await readInbox(stack.meshUrl, sender.presence.inbox("bruno")!.capability, (items) => items.some((item) => item.replyTo));
    await Promise.all(hosted.dispatches);
    const events = await conversationEvents(stack.meshUrl, finn.presence.inbox("finn")!.capability, conversationId);
    expect(failedOnce).toBe(true);
    expect(events.filter((type) => type === "visible")).toHaveLength(1);
    expect(events.filter((type) => type === "replied")).toHaveLength(1);
    expect(hosted.turns()).toBe(1);
  }, 30_000);

  test("AJ-9 a visible report delayed past the attempt deadline: exactly one replied, the failure notice", async () => {
    const stack = await meshStack(["finn", "bruno"]);
    const finn = await started(stack, ["finn"]);
    const sender = await started(stack, ["bruno"]);
    const slow = (async (input: string | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "tasks/report" && body.params.type === "visible") await Bun.sleep(600);
      return fetch(input, init);
    }) as typeof fetch;
    const hosted = hostedFinn({ meshUrl: stack.meshUrl, presence: finn.presence, home: finn.home, runTurn: async () => "late answer", conversationFetch: slow, attemptTimeoutMs: 300 });
    const sent = await sender.presence.send("bruno", { target: finn.presence.meshId("finn")!, content: "ping" });
    const conversationId = (sent.body as any).results[finn.presence.meshId("finn")!].conversationId as string;
    const replies = await readInbox(stack.meshUrl, sender.presence.inbox("bruno")!.capability, (items) => items.some((item) => item.replyTo));
    await Promise.all(hosted.dispatches);
    await Bun.sleep(800);
    const events = await conversationEvents(stack.meshUrl, finn.presence.inbox("finn")!.capability, conversationId);
    expect(events.filter((type) => type === "visible")).toHaveLength(1);
    expect(events.filter((type) => type === "replied")).toHaveLength(1);
    expect(replies.filter((item) => item.replyTo)).toHaveLength(1);
    expect(replies.find((item) => item.replyTo)!.content).toContain("timed out");
  }, 30_000);
});
