# ANIMA Architecture

## System Overview

ANIMA is a multi-agent runtime that hosts persistent AI agents, each with independent identity, memory, and tool access. It runs as a Bun HTTP server with an optional Web UI.

## Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│                   Channels                          │
│   CLI (src/cli.ts)  │  HTTP (src/server.ts)         │
│   Telegram          │  Web UI (src/ui/)             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  Agent Session                       │
│   src/agents/session.ts                              │
│   - Mode enforcement (plan/edit/auto)                │
│   - Tool gating (canUseTool)                         │
│   - Auto-guard wrappers (audit + notification)       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                 Provider Router                      │
│   src/providers/router.ts                            │
│   - Mode-based routing (task mode → model)           │
│   - Fallback chain on failure                        │
│   - Cached provider instances                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Providers                          │
│   Claude (SDK) │ Gemini │ OpenAI-compatible          │
│   src/providers/anthropic.ts                         │
│   src/providers/gemini.ts                            │
│   src/providers/openai-compat.ts                     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                    Memory                            │
│   src/memory/jsonl-store.ts                          │
│   - One JSONL file per agent per day                 │
│   - Append-only with recovery on corruption          │
│   - Compaction via src/session/compactor.ts          │
└─────────────────────────────────────────────────────┘
```

## Module Map

| Directory | Purpose |
|-----------|---------|
| `src/agents/` | Agent lifecycle: loading, system prompt building, session execution |
| `src/config/` | Room configuration types, YAML loading, validation |
| `src/meeting/` | Meeting room (file-based agent-to-agent communication) and mail daemon |
| `src/memory/` | JSONL event store — append-only, per-agent, per-day |
| `src/providers/` | Provider interface, Claude/Gemini/OpenAI-compat implementations, registry, mode router |
| `src/session/` | Session state, compaction, session manager |
| `src/ui/` | Agent Town Web UI — React SPA with Bun HTML imports |

## Data Flow

### CLI Query Flow

```
bun cli talk bruno "hello"
  → CLI parses args (src/cli.ts)
  → AgentLoader loads room config + mounts substrate (src/agents/loader.ts)
  → ModeRouter resolves provider chain (src/providers/router.ts)
  → AgentSession builds system prompt, enforces mode (src/agents/session.ts)
  → Provider.query() sends to LLM (src/providers/anthropic.ts or gemini.ts)
  → Response logged to JSONL store (src/memory/jsonl-store.ts)
  → Response streamed to terminal
```

### Server Query Flow

```
GET /status
  → handleRequest() (src/server.ts)
  → listRoomNames() scans rooms/ directory
  → readAgentStatus() reads config.yaml per room
  → Returns JSON with all agent statuses
```

### Meeting Flow

```
bun cli meet bruno eli --turns=3
  → CLI creates MeetingRoom (src/meeting/room.ts)
  → For each turn:
    → Writes A2A message to rooms/_meeting/<topic>/<date>.md
    → Each agent reads, responds via provider
    → Transcript written back
  → Meeting file is git-trackable
```

## Configuration

Each agent room has a `config.yaml`:

```yaml
identity:
  name: bruno
  label: Bruno

provider:
  type: claude        # claude | gemini | qwen | codex | router
  model: claude-sonnet-4-6  # optional override
  modeMap:            # optional per-task-mode routing
    programming:
      - claude@claude-sonnet-4-6

policy:
  allowedRoots:
    - /home/user/papers
  readOnlyRoots:
    - /home/user/substrate
  allowedTools:       # for auto mode
    - read
    - grep
  deniedPatterns:
    - rm -rf

session:
  defaultMode: plan   # plan | edit | auto
  autoModeOptIn: false
  compactThreshold: 60000

boot:
  soul: SOUL.md       # canonical identity file
  additional:
    - PREFACE.md
```

## Rooms Directory

```
rooms/
├── _meeting/           # Meeting transcripts (git-tracked)
│   └── <topic>/
│       └── <date>.md
├── bruno/
│   ├── config.yaml
│   ├── mount/          # symlink → agent substrate
│   └── sessions/
│       └── 2026-05-17.jsonl
├── cleo/
├── eli/
├── sam/
├── milo/
├── lena/
└── ivan/
```
