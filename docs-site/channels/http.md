# HTTP Channel

`src/server.ts` runs the API server with `Bun.serve`. Requests go through `handleRequest()`. Every route on this page appears there.

::: danger No authentication
None of these routes checks a token. Keep the server on localhost. See [Security Status](../guide/security.md).
:::

## Starting it

```bash
bun run start        # bun src/server.ts
bun run dev          # with --watch
```

| Setting | Default |
|---------|---------|
| Port | `3700` (`PORT`) |
| Idle timeout | 255 seconds (Bun's maximum, so slow agent replies aren't cut off) |
| Max request body | 1 MB |
| Rooms directory | `ANIMA_ROOMS_DIR`, else `./rooms` |

There is **no chat endpoint** on this server. Chat goes through the [Web UI](./web-ui.md) API, [Telegram](./telegram.md), the [mesh](./mesh.md) or the [CLI](./cli.md).

## Routes

### Health and status

| Method | Path | Returns |
|--------|------|---------|
| GET | `/health` | `{ status: "ok", version, uptime, agents: [names] }` |
| GET | `/status` | `{ agents: [{ name, label, provider, mount, lastSession }] }`. `mount` is `ok` when `<room>/mount` exists, otherwise `missing` |

### Dreams and reflection

| Method | Path | Body | Does |
|--------|------|------|------|
| POST | `/dream` | `{ agent, prompt? }` | Runs a [lucid dream](../sessions/dream.md) for one agent and returns `{ agent, reflection }`. The agent name must match `^[a-zA-Z0-9_-]+$` |
| POST | `/colony/reflect` | `{ from, about, content }` | Writes a cross-agent reflection as a beam into `<about>`'s staging |
| POST | `/reflection/tick` | `{ agent?, intent? }` | Knocks the reflection scheduler for an agent (default `bruno`) |
| POST | `/pulse-anima/force-tick` | none | Runs a pulse-anima tick now, outside its hour window |

### Colony

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/colony` | Agents from `data/colony.json` with their top trust domains |
| GET | `/api/colony/states` | All agent states |
| GET | `/api/agent/:name` | One agent's colony entry, trust domains and active tasks |
| GET | `/colony` | Agents from `data/colony.json` with their maturation status |

`data/colony.json` is read from the working directory.

### Cost

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/cost/summary` | Token and cost summary |
| GET | `/api/cost/by-model` | Totals per model |
| GET | `/api/cost/by-agent` | Totals per agent |
| GET | `/api/cost/by-provider` | Totals per provider |
| GET | `/cost` | HTML cost page |

The `/api/cost/*` routes accept `since`, `until` and `agentId` query parameters. Data comes from `ANIMA_COST_DB` (default `~/.anima/cost.db`).

### Logs

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/logs` | Lines from `~/.anima/logs/server.log`. Query: `lines` (default `200`), `level`, `q` |
| GET | `/api/logs/stream` | The same log as a live stream |

### Mesh, Telegram and LLM proxy

| Method | Path | Does |
|--------|------|------|
| POST | `/api/mesh/notify` | Body `{ recipient_id, content, subject?, ... }`. Appends the message as a user turn in the recipient's `mesh` session (the `anima-` prefix is stripped) |
| POST | `/webhook/telegram` | Telegram webhook, only when a [Telegram gateway](./telegram.md) is configured |
| POST | `/ai/v1/messages` | Anthropic-format LLM proxy. See [Proxy System](../misc/proxy-system.md) |
| POST | `/ai/v1/chat/completions`, `/ai/v1/responses` | OpenAI-format LLM proxy |

### Other

| Method | Path | Does |
|--------|------|------|
| any | `/internal/continuity/*` | Identity-runtime continuity API (`src/api/identity-runtime/handlers.ts`) |
| GET | `/docs/*` | This documentation site, from `docs-site/.vitepress/dist` or `ANIMA_DOCS_DIR` |

Anything else returns `404 { "error": "not_found" }`. An unhandled error returns `500 { "error": "internal_server_error" }`.

## Examples

```bash
curl http://localhost:3700/health
curl http://localhost:3700/status
curl -X POST http://localhost:3700/dream \
  -H 'content-type: application/json' \
  -d '{"agent":"myagent","prompt":"Reflect on today."}'
curl 'http://localhost:3700/api/cost/by-agent?since=2026-10-01'
```

## What else the server starts

Besides HTTP, `bun src/server.ts` starts:

- the deep dream, lucid dream sweep and Town/Castle timers (see [Scheduling](../sessions/scheduling.md))
- the reflection scheduler
- the Telegram gateway(s), when configured
- the A2A inbox for the agents in `data/colony.json`
- the Web UI server, when `ANIMA_UI_ENABLED=true`
