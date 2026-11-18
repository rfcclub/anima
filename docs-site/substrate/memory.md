# Memory System

ANIMA has three kinds of memory storage. They're easy to confuse, so this page separates them.

| What | Purpose | Where |
|------|---------|-------|
| [Event log](#event-log) | Every session event (messages, tool calls, cartridge events) | `~/.anima/sessions.db`, plus JSONL copies |
| [Recall adapter](#recall-adapters) | Per-turn recall for the prompt | Depends on `memory.type` |
| [Cross-session store](#cross-session-store) | Long-lived memories (`AgentMemoryStore`) | Per agent |

## Event log

`SqliteStore` (`src/memory/sqlite-store.ts`) writes events to the `events` table in `$ANIMA_SESSIONS_DB`, default `~/.anima/sessions.db`.

The server channels (HTTP, Telegram, mesh) use `DualStore`, which writes each event to SQLite and also appends it to `$ANIMA_HOME/rooms/<agent>/sessions/<YYYY-MM-DD>.jsonl` (default `~/.anima/...`). The legacy `JsonlStore` (`src/memory/jsonl-store.ts`) uses the same JSONL layout and is still used by the Web UI.

The CLI uses `SqliteStore` only.

## Recall adapters

`AgentLoader.loadMemoryAdapter()` (`src/agents/loader.ts`) picks the adapter from `memory.type`:

| `memory.type` | Adapter |
|---------------|---------|
| `module` (default) | The default export of `memory.adapterModule` (default `memory-adapter.js`) in the room folder. If it's missing or invalid, `NullMemoryAdapter`, which returns nothing |
| `custom` | `CustomMemoryAdapter`, running `memory.entityScript` (with `substrateDir`, `recallMode`, `fallback`). Without `entityScript`, `NullMemoryAdapter` |
| `shared` | `SharedMemoryAdapter` on `<rooms>/_shared/memory.db` |

Each turn, `AgentSession` calls `adapter.recall(message, { topK, mode, recentDays, ... })` with `memory.topK` (default 5), `memory.recallMode` (`normal`, `semantic` or `neural`) and `memory.recentDays`. Results are added as a `[Memory Context]` block. A recall error is logged as `memory_recall_error` and the turn continues.

The same adapter serves [per-cartridge retrieval](./retrieval.md).

### Bootstrap

With `memory.crossSessionBootstrap: true`, the loader calls the adapter's `bootstrap()` (if it has one) when the agent is loaded and adds the entries to the prompt.

## Cross-session store

`store-registry` (`src/memory/store-registry.ts`) gives some agents an `AgentMemoryStore`:

| Agent | Store |
|-------|-------|
| `abel` | `AbelMemBunAdapter` |
| `bruno` | `BrunoEntityAdapter` |
| Others with `memory.type: shared` or `memory.crossSessionBootstrap: true` | `AnimaEntityStore` at `~/.anima/agents/<agent>/memory.db` |
| Others | None |

This is the store behind `remember`/`recall` memory tools, end-of-session summaries and lucid dream notes. Writes are limited to the active cartridges' `memory.write_scopes`. See [Memory Contract](../api/memory-contract.md).

## Scopes

Every memory entry has one `MemoryScope`:

| Scope | Scope | Scope |
|-------|-------|-------|
| `episode` | `fact` | `observation` |
| `scent` | `preference` | `private` |
| `scar` | `decision` | `project` |
| `heartwood` | `growth_ring` | `canopy` |
| `identity` | `narrative` | `behavior` |
| `skill` | `relationship` | |

`identity`, `private` and `heartwood` can't be granted to cartridges as write scopes.

## Config summary

```yaml
memory:
  type: module              # module | custom | shared
  adapterModule: memory-adapter.js
  entityScript: ./entity.ts # for type: custom
  substrateDir: ./substrate
  recallMode: normal        # normal | semantic | neural
  recentDays: 7
  topK: 5
  fallback: true
  crossSessionBootstrap: false
  recallScope: full         # full | pin | none
```
