import type { MemoryAdapter } from "../memory/adapter";
import type { SessionStore } from "../memory/session-store";
import type { ThreadStore } from "../memory/thread-store";
import { TelegramSessionStore, type TelegramSessionOptions } from "./telegram-session";

const TELEGRAM_API = "https://api.telegram.org";

type LogFn = (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface TelegramGatewayOptions {
  botToken: string;
  webhookSecret: string;
  webhookUrl?: string;
  /** Use long-polling (getUpdates) instead of webhooks. Default: false. */
  polling?: boolean;
  roomsDir?: string;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  log?: LogFn;
  /** Session-end callback for cross-session memory persistence. */
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
  /** Pin this gateway to a specific agent. Overrides ANIMA_DEFAULT_AGENT env. */
  defaultAgent?: string;
  /** If non-empty, only process messages from these chat IDs. */
  allowedChatIds?: string[];
}

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

type CallbackHandler = (chatId: string, data: string, messageId: number, callbackId: string) => Promise<string | null>;

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: { message_id: number; chat: { id: number; type: string }; text?: string };
    data?: string;
  };
}

export class TelegramGateway {
  private readonly botToken: string;
  private readonly webhookSecret: string;
  private readonly webhookUrl?: string;
  private readonly polling: boolean;
  private readonly sessionStore: TelegramSessionStore;
  private readonly sessionOptions: TelegramSessionOptions;
  private readonly log: LogFn;
  private readonly allowedChatIds: Set<string>;
  private readonly processedUpdateIds = new Set<number>();
  /** Per-chat message queue + active processor so users can send continuous messages while an agent thinks. */
  private readonly chatQueues = new Map<string, Array<{ text: string; userId: string; replyTo?: number }>>();
  private readonly chatProcessors = new Map<string, Promise<void>>();
  private pollingAbort?: AbortController;
  private lastUpdateId = 0;

  constructor(options: TelegramGatewayOptions) {
    this.botToken = options.botToken;
    this.webhookSecret = options.webhookSecret;
    this.webhookUrl = options.webhookUrl;
    this.polling = options.polling ?? false;
    this.allowedChatIds = new Set(options.allowedChatIds ?? []);
    this.log = options.log ?? (() => {});
    this.sessionOptions = {
      roomsDir: options.roomsDir,
      memoryAdapter: options.memoryAdapter,
      sessionStore: options.sessionStore,
      threadStore: options.threadStore,
      log: this.log,
      onEnd: options.onEnd,
      defaultAgent: options.defaultAgent ?? Bun.env.ANIMA_DEFAULT_AGENT ?? "bruno",
    };
    this.sessionStore = new TelegramSessionStore(this.log);
  }

  /** Start the gateway: webhook registration or polling. Called once on startup. */
  async start(): Promise<void> {
    if (this.polling) {
      this.startPolling();
      return;
    }
    await this.registerWebhook();
  }

  /** Register the webhook with Telegram. Called once on startup. */
  async registerWebhook(): Promise<void> {
    if (!this.webhookUrl) {
      this.log("info", "telegram webhook URL not configured — skipping registration", { type: "telegram_webhook_skip" });
      return;
    }

    try {
      const resp = await fetch(`${TELEGRAM_API}/bot${this.botToken}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: this.webhookUrl,
          secret_token: this.webhookSecret,
          drop_pending_updates: false,
        }),
      });

      const data = await resp.json() as TelegramApiResponse;
      if (!data.ok) {
        this.log("error", "telegram setWebhook failed", {
          type: "telegram_webhook_error",
          error: JSON.stringify(data),
        });
      } else {
        this.log("info", "telegram webhook registered", {
          type: "telegram_webhook_registered",
          url: this.webhookUrl,
        });
      }
    } catch (err) {
      this.log("error", "telegram setWebhook network error", {
        type: "telegram_webhook_network_error",
        error: String(err),
      });
    }
  }

  /** Validate the webhook secret token. */
  validateSecret(req: Request): boolean {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    return header === this.webhookSecret;
  }

  /** Handle an incoming webhook request from Telegram. */
  async handleWebhook(req: Request): Promise<Response> {
    if (!this.validateSecret(req)) {
      this.log("error", "telegram webhook — invalid secret", { type: "telegram_invalid_secret" });
      return new Response("unauthorized", { status: 401 });
    }

    let body: TelegramUpdate;
    try {
      body = await req.json() as TelegramUpdate;
    } catch {
      return new Response("invalid body", { status: 400 });
    }

    // Handle callback queries (inline keyboard button presses)
    if (body.callback_query) {
      void this.handleCallbackQuery(body.callback_query);
      return new Response("ok");
    }

    const msg = body.message;
    if (!msg?.text) {
      return new Response("ok"); // no text — ignore (sticker, photo, etc.)
    }

    // Deduplicate retried updates
    if (body.update_id && this.processedUpdateIds.has(body.update_id)) {
      return new Response("ok");
    }
    if (body.update_id) this.processedUpdateIds.add(body.update_id);

    const chatId = String(msg.chat.id);
    if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
      return new Response("ok");
    }
    const userId = String(msg.from?.id ?? "unknown");
    const text = msg.text;
    const messageId = msg.message_id;

    // Return 200 immediately so Telegram doesn't retry — queue and process async
    this.enqueueMessage(chatId, text, userId, messageId);

    return new Response("ok");
  }

  /** Enqueue a message for a chat and start a drainer if none is running. */
  private enqueueMessage(chatId: string, text: string, userId: string, replyTo?: number): void {
    if (!this.chatQueues.has(chatId)) {
      this.chatQueues.set(chatId, []);
    }
    this.chatQueues.get(chatId)!.push({ text, userId, replyTo });

    if (this.chatProcessors.has(chatId)) {
      return; // drainer already running, it will pick up the new item
    }

    const processor = this.drainChatQueue(chatId).finally(() => {
      this.chatProcessors.delete(chatId);
    });
    this.chatProcessors.set(chatId, processor);
  }

  /** Process all queued messages for a chat sequentially. */
  private async drainChatQueue(chatId: string): Promise<void> {
    const queue = this.chatQueues.get(chatId);
    if (!queue) return;

    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const session = this.sessionStore.getOrCreate(chatId, this.sessionOptions);
        const result = await session.process(item.text, item.userId);
        if (result.reply) {
          await this.sendMessage(chatId, result.reply, { replyTo: item.replyTo, inlineKeyboard: result.inlineKeyboard });
        }
      } catch (err) {
        this.log("error", "telegram message processing error", {
          type: "telegram_process_error",
          chatId,
          error: String(err),
        });
      }
    }
  }

  /** Start long-polling loop. Call once on startup when webhook URL is not available. */
  startPolling(): void {
    if (this.pollingAbort) return; // already running
    this.pollingAbort = new AbortController();
    const signal = this.pollingAbort.signal;

    // Delete any existing webhook so updates come via getUpdates
    fetch(`${TELEGRAM_API}/bot${this.botToken}/deleteWebhook?drop_pending_updates=false`)
      .then(() => this.log("info", "telegram polling started", { type: "telegram_polling_start" }))
      .catch(() => {});

    const poll = async () => {
      while (!signal.aborted) {
        try {
          const url = `${TELEGRAM_API}/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5&allowed_updates=["message"]`;
          const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
          const data = await resp.json() as { ok: boolean; result?: TelegramUpdate[] };

          if (!data.ok) {
            const errData = data as { error_code?: number; description?: string };
            if (errData.error_code === 409) {
              // Another getUpdates is active — wait for it to expire (30s timeout + buffer)
              this.log("info", "telegram poll 409 conflict, waiting 35s for old connection to expire", { type: "telegram_poll_conflict", tokenSuffix: this.botToken.slice(-8) });
              await sleep(35_000);
            } else {
              await sleep(2000);
            }
            continue;
          }
          if (data.ok && data.result) {
            for (const update of data.result) {
              this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

              // Handle callback queries (inline keyboard presses)
              if (update.callback_query) {
                void this.handleCallbackQuery(update.callback_query);
                continue;
              }

              const msg = update.message;
              if (!msg?.text) continue;

              const chatId = String(msg.chat.id);
              if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) continue;
              const userId = String(msg.from?.id ?? "unknown");
              const replyTo = msg.message_id;
              // Queue message per chat so the poll loop is never blocked by a slow agent.
              // Messages in the same chat are processed sequentially to preserve order.
              this.enqueueMessage(chatId, msg.text, userId, replyTo);
            }
          }
        } catch (err) {
          if (signal.aborted) break;
          // Network errors are expected occasionally — just retry
          await sleep(2000);
        }
      }
    };

    poll().catch(() => {});
  }

  /** Stop the polling loop. */
  stopPolling(): void {
    this.pollingAbort?.abort();
    this.pollingAbort = undefined;
  }

  private chunkText(text: string, maxLen = 4000): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }
      // Prefer splitting at newline nearest to maxLen
      let cut = remaining.lastIndexOf("\n", maxLen);
      if (cut < maxLen * 0.5) cut = maxLen; // no good newline — hard cut
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    return chunks;
  }

  private async sendRaw(
    chatId: string,
    text: string,
    opts?: { replyTo?: number; inlineKeyboard?: InlineKeyboard },
  ): Promise<{ messageId?: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "MarkdownV2" };
    if (opts?.replyTo) body.reply_to_message_id = opts.replyTo;
    if (opts?.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard };

    const resp = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await resp.json() as TelegramApiResponse;
    if (!data.ok) {
      // Retry without MarkdownV2
      body.parse_mode = undefined;
      const retry = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const retryData = await retry.json() as TelegramApiResponse;
      if (!retryData.ok) {
        this.log("error", "telegram sendMessage failed", { type: "telegram_send_error", chatId, error: JSON.stringify(retryData) });
      }
      return { messageId: retryData.ok ? retryData.result?.message_id : undefined };
    }
    return { messageId: data.result?.message_id };
  }

  /** Send a text message to a Telegram chat. Automatically chunks messages > 4000 chars. */
  async sendMessage(
    chatId: string,
    text: string,
    opts?: { replyTo?: number; inlineKeyboard?: InlineKeyboard },
  ): Promise<{ messageId?: number }> {
    try {
      const chunks = this.chunkText(text);
      let lastMessageId: number | undefined;
      for (let i = 0; i < chunks.length; i++) {
        // Only attach inlineKeyboard to the last chunk
        const chunkOpts = i === chunks.length - 1 ? opts : { replyTo: opts?.replyTo };
        const result = await this.sendRaw(chatId, chunks[i], i === 0 ? chunkOpts : { replyTo: undefined });
        lastMessageId = result.messageId ?? lastMessageId;
      }
      return { messageId: lastMessageId };
    } catch (err) {
      this.log("error", "telegram sendMessage network error", {
        type: "telegram_send_network_error",
        chatId,
        error: String(err),
      });
      return {};
    }
  }

  /** Answer a callback query to stop the loading indicator. */
  async answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
    try {
      await fetch(`${TELEGRAM_API}/bot${this.botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackId, text }),
      });
    } catch {
      // best-effort
    }
  }

  /** Handle an incoming callback_query (inline keyboard button press). */
  private async handleCallbackQuery(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const chatId = String(cq.message?.chat.id ?? "");
    const messageId = cq.message?.message_id ?? 0;
    const data = cq.data;
    if (!chatId || !data) {
      await this.answerCallbackQuery(cq.id);
      return;
    }

    try {
      const result = await this.sessionStore.handleCallback(chatId, data, messageId, cq.id);
      if (!result) {
        await this.answerCallbackQuery(cq.id);
        return;
      }
      await this.answerCallbackQuery(cq.id, result.answerText);
      if (result.editKeyboard !== undefined && messageId) {
        await this.editMessageReplyMarkup(chatId, messageId, result.editKeyboard);
      }
      if (result.text) {
        await this.sendMessage(chatId, result.text);
      }
    } catch (err) {
      this.log("error", "telegram callback error", { type: "telegram_callback_error", chatId, error: String(err) });
      await this.answerCallbackQuery(cq.id);
    }
  }

  /** Edit an inline keyboard on an existing message. */
  async editMessageReplyMarkup(chatId: string, messageId: number, inlineKeyboard: InlineKeyboard | null): Promise<void> {
    try {
      await fetch(`${TELEGRAM_API}/bot${this.botToken}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
        }),
      });
    } catch {
      // best-effort
    }
  }
}

/** Create a TelegramGateway from env vars. Returns null if not configured. */
export function createGatewayFromEnv(opts: {
  roomsDir?: string;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  log?: LogFn;
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
}): TelegramGateway | null {
  const botToken = Bun.env.ANIMA_TELEGRAM_BOT_TOKEN;
  const webhookSecret = Bun.env.ANIMA_TELEGRAM_WEBHOOK_SECRET;
  const webhookUrl = Bun.env.ANIMA_TELEGRAM_WEBHOOK_URL;

  if (!botToken || !webhookSecret) {
    return null;
  }

  const polling = Bun.env.ANIMA_TELEGRAM_POLLING === "true" || Bun.env.ANIMA_TELEGRAM_POLLING === "1";
  const allowedChatIds = Bun.env.ANIMA_TELEGRAM_ALLOWED_CHAT_IDS?.split(",").map(s => s.trim()).filter(Boolean);

  return new TelegramGateway({
    botToken,
    webhookSecret,
    webhookUrl,
    polling,
    allowedChatIds,
    ...opts,
  });
}

/** Create one TelegramGateway per agent from ANIMA_TELEGRAM_BOT_TOKEN_<AGENT> env vars.
 *  Skips any agent whose token matches ANIMA_TELEGRAM_BOT_TOKEN (handled by main gateway). */
export function createMultiAgentGatewaysFromEnv(opts: {
  roomsDir?: string;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  log?: LogFn;
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
}): TelegramGateway[] {
  const polling = Bun.env.ANIMA_TELEGRAM_POLLING === "true" || Bun.env.ANIMA_TELEGRAM_POLLING === "1";
  const webhookSecret = Bun.env.ANIMA_TELEGRAM_WEBHOOK_SECRET ?? "";
  const webhookUrl = Bun.env.ANIMA_TELEGRAM_WEBHOOK_URL;
  const mainToken = Bun.env.ANIMA_TELEGRAM_BOT_TOKEN;
  const allowedChatIds = Bun.env.ANIMA_TELEGRAM_ALLOWED_CHAT_IDS?.split(",").map(s => s.trim()).filter(Boolean);

  const gateways: TelegramGateway[] = [];
  const seenTokens = new Set<string>(mainToken ? [mainToken] : []);

  for (const [key, value] of Object.entries(Bun.env)) {
    const match = key.match(/^ANIMA_TELEGRAM_BOT_TOKEN_([A-Z0-9_]+)$/);
    if (!match || !value) continue;
    if (seenTokens.has(value)) continue; // skip duplicates / main bot reuse
    seenTokens.add(value);
    const agentName = match[1].toLowerCase();

    gateways.push(
      new TelegramGateway({
        botToken: value,
        webhookSecret,
        webhookUrl,
        polling,
        defaultAgent: agentName,
        allowedChatIds,
        ...opts,
      }),
    );
  }

  return gateways;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
