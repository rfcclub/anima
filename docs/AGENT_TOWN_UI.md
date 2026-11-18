# Agent Town UI

ANIMA includes a web-based dashboard for interacting with your agent colony.

## Starting the UI

```bash
# Start with UI enabled
ANIMA_UI_ENABLED=true bun start

# UI-only mode (no API server)
bun start:ui-only

# Development with hot reload
ANIMA_UI_ENABLED=true bun dev
```

The UI is served at **`http://localhost:3000`** (configurable via `ANIMA_UI_PORT`).

## Interface Overview

The Agent Town UI has three panels:

```
┌──────────────┬──────────────────────────┬─────────────┐
│              │                          │             │
│   COLONY     │       CHAT PANEL         │  SESSION    │
│   SIDEBAR    │                          │  INFO       │
│              │                          │             │
│  ● bruno      │  ┌──────────────────┐    │  Session    │
│  ● eli      │  │ Message thread   │    │  Turns      │
│  ● sam     │  │ ...              │    │  Est.Tokens │
│  ● milo      │  │                  │    │  Baseline   │
│  ● cleo      │  └──────────────────┘    │  Mail       │
│  ● lena      │                          │             │
│  ● ivan      │  [Message input    ]     │  Mode: ▾    │
│              │  [Send]                  │             │
│              │                          │             │
│  Meetings    │                          │             │
│  ─────────   │                          │             │
│  ● topic-1   │                          │             │
│  ● topic-2   │                          │             │
└──────────────┴──────────────────────────┴─────────────┘
```

### Colony Sidebar (left)

- **Agent list** — shows all configured agents with status indicators:
  - 🟢 Green dot = `online` (active session)
  - 🟡 Yellow dot = `busy` (currently processing)
  - ⚪ Grey dot = `offline` (no recent activity)
- Each agent has a **color bar** for visual identification
- **Meetings section** — lists active meeting topics
- Click an agent to select it and open its chat

### Chat Panel (center)

- **Agent header** — shows which agent you're chatting with, color-coded
- **Message thread** — conversation history with the selected agent
  - User messages on the right
  - Agent responses on the left, with color-coded border
- **Streaming** — agent responses stream in real-time
- **Input area** — type a message and press Enter (or click Send)
- Messages clear when switching agents

### Session Info (right)

- **Session ID** — current session UUID
- **Turn count** — number of exchanges in this session
- **Estimated tokens** — approximate token usage
- **Baseline** — whether a compacted baseline exists
- **Unread mail** — count of unread meeting messages
- **Mode selector** — switch between `plan`, `edit`, `auto`

## Chatting with an Agent

1. Select an agent from the Colony sidebar
2. Type your message in the input field at the bottom
3. Press **Enter** or click **Send**
4. The agent's response streams in real-time

While the agent is responding:
- The send button shows `…` (loading state)
- The input is disabled
- You can see partial responses as they arrive

## Switching Modes

Use the **Mode** dropdown in the Session Info panel:

1. Select `plan`, `edit`, or `auto`
2. The mode change is sent to the server immediately
3. The new mode applies to the next message

Note: `auto` mode only works if `autoModeOptIn: true` is set in the agent's room config.

## Agent Colors

Each agent has a fixed color for visual identification:

| Agent | Color |
|-------|-------|
| bruno | `#e94560` (red) |
| eli | `#00d2ff` (cyan) |
| milo | `#bb86fc` (purple) |
| sam | `#f0883e` (orange) |
| cleo | `#3fb950` (green) |
| lena | `#ffd700` (gold) |
| ivan | `#8b949e` (grey) |

## API Endpoints

The UI server exposes these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the Agent Town SPA |
| `/api/status` | GET | Agent list + meeting topics |
| `/api/talk/:agent` | POST | Send message (SSE streaming) |
| `/api/session/:agent` | GET | Session info for agent |
| `/api/mode` | GET/POST | Get or set current task mode |

### Talk Endpoint (SSE)

```
POST /api/talk/bruno
Content-Type: application/json

{"message": "Hello"}

Response (Server-Sent Events):
data: "Hel"
data: "lo,"
data: " how"
data: " can"
data: " I"
data: " help?"
data: [DONE]
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ANIMA_UI_PORT` | `3000` | Web UI port |
| `ANIMA_UI_STATE_DIR` | `./.anima-ui-state` | UI state persistence |
| `ANIMA_UI_ENABLED` | `false` | Must be `true` to start UI |
