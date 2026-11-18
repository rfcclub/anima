# Telegram Gateway

Anima ships a Telegram channel that connects Telegram chats to agent rooms. Messages sent to the bot are routed to the appropriate agent and replies are sent back.

## Prerequisites

- A Telegram bot created via [@BotFather](https://t.me/BotFather)
- The bot token (format: `1234567890:ABCdef...`)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANIMA_TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ANIMA_TELEGRAM_WEBHOOK_URL` | Webhook mode | Public HTTPS URL for the webhook endpoint |
| `ANIMA_TELEGRAM_WEBHOOK_SECRET` | Recommended | Secret token for webhook validation (prevents spoofed requests) |
| `ANIMA_TELEGRAM_POLLING` | Polling mode | Set to `"true"` to use long-polling instead of webhooks |

## Modes: Webhook vs Polling

**Webhook** (production): Telegram pushes updates to your public URL. Requires HTTPS.

```bash
ANIMA_TELEGRAM_BOT_TOKEN=<token>
ANIMA_TELEGRAM_WEBHOOK_URL=https://yourdomain.com
ANIMA_TELEGRAM_WEBHOOK_SECRET=mysecrettoken
bun start
```

**Polling** (local development): Anima polls the Telegram API for updates. No public URL needed.

```bash
ANIMA_TELEGRAM_BOT_TOKEN=<token>
ANIMA_TELEGRAM_POLLING=true
bun start
```

## Room-to-Chat Routing

Each incoming Telegram message carries a `chat_id`. The gateway maps chat IDs to agent rooms. Rooms are configured in `rooms/<name>/config.yaml` — the agent to route to is determined by the room's `channels.telegram.chatId` field (if present), or by a top-level routing config.

For single-agent setups, all messages go to the one configured agent. For multi-room setups, add a `channels` block to each room config:

```yaml
# rooms/bruno/config.yaml
channels:
  telegram:
    chatId: "123456789"     # Telegram chat ID this room listens to
```

If no `chatId` is set on any room, the gateway routes to the first available agent.

To find your chat ID: send a message to your bot, then call:
```
https://api.telegram.org/bot<token>/getUpdates
```
The `chat.id` field in the response is your chat ID.

## Message Format

- User messages arrive as plain text turns
- Markdown formatting in agent replies is passed through as-is (Telegram supports MarkdownV2)
- Photos and documents sent to the bot are not processed by default (text only)

## Webhook Registration

The server registers the webhook automatically at startup when `ANIMA_TELEGRAM_WEBHOOK_URL` is set. You can verify it was registered:

```bash
curl https://api.telegram.org/bot<token>/getWebhookInfo
```

To deregister:
```bash
curl https://api.telegram.org/bot<token>/deleteWebhook
```

## Testing

1. Start the server in polling mode locally:
   ```bash
   ANIMA_TELEGRAM_BOT_TOKEN=<token> ANIMA_TELEGRAM_POLLING=true bun start
   ```
2. Open Telegram, find your bot, send a message
3. Check server logs (`~/.anima/logs/server.log` or stdout) for `telegram_session_create` and `telegram_agent_join` events
4. The bot should reply

## Logs

Telegram events are logged with structured fields:

| Event type | Meaning |
|------------|---------|
| `telegram_session_create` | New chat session started |
| `telegram_agent_join` | Agent joined a Telegram session |
| `telegram_session_end` | Chat session ended (idle timeout) |
| `telegram_agent_error` | Error processing a message |
| `telegram_session_remove` | Session removed after idle timeout |
