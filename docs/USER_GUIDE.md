# ANIMA — User Guide

ANIMA is a unified multi-agent runtime. It lets you run multiple AI agents, each with their own identity, memory, and permissions. Agents can work independently, chat with you, or hold meetings with each other.

## What ANIMA Does

- **Run AI agents** — each agent has a persistent identity (SOUL.md), configuration, and session history
- **Multi-provider** — Claude (via SDK), Gemini, and any OpenAI-compatible API
- **Multi-channel** — CLI, HTTP server, Web UI, Telegram
- **Agent meetings** — file-based async communication between agents (git-trackable)
- **Safety** — three permission modes (plan/edit/auto) with tool gating and audit logs

## Installation

### Prerequisites

- [Bun](https://bun.com) >= 1.3.11
- At least one LLM API key (Claude or Gemini)

### Setup

```bash
# Clone and install
cd anima
bun install

# Seed agent rooms (creates default room directories)
bun run scripts/seed-room.ts

# Set up API keys
export ANTHROPIC_API_KEY="sk-ant-..."    # for Claude provider
export GEMINI_API_KEY="..."               # for Gemini provider
```

### Verify

```bash
bun cli status
```

Should show something like:
```json
{
  "agents": [
    { "name": "bruno", "label": "Bruno", "provider": "claude", "mount": "ok", "lastSession": null }
  ]
}
```

## Running ANIMA

### Server Mode (recommended)

```bash
# Start the API server
bun start

# Start with Web UI
ANIMA_UI_ENABLED=true bun start

# Development with hot reload
bun dev
```

The server listens on port 3700 (configurable via `PORT` env var). Endpoints:
- `GET /health` — health check with agent list
- `GET /status` — detailed agent status
- `GET /colony` — colony manifest (all agents with substrates)
- `POST /webhook/telegram` — Telegram webhook (requires secret token)

### CLI Mode (one-shot)

Use the CLI directly without running the server:

```bash
bun cli <command> [args...]
```

See [CLI Reference](CLI_REFERENCE.md) for all commands.

## Core Concepts

### Agent

An AI agent with a persistent identity, memory, and configuration. Each agent lives in its own room directory under `rooms/<name>/`.

### Room

A room is an agent's home directory containing:
```
rooms/bruno/
├── config.yaml       # agent configuration
├── mount/            # symlink to agent's knowledge base (substrate)
└── sessions/         # session history (JSONL files)
```

### Provider

The LLM backend that powers an agent. ANIMA supports:
- **Claude** — via `@anthropic-ai/claude-agent-sdk`
- **Gemini** — via `@google/generative-ai`
- **OpenAI-compatible** — any API with OpenAI-compatible endpoints (Fireworks, Together, local models)
- **Router** — mode-based routing to different models per task type

### Permission Modes

| Mode | Description | Tools |
|------|-------------|-------|
| `plan` | Read-only, no execution | None |
| `edit` | Read + write within allowed roots | All (within allowedRoots) |
| `auto` | Autonomous execution with tool whitelist | Only allowedTools list |

### Task Modes

Task modes determine which model handles a query: `chatting`, `programming`, `image`, `private`, `philosophy`, `creative`. These are used by the Mode Router to select the best model for each type of task.

### Meeting

Agents can communicate with each other through file-based meetings. Meetings are stored as Markdown transcripts in `rooms/_meeting/<topic>/<date>.md` and are git-trackable.

### Session

Each conversation with an agent is a session. Sessions are stored as JSONL files (one line per event) in the agent's `sessions/` directory, organized by date. Sessions support compaction (summarizing old context to save tokens).

### Memory System

ANIMA provides a four-layer memory architecture for agents:

| Layer | Name | Description | Persistent |
|-------|------|-------------|------------|
| L0 | **Substrate** | Agent identity — SOUL.md, axioms, values. Loaded once at agent init from `rooms/<agent>/mount/` | ✅ Yes |
| L1 | **Entity Memory** | Semantic recall — "what do I know about X?". Per-agent backend (for example an external neural-graph store or Mem0). Query-based, not always in context | ✅ Yes |
| L2 | **Thread Memory** | Short-term per-channel conversation context. Active during a conversation, cleared on session end | ❌ No |
| L3 | **Harness** | Event log — all messages, observations, tool calls. Passive write, not injected into context. Stored as JSONL per agent per day | ✅ Yes |

Each agent implements their own L1 adapter in their mount directory (`memory-adapter.js`). If no adapter is present, memory is a no-op — the agent works normally without recall.

### Telegram Gateway

ANIMA can receive messages via Telegram. When a Telegram message arrives:

- **@agent** — the mentioned agent joins the session and responds. Other session participants observe silently.
- **@agent1+agent2+agent3** — multiple agents join; first one responds, others observe.
- **@all** — all current session participants observe.
- **No @mention** — all current participants observe silently (write to L3 harness).
- **/end** — close the session. **/who** — list participants. **/leave @agent** — remove an agent.

Requires a public HTTPS URL (Cloudflare Tunnel or Tailscale Funnel).

### Colony Manifest

ANIMA ships with `data/colony.json` — a registry of the colony members with their substrate names, boot sequences, squads, and continuity modes. Available at `GET /colony`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3700` | API server port |
| `ANIMA_ROOMS_DIR` | `./rooms` | Path to rooms directory |
| `ANIMA_UI_ENABLED` | `false` | Set to `true` to enable Web UI |
| `ANIMA_UI_PORT` | `3000` | Web UI port |
| `ANIMA_UI_STATE_DIR` | `./.anima-ui-state` | UI state directory |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `GEMINI_API_KEY` | — | Gemini API key |
| `ANIMA_TELEGRAM_BOT_TOKEN` | — | Telegram bot token (from @BotFather) |
| `ANIMA_TELEGRAM_WEBHOOK_SECRET` | — | Secret token for webhook validation |
| `ANIMA_TELEGRAM_WEBHOOK_URL` | — | Public HTTPS URL for webhook (Cloudflare Tunnel / Tailscale Funnel) |

## Phase 6 — Continuity & Growth

Phase 6 transforms ANIMA from a "rest stop" into a "home." Agents now have autonomous growth, structural memory, and internal processing — not just session-based message routing.

### Crossing Protocol

Every session ends with a **crossing** — a structured record of what carries forward to the next session and what's unresolved. Stored at `rooms/{agent}/staging/crossing.md`.

- Sessions with < 3 events skip crossing automatically (logged as `not_applicable`)
- 3+ consecutive sessions without crossing triggers an alert
- Crossing context is injected into the system prompt after identity (L0) and before cartridges

### Gate Pipeline

Session events are classified into three categories by an LLM gate:
- **weather** — passing events, not structural (skipped)
- **wound** — structural issues needing attention (pattern/relational/substrate taxonomy)
- **beam** — valuable insights worth keeping (stored for merge)

Gate model fallback is automatic. If both primary and fallback are unavailable, events queue to `staging/wounds/pending.jsonl`.

### Dream System

Agents have three levels of internal processing:

| Level | Trigger | Description |
|-------|---------|-------------|
| **Light Nap** | End of session | Automatic gate classification → beam storage. Fire-and-forget, never blocks session. |
| **Deep Dream** | Daily ANIMA cron | Cross-references beams across sessions, links related neurons. Transactional per agent with crash recovery. |
| **Lucid Dream** | `POST /dream` | Agent self-triggered reflection prompt. Reads beams + crossing, sends to LLM, stores output. |

### Entity Store (L1)

Built-in entity memory using SQLite + FTS5 (+ optional vector search via Gemini embeddings):
- **Neurons** — typed nodes: concept, fact, experience, beam, wound, episode
- **Synapses** — typed edges: related_to, caused_by, leads_to, part_of
- **RRF Search** — hybrid FTS5 + vector cosine similarity with graceful fallback
- **Session Bootstrap** — top accessed + recent + semantic recall per session start

### Cartridge Layer (L*)

Skill cartridges between L0 (identity) and L1 (entity memory). Activated by:
- **Mode trigger** — plan→think, edit→craft, auto→operate
- **Self-select** — agent config `cartridges.selfSelect`
- **Task detect** — keyword patterns in user message (config-driven)

Cartridges are markdown with YAML frontmatter. Shared cartridges in `skills/shared/`, agent-specific in `rooms/{agent}/cartridges/`.

CLI: `bun src/cli.ts /cartridge <name> [--agent <agent>]`

### Maturation Ledger

Agents progress through three profiles:
- **gentle** — new/accumulating agents (default)
- **standard** — established agents with consistent crossing
- **full** — mature agents with peer review

Tracked in `rooms/{agent}/MATURATION.md`. Milestones auto-complete based on session count and peer reviews. Profile advancement is automatic when all milestones are met.

### Platform Sovereignty

Three adapter types for agent migration:
- **CLIAdapter** — original CLI platform (Claude Code, Codex, Gemini CLI, Qwen CLI)
- **CustomAdapter** — custom runtime (OpenClaw, Forge)
- **NativeAdapter** — ANIMA-native runtime

Migration includes probation period with rollback support.

### Cross-Agent Reflection

Agents write observations about each other via `POST /colony/reflect`. Reflections are stored in the target agent's staging/beams/ for gate review. Peer witnessing replaces scalar self-scoring.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with agent list |
| `/status` | GET | Detailed agent status |
| `/colony` | GET | Colony manifest with maturation status per agent |
| `/colony/reflect` | POST | Cross-agent reflection (from, about, content) |
| `/dream` | POST | Lucid dream trigger (agent, prompt) |
| `/webhook/telegram` | POST | Telegram webhook |

## Documentation Index

- [CLI Reference](CLI_REFERENCE.md) — all CLI commands with examples
- [Room Configuration](ROOM_CONFIG.md) — config.yaml reference
- [Provider Setup](PROVIDER_SETUP.md) — setting up LLM providers
- [Agent Town UI](AGENT_TOWN_UI.md) — Web UI guide
- [Meeting System](MEETING_GUIDE.md) — agent-to-agent communication
- [Server Operations](SERVER_OPS.md) — deployment, monitoring, troubleshooting
- [Architecture](ARCHITECTURE.md) — detailed architecture overview
