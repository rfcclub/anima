# Web UI

The Web UI ("Agent Town") is a React app in `src/ui/`, served by its own Bun server (`src/ui/app/server.ts`).

::: danger
Like the API server, the UI server has no authentication. Keep it on localhost. See [Security Status](../guide/security.md).
:::

## Enable it

```bash
bun run start:ui        # ANIMA_UI_ENABLED=true bun src/server.ts
bun run dev:ui          # same, with --watch
bun run start:ui-only   # only the UI server (bun src/ui/server.ts)
```

| Setting | Default |
|---------|---------|
| Port | `3000` (`ANIMA_UI_PORT`) |
| Max request body | 12 MB (for visual-novel asset uploads) |
| Session database | `$ANIMA_UI_STATE_DIR/sessions.db`, else `~/.anima/sessions.db` |

On start, the server builds the client bundle if `dist/index.html` is missing from the UI directory (`src/ui/` when run from source). If a bundle already exists, it's reused.

## Pages

| Path | Page |
|------|------|
| `/` | Town |
| `/hall`, `/library`, `/observatory`, `/forge`, `/bodega`, `/bridge` | Public rooms |
| `/castle`, `/westwing`, `/eastwing` | Castle screens |
| `/rooms/:agent` | One agent's room (chat) |
| `/cost` | Cost dashboard |
| `/logs` | Log viewer |
| `/projects` | Status dashboard |
| `/vn-assets`, `/narrative` | Visual-novel assets and narrative |

## Chat API

Chat runs through `AgentSession`, the same engine Telegram and the mesh use. The main routes (`src/ui/features/town/routes.ts`):

| Method | Path | Does |
|--------|------|------|
| POST | `/api/talk/:agent` | Send a message. Body `{ message, imageData?, mode?, model?, ... }`. The reply streams back as server-sent events |
| GET | `/api/session/:agent` | Current session |
| GET | `/api/turns/:agent` | Session turns |
| POST | `/api/new/:agent` | Close the session and start a new one |
| POST | `/api/compact/:agent`, `/api/retry/:agent`, `/api/summary/:agent`, `/api/review/:agent` | Session actions |
| GET | `/api/export/:agent`, `/api/history/:agent`, `/api/branches/:agent` | Read session data |
| POST | `/api/back/:agent` | Go back one turn (branching mode) |
| POST | `/api/config/:agent` | Change agent settings |
| GET | `/api/models` | Available models |
| GET, POST | `/api/mode` | Read or set the task mode |
| POST | `/api/meet` | Run a meeting |

Other API routes: `/api/version`, `/api/memory/health`, `/api/logs`, `/api/logs/stream`, `/api/castle/*` (feed, presence, replay, room log), `/api/cost`, `/api/status` and `/api/projects`.

## Daily session jobs

When the server runs, two timers act on Web UI sessions:

- **12:00 local**: writes a beam from each agent's open `ui` session, so the nightly dream has material even if nobody pressed "New".
- **22:00 local**: closes every open `ui` session, so the next day starts fresh.

See [Scheduling](../sessions/scheduling.md).
