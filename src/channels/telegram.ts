import { AgentLoader } from "../agents/loader";
import type { Store } from "../memory/jsonl-store";
import { SqliteStore } from "../memory/sqlite-store";
import { DualStore } from "../memory/dual-store";
import type { Provider } from "../providers/interface";
import type { MemoryAdapter } from "../memory/adapter";
import type { SessionStore } from "../memory/session-store";
import type { ThreadStore } from "../memory/thread-store";
import { SessionManager } from "../session/manager";
import type { SessionLifecycle } from "../session/lifecycle";
import type { ChannelHandler, ChannelMessage, ChannelResponse } from "./types";
import { AgentSessionChannel } from "./agent-session-channel";
import { join } from "node:path";

const MENTION_RE = /^@(\S+?)\s+(.+)/s;
const MULTI_MENTION_RE = /^@([\w+]+)\s+(.+)/s;
const DEFAULT_AGENT = "bruno";

export type TelegramReplyFn = (text: string) => Promise<void>;

export interface TelegramChannelOptions {
  reply: TelegramReplyFn;
  roomsDir?: string;
  provider?: Provider;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  lifecycle?: SessionLifecycle;
  /** Session-end callback for cross-session memory persistence. */
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
  /** Runtime model override (set by session). */
  modelOverride?: string;
}

export interface TelegramChannelResult {
  text: string;
  agentNames: string[];
  isObservation: boolean;
}

export class TelegramChannel implements ChannelHandler {
  private readonly reply: TelegramReplyFn;
  private readonly loader: AgentLoader;
  private readonly store: Store;
  private readonly sessionStore?: SessionStore;
  private readonly sessionManager?: SessionManager;
  private readonly agentSessionChannel: AgentSessionChannel;
  /** Runtime model override. Set by session before handleInbound(). */
  modelOverride?: string;
  /** Runtime provider type override. Set by session before handleInbound(). */
  providerTypeOverride?: string;

  constructor(options: TelegramChannelOptions) {
    this.reply = options.reply;
    this.loader = new AgentLoader({ roomsDir: options.roomsDir });
    this.store = new DualStore(new SqliteStore(), process.env.ANIMA_HOME ?? join(process.env.HOME ?? "~", ".anima"));
    this.sessionStore = options.sessionStore;
    this.sessionManager = options.sessionStore ? new SessionManager({ store: options.sessionStore, onEnd: options.onEnd }) : undefined;
    this.agentSessionChannel = new AgentSessionChannel({
      roomsDir: options.roomsDir,
      provider: options.provider,
      memoryAdapter: options.memoryAdapter,
      sessionStore: options.sessionStore,
      threadStore: options.threadStore,
      lifecycle: options.lifecycle,
      onEnd: options.onEnd,
      modelOverride: options.modelOverride,
    });
  }

  async handleMessage(msg: ChannelMessage): Promise<ChannelResponse> {
    this.agentSessionChannel.modelOverride = this.modelOverride;
    this.agentSessionChannel.providerTypeOverride = this.providerTypeOverride;
    return this.agentSessionChannel.handleMessage(msg);
  }

  async handleInbound(
    chatId: string,
    text: string,
    knownAgents: Set<string>,
    userId?: string,
  ): Promise<TelegramChannelResult> {
    const parsed = this.parseCommand(text);
    if (parsed) {
      const cmdText = await this.handleSlashCommand(chatId, parsed, knownAgents);
      return { text: cmdText, agentNames: [], isObservation: false };
    }

    const mentioned = this.parseMention(text);
    if (mentioned.isAll || mentioned.agentNames.length > 0) {
      const agentNames = mentioned.isAll ? [...knownAgents] : mentioned.agentNames;

      // Talk to first mentioned agent, observe for rest
      const firstAgent = agentNames[0];
      const others = agentNames.slice(1);

      const msg: ChannelMessage = {
        agentName: firstAgent,
        message: mentioned.message,
        userId,
        channelId: chatId,
      };

      const result = await this.handleMessage(msg);
      return {
        text: `*${firstAgent}*:\n${result.text}`,
        agentNames,
        isObservation: false,
      };
    }

    // No mention — observation for all session participants
    return {
      text: "",
      agentNames: [],
      isObservation: true,
    };
  }

  /** Write a channel_observation event to an agent's JSONL. No response. */
  observe(agentName: string, chatId: string, message: string): void {
    const session = this.sessionManager?.openSession(agentName, chatId);
    if (session) {
      this.sessionManager?.appendTurn(session.id, "user", message);
    }
    this.store.append(agentName, {
      timestamp: new Date().toISOString(),
      type: "channel_observation",
      sessionId: `channel-${chatId}`,
      chatId,
      body: message,
    });
  }

  parseMention(text: string): {
    agentNames: string[];
    message: string;
    isAll: boolean;
  } {
    const match = text.match(MULTI_MENTION_RE);
    if (match) {
      const agentPart = match[1];
      const message = match[2];
      if (agentPart === "all") return { agentNames: [], message, isAll: true };
      return { agentNames: agentPart.split("+").filter(Boolean), message, isAll: false };
    }
    return { agentNames: [], message: text, isAll: false };
  }

  parseCommand(text: string): { command: string; args: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const space = trimmed.indexOf(" ");
    if (space === -1) return { command: trimmed.slice(1), args: "" };
    return { command: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() };
  }

  private async handleSlashCommand(
    chatId: string,
    parsed: { command: string; args: string },
    knownAgents: Set<string>,
  ): Promise<string> {
    switch (parsed.command) {
      case "end":
        return "session ended";

      case "who": {
        const names = [...knownAgents];
        return names.length > 0 ? names.join(", ") : "no agents in session";
      }

      case "leave": {
        if (!parsed.args) return "Usage: /leave @agent";
        const target = parsed.args.replace(/^@/, "");
        if (knownAgents.has(target)) {
          knownAgents.delete(target);
          return `${target} left the session`;
        }
        return `${target} not in session`;
      }

      case "status":
      case "agents": {
        const names = await this.loader.list();
        const rows: string[] = [];
        for (const name of names) {
          try {
            const agent = await this.loader.load(name);
            rows.push(`${name} (${agent.label}) — ${agent.config.provider.type}`);
          } catch {
            rows.push(`${name} — mount fail`);
          }
        }
        return rows.join("\n");
      }

      case "mode": {
        if (!parsed.args) return "Usage: /mode <chatting|programming|image|private|philosophy|creative>";
        return `Mode set to: ${parsed.args}`;
      }

      default:
        return `Unknown command: /${parsed.command}. Try /status, /who, /end, /leave, or /mode`;
    }
  }
}
