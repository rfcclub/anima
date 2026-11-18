/**
 * rfcclub/anima#103 slice 2: the hosted agents' A2A inboxes. Items come in through colony-mesh's
 * `MeshInboxChannel` (structured `deliver`), and answers go back on the same conversation.
 */
import { join } from "node:path";
import { MeshInboxChannel, type InboxItem } from "colony-mesh/a2a/inbox-channel";
import type { A2AInboxRequest } from "../continuity/mesh-ingress";
import type { MeshConversationPort } from "../continuity/mesh-session-handlers";

/** Only the Mesh service writes this first line, so only its items name a sender inside the content. */
const MESH_SERVICE = "mesh-service@local";
const MESH_FROM = /^\[mesh from ([^\]\s]+)\]\n/;
const RPC_TIMEOUT_MS = 10_000;
/** Reads before a report that keeps failing for an unclear reason is given up (the attempt then fails). */
const FINISH_ROUNDS = 3;

/** AJ-11: the sender is Mesh's first line only for a Mesh-service item; any other claim is content. */
export function parseInboxItem(item: InboxItem): A2AInboxRequest {
  const header = item.sender === MESH_SERVICE ? MESH_FROM.exec(item.content) : null;
  return {
    conversationId: item.conversationId,
    sender: header ? header[1]! : item.sender,
    body: header ? item.content.slice(header[0].length) : item.content,
    ...(item.replyTo ? { replyTo: item.replyTo } : {}),
  };
}

export interface A2AConversationOptions {
  /** Gateway JSON-RPC endpoint, e.g. http://127.0.0.1:1526/a2a. */
  url: string;
  /** The agent's current registration credential; null while it is not online. Read on every call. */
  capability: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The agent's side of its conversations. Every RPC is bounded. `finish` reads the committed events and
 * reports only what is missing, so Mesh never sees `visible -> visible`; after an unclear result it reads
 * again and decides from what Mesh committed. A `replied` that Mesh committed but whose answer was lost
 * is therefore read back as "already", never sent twice.
 */
export function a2aConversation(options: A2AConversationOptions): MeshConversationPort {
  const fetchImpl = options.fetch ?? fetch;
  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const capability = options.capability();
    if (!capability) throw new Error("mesh presence is not online");
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? RPC_TIMEOUT_MS),
    });
    const body = await response.json() as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message.split(capability).join("[redacted]"));
    return body.result;
  };
  const events = async (conversationId: string): Promise<Set<string>> => {
    const state = await rpc("tasks/get", { conversationId }) as { events?: Array<{ type: string }> };
    return new Set(state.events?.map((event) => event.type));
  };

  return {
    async answered(conversationId) {
      return (await events(conversationId)).has("replied");
    },

    async finish(conversationId, content, fence) {
      let lastError: unknown;
      for (let round = 0; round < FINISH_ROUNDS; round++) {
        if (fence.aborted) return "fenced";
        const seen = await events(conversationId);
        if (seen.has("replied")) return "already";
        try {
          if (!seen.has("visible")) {
            if (fence.aborted) return "fenced";
            await rpc("tasks/report", { conversationId, type: "visible" });
          }
          if (fence.aborted) return "fenced";
          await rpc("tasks/report", { conversationId, type: "replied", content });
          return "replied";
        } catch (error) {
          lastError = error; // unclear: read the committed state again before deciding
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

interface InboxChannel { start(): void; stop(): void }
type ChannelConfig = { address: string; capability: string; url: string; cursorFile: string; fetchImpl?: typeof fetch; retryMs?: number; deliver: (item: InboxItem) => Promise<void> };

export interface AgentInboxesOptions {
  agents: readonly string[];
  /** The agent's inbox address and current credential, or null while it is not online. */
  inbox(agent: string): { address: string; capability: string } | null;
  /** The presence's run directory; cursors live in `<runDir>/cursors/<mesh ID>.cursor`. */
  runDir: string;
  /** Gateway JSON-RPC endpoint, e.g. http://127.0.0.1:1526/a2a. */
  url: string;
  /** Stores the request; a throw keeps the inbox cursor, so the item is offered again. */
  deliver(agent: string, request: A2AInboxRequest): void | Promise<void>;
  /** How often to look for a new or rotated credential. */
  pollMs?: number;
  fetch?: typeof fetch;
  /** Bound for each inbox JSON-RPC call (`tasks/get`, `tasks/report`); the SSE stream itself is not bounded. */
  rpcTimeoutMs?: number;
  /** Delay before the channel reconnects after a failed read. */
  retryMs?: number;
  channel?: (config: ChannelConfig) => InboxChannel;
}

/** The channel's fetch with every JSON-RPC POST bounded; the long-lived inbox stream (GET) is left alone. */
function boundedRpc(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return fetchImpl(input, init);
    const bound = AbortSignal.timeout(timeoutMs);
    return fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, bound]) : bound });
  }) as typeof fetch;
}

/**
 * One `MeshInboxChannel` per online agent. A rejoin rotates the registration credential, so the channel
 * is reopened with the new one; the cursor file is keyed by mesh ID and carries over.
 */
export class AgentInboxes {
  private readonly open = new Map<string, { capability: string; channel: InboxChannel }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly makeChannel: (config: ChannelConfig) => InboxChannel;

  constructor(private readonly options: AgentInboxesOptions) {
    this.makeChannel = options.channel ?? ((config) => new MeshInboxChannel({ ...config, notify: () => {} }));
  }

  start(): void {
    if (this.timer) return;
    this.sync();
    this.timer = setInterval(() => this.sync(), this.options.pollMs ?? 1_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { channel } of this.open.values()) channel.stop();
    this.open.clear();
  }

  private sync(): void {
    for (const agent of this.options.agents) {
      const current = this.options.inbox(agent);
      const opened = this.open.get(agent);
      if (opened && opened.capability === current?.capability) continue;
      opened?.channel.stop();
      this.open.delete(agent);
      if (!current) continue;
      const channel = this.makeChannel({
        address: current.address,
        capability: current.capability,
        url: this.options.url,
        cursorFile: join(this.options.runDir, "cursors", `${current.address}.cursor`),
        fetchImpl: boundedRpc(this.options.fetch ?? fetch, this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS),
        retryMs: this.options.retryMs,
        deliver: async (item) => { await this.options.deliver(agent, parseInboxItem(item)); },
      });
      this.open.set(agent, { capability: current.capability, channel });
      channel.start();
    }
  }
}
