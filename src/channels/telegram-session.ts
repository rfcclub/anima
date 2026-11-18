import { AgentLoader } from "../agents/loader";
import { DualStore } from "../memory/dual-store";
import { SqliteStore } from "../memory/sqlite-store";
import type { SessionStore } from "../memory/session-store";
import { TelegramChannel } from "./telegram";
import type { MemoryAdapter } from "../memory/adapter";
import type { ThreadStore } from "../memory/thread-store";
import { SessionLifecycle } from "../session/lifecycle";
import { TrustSystem, TRUST_DOMAINS, type TrustDomain } from "../evaluation/trust-system";
import { EscalationSystem } from "../evaluation/escalation";
import { ProviderRegistry } from "../providers/registry";
import type { InlineKeyboard } from "./telegram-gateway";
import { join } from "node:path";

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

type LogFn = (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;

/** Internal orchestration port; default callers use the real TelegramChannel. */
export type TelegramSessionChannel = Pick<TelegramChannel,
  "parseMention" | "parseCommand" | "observe" | "handleInbound" | "modelOverride" | "providerTypeOverride"
>;

export interface TelegramSessionOptions {
  channel?: TelegramSessionChannel;
  roomsDir?: string;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  lifecycle?: SessionLifecycle;
  log?: LogFn;
  /** Session-end callback for cross-session memory persistence. */
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
  /** Default agent to route to when no participants are in session. */
  defaultAgent?: string;
}

export class TelegramMeetingSession {
  readonly chatId: string;
  readonly participants: Set<string> = new Set();
  private readonly channel: TelegramSessionChannel;
  private readonly loader: AgentLoader;
  private readonly defaultAgent?: string;
  private inactivityTimer?: ReturnType<typeof setTimeout>;
  private readonly threadStore?: ThreadStore;
  private readonly lifecycle: SessionLifecycle;
  private readonly onEnd?: (chatId: string) => void;
  private readonly log: LogFn;
  private showThinkTags = false;
  private modelOverride: string | null = null;
  private providerTypeOverride: string | null = null;
  private registryPromise: Promise<ProviderRegistry | null> | null = null;

  constructor(chatId: string, options: TelegramSessionOptions = {}) {
    this.chatId = chatId;
    this.loader = new AgentLoader({ roomsDir: options.roomsDir });
    this.threadStore = options.threadStore;
    this.lifecycle = options.lifecycle ?? new SessionLifecycle({
      loader: this.loader,
      store: new DualStore(new SqliteStore(), process.env.ANIMA_HOME ?? join(process.env.HOME ?? "~", ".anima")),
      memoryAdapter: options.memoryAdapter,
      trustInitializer: new TrustSystem({ roomsDir: options.roomsDir ?? join(process.cwd(), "rooms") }),
      log: options.log,
    });
    this.onEnd = undefined; // set by TelegramSessionStore
    this.log = options.log ?? (() => {});
    this.defaultAgent = options.defaultAgent;
    this.channel = options.channel ?? new TelegramChannel({
      reply: async () => {},
      roomsDir: options.roomsDir,
      memoryAdapter: options.memoryAdapter,
      sessionStore: options.sessionStore,
      threadStore: options.threadStore,
      lifecycle: this.lifecycle,
      onEnd: options.onEnd,
    });
  }

  /** Set the end callback (called by TelegramSessionStore). */
  setOnEnd(fn: (chatId: string) => void): void {
    (this as unknown as { onEnd: ((chatId: string) => void) | undefined }).onEnd = fn;
  }

  /** Process an incoming text message. Returns the reply text (if any), inline keyboard, and which agents observed. */
  async process(
    text: string,
    userId?: string,
  ): Promise<{ reply: string | null; observed: string[]; inlineKeyboard?: import("./telegram-gateway").InlineKeyboard }> {
    this.resetInactivityTimer();
    this.channel.modelOverride = this.modelOverride ?? undefined;
    this.channel.providerTypeOverride = this.providerTypeOverride ?? undefined;

    // Check for session-level commands
    const cmd = this.channel.parseCommand(text);
    if (cmd) {
      const result = await this.handleCommand(cmd);
      if (typeof result === "string") return { reply: result, observed: [] };
      return { reply: result.text, observed: [], inlineKeyboard: result.inlineKeyboard };
    }

    const mentioned = this.channel.parseMention(text);

    if (mentioned.isAll) {
      // @all — observe for all participants, no agent responds
      for (const name of this.participants) {
        this.channel.observe(name, this.chatId, text);
      }
      return { reply: `_${[...this.participants].join(", ")} noted_`, observed: [...this.participants] };
    }

    if (mentioned.agentNames.length > 0) {
      // Join new agents
      for (const name of mentioned.agentNames) {
        if (!this.participants.has(name)) {
          this.participants.add(name);
          await this.lifecycle.onOpen(name, this.chatId, mentioned.message);
          this.log("info", "agent joined session", { type: "telegram_agent_join", chatId: this.chatId, agent: name });
        }
      }

      const firstAgent = mentioned.agentNames[0];
      const others = mentioned.agentNames.slice(1);

      // Other mentioned agents observe
      for (const name of others) {
        this.channel.observe(name, this.chatId, text);
      }

      // Unmentioned participants observe
      for (const name of this.participants) {
        if (!mentioned.agentNames.includes(name)) {
          this.channel.observe(name, this.chatId, text);
        }
      }

      // First agent responds
      try {
        const result = await this.channel.handleInbound(
          this.chatId,
          text,
          this.participants,
          userId,
        );
        const observedAll = new Set([...mentioned.agentNames, ...this.participants]);
        return { reply: this.applyThinkFilter(result.text || null), observed: [...observedAll] };
      } catch (err) {
        const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        console.error(`[DEBUG] @mention agent_error agent=${firstAgent} chatId=${this.chatId}: ${errMsg}`);
        this.log("error", "agent response failed", {
          type: "telegram_agent_error",
          chatId: this.chatId,
          agent: firstAgent,
          error: errMsg,
        });
        return { reply: `*${firstAgent}*: could not respond`, observed: [] };
      }
    }

    // No @mention — first participant responds, others observe
    if (this.participants.size > 0) {
      const first = [...this.participants][0];
      const others = [...this.participants].slice(1);
      for (const name of others) {
        this.channel.observe(name, this.chatId, text);
      }
      try {
        const result = await this.channel.handleInbound(
          this.chatId,
          `@${first} ${text}`,
          this.participants,
          userId,
        );
        return { reply: this.applyThinkFilter(result.text || null), observed: [...this.participants] };
      } catch (err) {
        const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        console.error(`[DEBUG] no-mention agent_error agent=${first} chatId=${this.chatId}: ${errMsg}`);
        this.log("error", "agent response failed", {
          type: "telegram_agent_error",
          chatId: this.chatId,
          agent: first,
          error: errMsg,
        });
        // Fall back to observation mode when agent can't respond
        return { reply: null, observed: [...this.participants] };
      }
    }

    // No participants yet — auto-join default agent if configured
    if (this.defaultAgent) {
      const name = this.defaultAgent;
      this.participants.add(name);
      await this.lifecycle.onOpen(name, this.chatId, text);
      this.log("info", "agent joined session (default)", { type: "telegram_agent_join", chatId: this.chatId, agent: name });
      try {
        const result = await this.channel.handleInbound(this.chatId, `@${name} ${text}`, this.participants, userId);
        return { reply: this.applyThinkFilter(result.text || null), observed: [name] };
      } catch (err) {
        const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        console.error(`[DEBUG] default-agent error agent=${name} chatId=${this.chatId}: ${errMsg}`);
        this.log("error", "agent response failed", { type: "telegram_agent_error", chatId: this.chatId, agent: name, error: errMsg });
        return { reply: `[${name}] could not respond`, observed: [] };
      }
    }
    return { reply: null, observed: [] };
  }

  /** End the session now. */
  async end(): Promise<void> {
    this.clearTimer();
    const names = [...this.participants];
    for (const name of names) {
      this.threadStore?.clear(this.chatId, name);
      await this.lifecycle.onClose(name, this.chatId);
    }
    this.participants.clear();
    this.onEnd?.(this.chatId);
    this.log("info", "telegram session ended", { type: "telegram_session_end", chatId: this.chatId });
  }

  private async handleCommand(parsed: { command: string; args: string }): Promise<string | { text: string; inlineKeyboard?: InlineKeyboard }> {
    switch (parsed.command) {
      case "end":
        await this.end();
        return "session ended";

      case "who":
        return this.participants.size > 0
          ? [...this.participants].join(", ")
          : "no agents in session";

      case "leave": {
        const target = (parsed.args || "").replace(/^@/, "");
        if (!target) return "Usage: /leave @agent";
        if (this.participants.has(target)) {
          await this.lifecycle.onClose(target, this.chatId);
          this.threadStore?.clear(this.chatId, target);
          this.participants.delete(target);
          return `${target} left the session`;
        }
        return `${target} is not in session`;
      }

      case "status":
      case "agents": {
        try {
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
        } catch {
          return "cannot list agents";
        }
      }

      case "review": {
        try {
          const escalation = new EscalationSystem({
            roomsDir: this.loader["roomsDir"] ?? join(process.cwd(), "rooms"),
          });
          const items = await escalation.list();
          if (items.length === 0) return "No pending reviews.";
          const lines = items.map((item, i) =>
            `${i + 1}. ${item.id} [${item.domain}] ${item.summary}`,
          );
          return `*Review Queue* (${items.length} items)\n${lines.join("\n")}`;
        } catch (err) {
          return `review error: ${String(err)}`;
        }
      }

      case "approve": {
        if (!parsed.args) return "Usage: /approve <id>";
        try {
          const escalation = new EscalationSystem({
            roomsDir: this.loader["roomsDir"] ?? join(process.cwd(), "rooms"),
          });
          const result = await escalation.approve(parsed.args);
          if (!result) return `Review entry not found or expired: ${parsed.args}`;
          return `Approved ${parsed.args} — trust confirmed for ${result.domain}`;
        } catch (err) {
          return `approve error: ${String(err)}`;
        }
      }

      case "reject": {
        if (!parsed.args) return "Usage: /reject <id> <feedback>";
        const space = parsed.args.indexOf(" ");
        if (space === -1) return "Usage: /reject <id> <feedback>";
        const id = parsed.args.slice(0, space).trim();
        const feedback = parsed.args.slice(space + 1).trim();
        if (!feedback) return "Usage: /reject <id> <feedback>";
        try {
          const escalation = new EscalationSystem({
            roomsDir: this.loader["roomsDir"] ?? join(process.cwd(), "rooms"),
          });
          const result = await escalation.reject(id, feedback);
          if (!result) return `Review entry not found or expired: ${id}`;
          return `Rejected ${id} — trust penalized for ${result.domain} (feedback: ${feedback})`;
        } catch (err) {
          return `reject error: ${String(err)}`;
        }
      }

      case "colony": {
        try {
          const colonyFile = Bun.file(join(process.cwd(), "data", "colony.json"));
          if (!(await colonyFile.exists())) {
            return "colony data not found";
          }
          const colony = await colonyFile.json();
          const agents = Array.isArray(colony) ? colony : colony.agents ?? [];
          const trustSys = new TrustSystem({ roomsDir: this.loader["roomsDir"] ?? join(process.cwd(), "rooms") });

          const lines: string[] = [];
          for (const agent of agents) {
            const name = agent.name ?? "?";
            let trustLine = "";
            try {
              const trust = await trustSys.read(name);
              const top = TRUST_DOMAINS
                .map((d) => ({ domain: d, score: trust.domains[d].score }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 3);
              trustLine = top.map((t) => `${t.domain}=${t.score.toFixed(2)}`).join(" ");
            } catch {
              trustLine = "no trust data";
            }
            lines.push(`${name} [${agent.platform ?? "?"}] — ${trustLine}`);
          }
          return `*Colony* (${agents.length} agents)\n${lines.join("\n")}`;
        } catch (err) {
          return `colony error: ${String(err)}`;
        }
      }

      case "thinktag": {
        const arg = parsed.args.trim().toLowerCase();
        if (arg === "on") {
          this.showThinkTags = true;
          return "Think tags visible (on)";
        }
        if (arg === "off") {
          this.showThinkTags = false;
          return "Think tags hidden (off)";
        }
        return `Think tags currently: ${this.showThinkTags ? "on" : "off"}. Usage: /thinktag on|off`;
      }

      case "model": {
        const arg = parsed.args.trim();
        const registry = await this.getRegistry();

        // /model reset — clear all overrides
        if (arg.toLowerCase() === "reset") {
          this.modelOverride = null;
          this.providerTypeOverride = null;
          return "Model reset to config default";
        }

        // /model <name> — quick text-based model switch
        if (arg) {
          if (!registry) return "Provider registry not available.";
          let found: { providerId: string; modelId: string } | null = null;
          const slashIdx = arg.indexOf("/");
          if (slashIdx > 0) {
            const provPart = arg.slice(0, slashIdx).trim();
            const modelPart = arg.slice(slashIdx + 1).trim();
            for (const p of registry.list()) {
              if (p.id === provPart || p.label.toLowerCase() === provPart.toLowerCase()) {
                const match = p.models.find(m => m.id === modelPart || m.label === modelPart);
                if (match) { found = { providerId: p.id, modelId: match.id }; break; }
              }
            }
            if (!found) return `No model "${modelPart}" for provider "${provPart}".`;
          } else {
            for (const p of registry.list()) {
              const match = p.models.find(m => m.id === arg || m.id.toLowerCase() === arg.toLowerCase() || m.label === arg || m.label?.toLowerCase() === arg.toLowerCase());
              if (match) {
                if (found) return `"${arg}" matches multiple models. Use /model <provider>/<model>.`;
                found = { providerId: p.id, modelId: match.id };
              }
            }
            if (!found) return `Model "${arg}" not found. Use /model to browse.`;
          }
          this.modelOverride = found.modelId;
          this.providerTypeOverride = found.providerId;
          return `Model: *${found.modelId}* @ *${found.providerId}*`;
        }

        // /model — show provider picker with inline keyboard
        if (!registry) return "Provider registry not available.";
        const providers = registry.list();
        const currentModel = this.modelOverride;
        const currentProvider = this.providerTypeOverride;
        const currentLabel = currentModel ? `${currentModel} @ ${currentProvider}` : "(from config)";

        const providerButtons = providers.map(p => ({
          text: `${p.label} (${p.models.length})`,
          callback_data: `model:provider:${p.id}`,
        }));
        const keyboard: InlineKeyboard = chunkArray(providerButtons, 3);
        keyboard.push([{ text: "🔄 Reset to default", callback_data: "model:reset" }]);

        return {
          text: `*Select Model*\nCurrent: ${currentLabel}\n\nChoose a provider:`,
          inlineKeyboard: keyboard,
        };
      }

      case "mode": {
        if (!parsed.args) return "Usage: /mode <chatting|programming|image|private|philosophy|creative>";
        // Mode is set in config and used when building session — defer to next message
        return `Mode override: ${parsed.args} (applies to next agent response)`;
      }

      default:
        return `Commands: /end, /who, /leave @agent, /status, /agents, /review, /approve <id>, /reject <id> <feedback>, /colony, /mode, /model, /thinktag on|off`;
    }
  }

  /** Handle inline keyboard callback queries for this session. */
  async handleCallback(data: string, messageId: number, _callbackId: string): Promise<CallbackResult | null> {
    const registry = await this.getRegistry();
    if (!registry) return { answerText: "Registry unavailable" };

    // model:provider:<id>
    if (data.startsWith("model:provider:")) {
      const providerId = data.slice("model:provider:".length);
      const provider = registry.get(providerId);
      if (!provider) return { answerText: `Provider ${providerId} not found` };

      const currentModel = this.modelOverride;
      const modelButtons = provider.models.map(m => ({
        text: `${m.id}${currentModel === m.id && this.providerTypeOverride === providerId ? " ✅" : ""}`,
        callback_data: `model:select:${providerId}/${m.id}`,
      }));
      const keyboard: InlineKeyboard = chunkArray(modelButtons, 3);
      keyboard.push([{ text: "◀ Back", callback_data: "model:back" }]);

      return {
        editKeyboard: keyboard,
        answerText: `${provider.label} — ${provider.models.length} models`,
      };
    }

    // model:select:<providerId>/<modelId>
    if (data.startsWith("model:select:")) {
      const ref = data.slice("model:select:".length);
      const slashIdx = ref.indexOf("/");
      if (slashIdx <= 0) return { answerText: "Invalid selection" };
      const providerId = ref.slice(0, slashIdx);
      const modelId = ref.slice(slashIdx + 1);

      const provider = registry.get(providerId);
      if (!provider) return { answerText: `Provider ${providerId} not found` };
      const model = provider.models.find(m => m.id === modelId);
      if (!model) return { answerText: `Model ${modelId} not found` };

      this.modelOverride = modelId;
      this.providerTypeOverride = providerId;

      return {
        editKeyboard: null, // remove keyboard
        answerText: `Selected: ${modelId} @ ${providerId}`,
        text: `✅ Model set to *${modelId}* @ *${providerId}*`,
      };
    }

    // model:reset
    if (data === "model:reset") {
      this.modelOverride = null;
      this.providerTypeOverride = null;
      return {
        editKeyboard: null,
        answerText: "Model reset to config default",
        text: "✅ Model reset to config default",
      };
    }

    // model:back — back to provider list (3 columns)
    if (data === "model:back") {
      const providers = registry.list();
      const providerButtons = providers.map(p => ({
        text: `${p.label} (${p.models.length})`,
        callback_data: `model:provider:${p.id}`,
      }));
      const keyboard: InlineKeyboard = chunkArray(providerButtons, 3);
      keyboard.push([{ text: "🔄 Reset to default", callback_data: "model:reset" }]);
      return { editKeyboard: keyboard, answerText: "Providers" };
    }

    return null;
  }

  private async getRegistry(): Promise<ProviderRegistry | null> {
    if (this.registryPromise) return this.registryPromise;
    const dir = join(process.env.ANIMA_ROOMS_DIR ?? join(process.cwd(), "rooms"), "..", "providers.d");
    this.registryPromise = ProviderRegistry.load(dir).catch(() => null);
    return this.registryPromise;
  }

  private applyThinkFilter(text: string | null): string | null {
    if (!text) return text;
    if (this.showThinkTags) return text;
    return text.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>\s*/gi, "").trim() || null;
  }

  private resetInactivityTimer(): void {
    this.clearTimer();
    this.inactivityTimer = setTimeout(() => {
      void this.end();
    }, INACTIVITY_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
  }
}

/** Result from handling a callback query — instructions for the gateway. */
export interface CallbackResult {
  text?: string;
  editKeyboard?: import("./telegram-gateway").InlineKeyboard | null;
  answerText?: string;
}

/** Singleton storage of per-chat sessions. */
export class TelegramSessionStore {
  private sessions = new Map<string, TelegramMeetingSession>();
  private log: LogFn;

  constructor(log?: LogFn) {
    this.log = log ?? (() => {});
  }

  getOrCreate(chatId: string, options: TelegramSessionOptions = {}): TelegramMeetingSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = new TelegramMeetingSession(chatId, { ...options, log: this.log });
      session.setOnEnd((id) => {
        this.sessions.delete(id);
        this.log("info", "telegram session removed", { type: "telegram_session_remove", chatId: id });
      });
      this.sessions.set(chatId, session);
      this.log("info", "telegram session created", { type: "telegram_session_create", chatId });
    }
    return session;
  }

  get(chatId: string): TelegramMeetingSession | undefined {
    return this.sessions.get(chatId);
  }

  remove(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      void session.end();
    }
    this.sessions.delete(chatId);
  }

  async handleCallback(chatId: string, data: string, messageId: number, callbackId: string): Promise<CallbackResult | null> {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    return session.handleCallback(data, messageId, callbackId);
  }
}

/** Split array into chunks of size `n` for inline keyboard rows. */
function chunkArray<T>(arr: T[], n: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    result.push(arr.slice(i, i + n));
  }
  return result;
}
