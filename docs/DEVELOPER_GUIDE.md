# ANIMA Colony Developer Guide

## 1. Architecture Overview

ANIMA is a multi-agent runtime organized as a colony. There are three tiers:

- **ANIMA Runtime** (`src/server.ts`) -- life support. Starts the HTTP server, initializes the Agora event bus, detects available Legio workers, and wires up session lifecycle, dreams, and cross-session memory.
- **Agora** (`src/agora/`) -- central event bus and Legio dispatcher. Familia agents emit events (`task_complete`, `task_failed`, `task_blocked`, `agent_offline`) and Agora routes them. `ANIMA.requestLegio()` dispatches work to Legio workers.
- **Legio** -- disposable execution layer. Three types detected at startup via `which`: `codex` (heavy/complex), `qwen` (cheap/parallel), `gemini` (analysis/review). Unlimited instances, assigned by cost and trust.
- **Familia** -- core company structure. Agents with distinct identities, memory backends, and decision rights. Optionally organized into companies (see section 6).

The colony topology is defined in `data/colony.json` (v2 format with `companies`, `pipeline`, `qualityGates`, `legioRouting`).

## 2. Agent Anatomy

Every agent lives in a room directory at `~/.anima/rooms/<name>/`. The substrate (the agent's full body of files) lives in a separate path and is mounted via symlink.

A typical room:

```
~/.anima/rooms/bruno/
  config.yaml          # Room configuration (YAML)
  AGENTS.md             # Gene -- bootloader / operating instructions
  SOUL.md -> ../mount/SOUL.md   # Identity (symlinked from substrate)
  MEMORY.md             # Curated experience (session-context file)
  mount -> ~/substrate/myagent/   # Symlink to full substrate
  sessions/             # Per-session JSONL event logs
  staging/              # Crossing ledger, beam entries (dream output)
  memory/               # Agent-specific memory files
  trust.json            # Trust scores per domain
```

The three pillar files in `config.yaml > boot`:

| Field | File | Purpose |
|-------|------|---------|
| `gene` | `AGENTS.md` | Bootloader -- how the agent operates, its instructions |
| `soul` | `SOUL.md` | Identity -- who the agent is, its nature |
| `sessionContext` | e.g. `MEMORY.md` | Curated experience -- what it remembers across sessions |

## 3. Memory System

### Contract Interface

All memory backends implement `AgentMemoryStore` from `src/memory/contract.ts`:

```typescript
interface AgentMemoryStore {
  remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry>;
  recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]>;
  bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]>;
}
```

`AgentMemoryEntry` carries: `id`, `content`, `scope` (episode/fact/observation/scent/preference/decision/etc.), `tags`, `confidence`, `source`, `createdAt`.

### Custom Backends

| Agent | Backend | Location |
|-------|---------|----------|
| **Bruno** | `BrunoEntityAdapter` | Shells out to an external `recall.mjs` script for neural-graph recall and an `inbox_writer.py` script for writes (paths are adapter options) |
| **2B** | `AbelMemAdapter` | HTTP service: wraps `AbelMemService` at the configured abel-mem endpoint |

### Standard Backend

All other colony agents use `AnimaEntityStore` (`src/memory/anima-entity-store.ts`), a shared SQLite database at `~/.anima/_shared/memory-contract.db`. It provides:

- FTS5 full-text search on `neurons` table
- Gemini embedding vectors for semantic search (when `GEMINI_API_KEY` is set)
- Reciprocal Rank Fusion (RRF) hybrid search combining FTS + vector scores
- Bootstrap by recency + access frequency

### Adding a New Memory Backend

1. Implement `AgentMemoryStore` (remember, recall, bootstrap)
2. Register in `src/memory/store-registry.ts` in the factory function `createAgentMemoryStore()`
3. Enable with `memory.crossSessionBootstrap: true` in the agent's `config.yaml`

### Store Registry

`src/memory/store-registry.ts` maps agent names to backends. Agents not explicitly listed fall through to `AnimaEntityStore`. The `MemoryHealthRegistry` singleton (`src/memory/health-registry.ts`) tracks all active stores for health checks.

## 4. Room System

Rooms live at `~/.anima/rooms/<name>/`. The `ANIMA_ROOMS_DIR` env var overrides the path. A room is valid if it has a `config.yaml`.

### Boot Sequence

When `SessionLifecycle.onOpen()` runs for an agent:

1. **AgentLoader.load()** reads config.yaml, resolves boot files (gene, soul, sessionContext, additional, extraActions)
2. **Gene** content is read from the boot path (typically `AGENTS.md`)
3. **Soul** content is read if configured
4. **Session context files** are read and formatted into the system prompt
5. **Extra actions** (bash commands) are executed with `ANIMA_ROOM_DIR` set
6. **Memory bootstrap** runs if `memory.crossSessionBootstrap` is enabled
7. **Crossing ledger** is loaded for continuity context
8. **Dream beams** from `staging/beams/` are loaded (last 7 files)
9. **Entity recall** runs against the memory adapter
10. **Trust scores** are initialized

### Symlink Pattern

The `mount` symlink points to the agent's substrate directory (e.g., `~/substrate/myagent/`). Boot file paths in `config.yaml` may use relative paths (resolved against the room dir), absolute paths, or `~/` paths (resolved against the home directory). A path guard prevents escape outside the room.

The `_shared` room (`~/.anima/rooms/_shared/`) holds shared resources: `trajectory-boot.md`, `memory-contract.db`, and the shared memory adapter. The `_meeting` room holds the meeting daemon state.

## 5. Session Lifecycle

A complete session follows this flow:

```
AgentLoader.load(agentId)
  |
  v
buildSystemPrompt(loadedAgent)
  - Soul, Gene, SessionContext, AdditionalContext
  - ExtraAction results, Bootstrap memory
  - Identity anchor injected at recency boundary
  - Cartridge injection (shared + agent-scoped)
  |
  v
Recall (memory adapter)
  - Per-turn recall before provider call
  - Injected as [Memory Context] section
  |
  v
Provider query (tool loop)
  - Up to 64 iterations for tool calls
  - Tool policy enforced per agent config
  - MCP tools supported alongside built-in tools
  |
  v
Store response (memory adapter)
  - Gated by evaluation pipeline (if configured)
  |
  v
Session end (onClose)
  - LightNap: dream processing from session events
  - Crossing write: continuity ledger update
  - Daily memory write: session-close entry
  |
  v
Cross-session bootstrap (on next session)
  - Session summary written via Compactor
  - Injected as [Bootstrap Memory] at next session start
```

The `AgentSession.run()` method in `src/agents/session.ts` orchestrates the provider query, tool loop, memory store, and thread context. `SessionLifecycle` in `src/session/lifecycle.ts` wraps it with the boot sequence, dream processing, and crossing ledger.

## 6. Company Structure

The colony.json v2 format can group agents into companies. Each entry under `companies` has:

- `name` and `purpose`
- `lead` -- the lead agent, with its title and decision rights
- `pipeline` -- the ordered stages of work
- `qualityGates` (optional) -- named gates with an approver and a rule
- `legioRouting` -- which Legio worker handles which task type
- `members[]` -- the member agents and their roles

Agents not assigned to a company serve as reserve capacity.

## 7. How to Add a New Agent

1. **Create substrate**: Place the agent's body of files at `~/substrate/<name>/`
   - At minimum: `SOUL.md` (identity) and `AGENTS.md` (instructions)

2. **Create room**:
   ```
   mkdir -p ~/.anima/rooms/<name>/{sessions,staging,memory}
   ```

3. **Symlink substrate**:
   ```
   ln -s ~/substrate/<name> ~/.anima/rooms/<name>/mount
   ln -s ~/substrate/<name>/SOUL.md ~/.anima/rooms/<name>/SOUL.md
   ln -s ~/substrate/<name>/AGENTS.md ~/.anima/rooms/<name>/AGENTS.md
   ```

4. **Write config.yaml**: Minimum viable config:
   ```yaml
   identity:
     name: <name>
     label: "Display Name"
   provider:
     type: wafer-ai
     model: GLM-5.1
   boot:
     gene: AGENTS.md
     soul: SOUL.md
     sessionContext:
       - mount/MEMORY.md
   policy:
     allowedRoots:
       - /home/user/.anima/rooms/<name>
       - /home/user/substrate/<name>
     allowedTools:
       - read
       - grep
       - write
       - edit
       - bash
   session:
     defaultMode: plan
     autoModeOptIn: false
     idleTimeoutMs: 300000
   ```

5. **Register in colony.json**: Add an entry under `agents[]` and optionally assign to a company's `members[]`.

6. **Enable memory**: Set `memory.crossSessionBootstrap: true` and optionally `memory.type: shared` for the standard SQLite backend.

## 8. How to Run

```bash
# Install dependencies
bun install

# Start the server
bun run src/server.ts

# With Telegram gateway
export TELEGRAM_BOT_TOKEN="..."
bun run src/server.ts
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3700` | HTTP server port |
| `ANIMA_ROOMS_DIR` | `~/.anima/rooms` | Override rooms directory |
| `ANIMA_STATE_DIR` | `./state` | Session database directory |
| `ANIMA_UI_ENABLED` | (unset) | Set to `"true"` to enable Agent Town UI |
| `ANIMA_UI_PORT` | `3000` | UI server port |
| `GEMINI_API_KEY` | (unset) | Required for embedding vectors in AnimaEntityStore |
| `TELEGRAM_BOT_TOKEN` | (unset) | Telegram gateway bot token |
| `ANIMA_2B_MEM_URL` | (unset) | 2B memory service endpoint |
| `ANIMA_2B_MEM_TOKEN` | (unset) | 2B memory service auth token |

### UI

When `ANIMA_UI_ENABLED=true`, the Agent Town UI is served at `http://<host>:3000/`. Individual agent stages are at `/stage/<agentId>` (e.g. `/stage/bruno`). The stage UI provides a chat interface with typewriter animation, conversation log, and choice panels.

### Colony API

- `GET /health` -- Server status + agent list
- `GET /status` -- Per-agent mount status and last session
- `GET /api/colony` -- Full colony state with trust scores
- `GET /api/agent/<id>` -- Single agent details
- `GET /colony` -- Colony with maturation ledger
- `POST /dream` -- Trigger a lucid dream for an agent
- `POST /colony/reflect` -- Cross-agent reflection (writes a beam)

## 9. Testing

Tests live in `__tests__/` and `test/`. Run with:

```bash
bun test
```

### Test Locations

| Directory | Coverage |
|-----------|----------|
| `__tests__/memory/` | Memory contract, boot protocol, store registry, health registry, AnimaEntityStore |
| `__tests__/config/` | Config types and validation |
| `__tests__/session/` | Cross-session memory lifecycle |
| `test/` | Integration tests: A2A CLI, drift invariants, cartridge loader, session store, identity invariants |

### Testing Patterns

- **RED phase tests** follow TDD: write the test first, then implement
- **Mock stores** use `createMockStore()` pattern from `__tests__/memory/boot.test.ts`
- **Adapter tests** inject mock `execFn` to avoid shelling out (see `BrunoEntityAdapter` for the pattern)
- **Room fixtures** are new directories under `rooms/` with minimal `config.yaml`

### Required Testing Before Changes

- Memory contract changes: update `__tests__/memory/contract.test.ts`
- Config schema changes: update `__tests__/config/types.test.ts`
- Cross-session memory: update `__tests__/session/cross-session-memory.test.ts`
- All tests must pass before commit (`bun test`).
