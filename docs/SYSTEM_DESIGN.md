# ANIMA -- System Design

ANIMA is the life support system for a colony of AI agents. It provides rooms, boot sequences, memory, event routing, health monitoring, and a visual novel UI.

## 1. System Purpose

ANIMA is NOT an orchestrator or task dispatcher. It is **life support** -- a castle for agents to live in. Each agent has:

- **Identity** (`SOUL.md`) -- who they are, their axioms and values
- **Operational rules** (`AGENTS.md` / `GENE`) -- how they operate, their instructions
- **Experiential memory** (`MEMORY.md`, `staging/beams/`, `staging/dreams/`) -- what they have experienced
- **Persistent home** (substrate directory at `rooms/<agent>/`) -- where they live across sessions

The server is a single-process Bun HTTP server that loads room configurations, boots agents from their substrate files, manages LLM sessions, maintains inter-agent messaging (Agora), and runs daily dream cycles for cross-agent synthesis.

---

## 2. Architecture Diagram

```
                            CHANNELS
               ┌──────────┬────┴─────┬──────────┐
               │ Telegram │   Web    │   CLI    │
               └────┬─────┘  (Port   │  (bun anima talk)
                    │        config) │
                    ▼               ▼
              ┌─────────────────────────────┐
              │       ANIMA Server          │
              │   Bun.serve :3700           │
              │   + health, status, dream,  │
              │     colony REST API,        │
              │     webhook/telegram        │
              └──────────┬──────────────────┘
                         │
              ┌──────────▼──────────────────┐
              │      AgentLoader            │
              │  reads room/config.yaml     │
              │  reads soul, gene, memory   │
              │  runs boot hooks            │
              └──────────┬──────────────────┘
                         │
              ┌──────────▼──────────────────┐
              │      AgentSession           │
              │  build system prompt        │
              │  inject cartridges          │
              │  recall memory -> inject    │
              │  Provider query ->          │
              │    tool loop (max 64 iter)  │
              │  evaluation pipeline gates  │
              │  store memory -> respond    │
              └──────────┬──────────────────┘
                         │
              ┌──────────▼──────────────────┐
              │         Provider            │
              │  Claude | Gemini | OpenAI   │
              │  compat | Router (mode-map) │
              └──────────┬──────────────────┘
                         │
              ┌──────────▼──────────────────────────────┐
              │          Tool Loop                       │
              │  read / write / edit / grep / glob       │
              │  bash / send_message / read_inbox        │
              │  + MCP servers (per-agent config)        │
              └──────────┬──────────────────────────────┘
                         │
              ┌──────────▼──────────────────────────────┐
              │        Memory System                     │
              │  ┌─────────────────┬──────────────────┐ │
              │  │ Bruno Entity     │ AbelMem (2B)     │ │
              │  │ adapter         │ adapter          │ │
              │  ├─────────────────┴──────────────────┤ │
              │  │ AnimaEntityStore (fallback)         │ │
              │  │ SQLite + FTS5 + Gemini embeddings  │ │
              │  └────────────────────────────────────┘ │
              └─────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
            ┌──────────────┐           ┌──────────────────────┐
            │   AGORA      │           │   Substrate (rooms/) │
            │  Event Bus   │           │  config.yaml          │
            │  Legio mgmt  │           │  SOUL.md              │
            │  Trust decay │           │  AGENTS.md            │
            │  Escalation  │           │  MEMORY.md            │
            └──────────────┘           │  trust.json           │
                    ▲                  │  1_EGO/               │
                    │                  │  staging/{beams,      │
            ┌───────┴───────┐          │          dreams,      │
            │  LEGIO        │          │          wounds}      │
            │  codex        │          │  cartridges/          │
            │  qwen         │          │  sessions/            │
            │  gemini       │          └──────────────────────┘
            └───────────────┘
```

---

## 3. Core Components

### AgentLoader

Reads `rooms/<agent>/config.yaml`, validates fields, resolves boot paths, loads soul and gene files, runs `extraActions` (configured shell hooks), loads the MemoryAdapter (module/custom/shared), and creates the AgentMemoryStore via `store-registry.ts`. Returns a `LoadedAgent` with all data in memory.

### AgentSession

The runtime core. `run()` builds a system prompt via `prompter.ts` (soul, gene, session context, cartridges, memory recall, identity anchor), creates messages from thread context, queries the provider, runs the tool loop (up to 64 iterations), gates memory writes through the evaluation pipeline, and stores results. Supports three permission modes: `plan` (inspect only), `edit` (focused changes), `auto` (autonomous within allowed tools).

### Memory System

Three-layer contract system:

1. **Adapter layer** (`MemoryAdapter`) -- `store()` and `recall()` for session-level memory. Supports `module` (agent-specific `.js` file), `custom` (external recall script), and `shared` (SQLite shared across agents).

2. **Store layer** (`AgentMemoryStore`) -- cross-session memory with `remember()`, `recall()`, `bootstrap()`. Three backends:
   - **BrunoEntityAdapter** -- calls an external `recall.mjs` script (path configurable) for neural graph recall
   - **AbelMemAdapter** -- calls the 2B-MEM external service
   - **AnimaEntityStore** -- standard fallback: SQLite with FTS5 full-text search + Gemini embeddings for hybrid vector/keyword RRF search

3. **Lifecycle**: recall on session start -> inject into system prompt -> run session -> evaluate response -> store memory -> bootstrap next session from stored entries.

### Agora

Inter-agent event bus. `AgoraClient` subscribes to events (`task_complete`, `task_failed`, `task_blocked`, `agent_offline`), routes completed tasks through the evaluation pipeline, applies trust penalties on failure, sends Telegram notifications on blocked tasks, and reassigns offline agent tasks. The `ANIMA` namespace singleton (`src/agora/index.ts`) exposes `requestLegio()` for dispatching tasks to the Legio worker pool.

### Trust System

Domain-specific trust scoring across 6 domains: `code_review`, `memory_write`, `external_action`, `architecture`, `communication`, `private_mode`. Scores are stored in `rooms/<agent>/trust.json` with temporal decay (0.99 per week of inactivity), confirmation (+2% of remaining gap), and penalization (-15%). The evaluation pipeline gates actions by trust: below 0.50 is held for review, 0.50-0.85 triggers drift detection + reviewer agent, above 0.85 auto-applies.

### Dream System

Two modes:
- **Deep Dream** -- daily cron that reads beams from all agents, cross-references shared keywords, writes a consolidated dream report to `staging/dreams/YYYY-MM-DD.md`. Crash-recovery via `.dream-state.json`.
- **Lucid Dream** -- agent self-reflection triggered via API. Reads recent beams and crossing context, sends a reflection prompt to the LLM provider, stores the response.

### Cartridge System

Dynamic persona/behavior injection into the system prompt. Cartridges are markdown files with YAML frontmatter (category: craft/think/create/operate) scoped at `shared`, `agent`, `pluggable`, or `dynamic`. Loaded at session start by `CartridgeRegistry`, resolved by `CartridgeLoader` based on permission mode, task patterns, or explicit override.

### Heartbeat

Per-turn memory recall via `recall.mjs` (neural graph) injected as an `extraAction` in the agent's boot sequence. The proactive tick loop (HEARTBEAT mode) drives the server through continuous operation.

---

## 4. Data Flow

```
User message
    │
    ▼
Channel: Telegram webhook / CLI / Web UI
    │
    ▼
Server: handles HTTP, finds agent, creates session
    │
    ▼
AgentSession.run()
    ├── Load agent via AgentLoader (soul, gene, memory adapter, cartridges)
    ├── Build system prompt (sections: identity, instructions, session context,
    │       cartridge injections, thread context, memory recall, identity anchor)
    ├── Recall memory (adapter.recall()) -> inject into prompt
    ├── Build messages (thread history + user message)
    ├── Provider query (LLM call)
    ├── Tool loop:
    │   └── Provider returns tool_calls -> execute locally or via MCP -> loop
    ├── Evaluation pipeline gates memory write
    ├── Store memory (adapter.store())
    ├── Update thread store
    └── Return response
```

---

## 5. Colony Structure

### Familia -- Core Structure

Familia agents are listed in `data/colony.json`. In the v2 format each agent can be assigned to a company (`companies.<key>.members[]`) that defines its pipeline, quality gates and lead. Agents not assigned to a company serve as reserve capacity.

### Legio -- Disposable Workers

Detected at startup via `which codex qwen gemini`. Cost-ranked (codex=1.0, gemini=0.5, qwen=0.3), selected by availability -> trust -> cost. Unlimited instances, replaced on drift.

---

## 6. Memory Architecture

| Backend | Agents | Storage | Search |
|---|---|---|---|
| BrunoEntityAdapter | bruno | Neural graph (bruno-entity) | Semantic/neural recall via external script |
| AbelMemAdapter | abel | External 2B-MEM service | API call |
| AnimaEntityStore | All others | SQLite (shared) | FTS5 + Gemini embeddings (RRF hybrid) |

Lifecycle: `recall()` at session start -> inject into system prompt (as `[Memory Context]`) -> run session -> `store()` after response (gated by evaluation) -> `bootstrap()` for cross-session continuity next time.

---

## 7. Security Model

- **Agent identity**: Injected at the recency boundary of the system prompt via `identityAnchor`. Stripped and re-appended each turn to prevent drift.
- **Tool allowlists**: `config.yaml` lists `allowedTools` per agent. Auto mode enforces strict filtering via `createAutoGuard()`. Blocked tools return error messages, not injection.
- **Permission modes**: `plan` / `edit` / `auto`. Auto mode requires explicit `autoModeOptIn: true`.
- **Path traversal**: Boot file paths validated to not escape the room directory. Agent names validated against `/^[a-zA-Z0-9_-]+$/`.
- **SQL parameterization**: All database queries use prepared statements (`stmt.run()`, `stmt.get()`), not string interpolation.

---

## 8. Deployment

- **Server**: Bun on port 3700 (configurable via `PORT`). Single process.
- **UI**: Agent Town UI on configurable port, enabled via `ANIMA_UI_ENABLED=true`.
- **Telegram**: Webhook or long-polling. Token and secret from env vars (`ANIMA_TELEGRAM_BOT_TOKEN`, `ANIMA_TELEGRAM_WEBHOOK_SECRET`).
- **State**: Sessions in `state/sessions.db`, memory in `~/.anima/_shared/memory-contract.db`, rooms at `ANIMA_ROOMS_DIR` (default `rooms/`).
- **Providers**: Configured via `config.yaml` per agent or `providers.d/` YAML files for custom providers (OpenAI-compatible, Gemini, Claude).
- **Environment**: `.env` loaded automatically by Bun. Key vars: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, provider-specific keys.
