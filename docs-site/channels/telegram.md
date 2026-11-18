# Telegram Channel

The server can run one or more Telegram bots. The code is in `src/channels/telegram-gateway.ts` (Telegram API, webhook and polling), `src/channels/telegram-session.ts` (per-chat sessions and commands) and `src/channels/telegram.ts`.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Set the environment variables below and start the server (`bun run start`).

| Variable | Required | Meaning |
|----------|----------|---------|
| `ANIMA_TELEGRAM_BOT_TOKEN` | yes | Main bot token |
| `ANIMA_TELEGRAM_WEBHOOK_SECRET` | yes | Webhook secret. The main gateway doesn't start without it, even in polling mode |
| `ANIMA_TELEGRAM_WEBHOOK_URL` | for webhooks | Public URL Telegram should call. It should reach `POST /webhook/telegram` on the server. Without it, webhook registration is skipped |
| `ANIMA_TELEGRAM_POLLING` | no | `true` or `1` to use long polling instead of a webhook |
| `ANIMA_TELEGRAM_ALLOWED_CHAT_IDS` | no | Comma-separated chat ids. If set, other chats are ignored. If unset, **every chat is accepted** |
| `ANIMA_DEFAULT_AGENT` | no | Agent that joins a chat when nobody is addressed. Default `bruno` |
| `ANIMA_TELEGRAM_BOT_TOKEN_<AGENT>` | no | Extra bot for one agent. `<AGENT>` is the agent name in upper case. That bot's default agent is the lower-cased name |

::: tip
Set `ANIMA_TELEGRAM_ALLOWED_CHAT_IDS`. Without it, anyone who finds the bot can talk to your agents.
:::

## Webhook or polling

- **Webhook** (default): on start, the gateway calls Telegram's `setWebhook` with the URL and secret. Incoming requests must carry the secret, or they get `401`. The gateway answers `200` right away and processes the message in the background.
- **Polling** (`ANIMA_TELEGRAM_POLLING=true`): the gateway deletes any webhook and calls `getUpdates` in a loop.

Messages in one chat are queued and handled in order, so you can keep typing while the agent works.

## What it handles

- **Text messages only.** Updates without text (photos, stickers, files) are ignored.
- **Inline keyboard callbacks**, used by the `/model` picker.
- **Replies** longer than about 4,000 characters are split into several messages.

## Addressing agents

- `@agent message` adds that agent to the chat's session and sends it the message. With several mentions, the first agent answers and the others observe.
- `@all` lets every agent in the session observe the message. Nobody answers.
- A message with no `@mention` goes to the first agent in the session. The others observe it.
- If nobody is in the session yet, the default agent joins.

## Commands

| Command | Does |
|---------|------|
| `/end` | End the session for this chat |
| `/who` | List agents in the session |
| `/leave @agent` | Remove an agent from the session |
| `/status`, `/agents` | List rooms with their label and provider |
| `/review` | List the escalation review queue |
| `/approve <id>` | Approve a review item (confirms trust for its domain) |
| `/reject <id> <feedback>` | Reject a review item (penalizes trust for its domain) |
| `/colony` | List colony agents from `data/colony.json` with their top trust scores |
| `/model` | Pick a model with an inline keyboard |
| `/model <model>` or `/model <provider>/<model>` | Switch model for this chat |
| `/model reset` | Go back to the room's configured model |
| `/thinktag on\|off` | Show or hide `<think>` tags in replies |
| `/mode <mode>` | Replies with the mode name, but **doesn't change anything** yet |

Any other `/command` replies with the list of commands.
