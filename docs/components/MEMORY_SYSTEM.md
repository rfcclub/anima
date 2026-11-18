# Memory System — Component Design

## 1. Overview

The ANIMA memory system provides a uniform cross-session memory interface for all
colony agents (Bruno, 2B, and any standard colony agent). Agents that opt in
via `config.memory.crossSessionBootstrap` get a persistent memory backend that
survives session boundaries, enabling recall of past interactions, observations,
facts, and growth rings.

There are two distinct memory layers:

1. **Session Memory** (`MemoryAdapter`) — used during a live session for
   recall/store of the current conversation context.
2. **Cross-Session Memory** (`AgentMemoryStore`) — persists across sessions
   via the memory contract interface, providing boot-time context injection.

This document covers the cross-session memory layer.

---

## 2. Contract Interface Design

### 2.1 AgentMemoryEntry

Every memory entry flowing through the system conforms to this shape:

| Field        | Type                  | Description                                       |
|-------------|-----------------------|---------------------------------------------------|
| `id`        | `string`              | Unique identifier (generated at store time)       |
| `content`   | `string`              | The memory payload text                           |
| `scope`     | `MemoryScope`         | Semantic category of the entry                    |
| `tags`      | `string[]`            | Arbitrary labels for filtering                    |
| `confidence`| `number`              | 0–1 confidence score for the entry                |
| `source`    | `string`              | Origin agent name                                 |
| `createdAt` | `string` (ISO 8601)    | When the entry was created                        |
| `updatedAt` | `string` (ISO 8601)    | When the entry was last updated (optional)        |
| `metadata`  | `Record<string, unknown>` | Arbitrary structured metadata (optional)       |

### 2.2 MemoryScope

The union of all memory scopes across the colony:

```
episode | fact | observation | scent | preference | private
| scar | decision | project | heartwood | growth_ring
| canopy | identity
```

Each agent uses a subset relevant to its role. The scope acts as a first-class
filter dimension during recall queries.

### 2.3 AgentMemoryStore Interface

All backends implement the same three-method contract:

```typescript
interface AgentMemoryStore {
  /** Persist a new entry. Returns the fully populated entry with id and createdAt. */
  remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry>;

  /** Query for relevant entries. Supports scope/tag/confidence filtering. */
  recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]>;

  /** Load startup context for a new session. Entries are injected into the system prompt. */
  bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]>;
}
```

### 2.4 AgentBootHooks (Optional)

Per-agent lifecycle hooks that wire into the boot sequence defined in
`src/memory/boot.ts`:

```typescript
interface AgentBootHooks {
  beforeSoulRead?: () => Promise<void>;
  afterSoulRead?: () => Promise<void>;
  afterMemoryIndexRead?: () => Promise<void>;
  afterRecentRead?: () => Promise<void>;
  afterBootstrap?: (entries: AgentMemoryEntry[]) => Promise<AgentMemoryEntry[]>;
}
```

The standard boot sequence runs:
```
beforeSoulRead → afterSoulRead → bootstrap() → afterBootstrap
```

Each step is optional; undefined hooks are skipped.

---

## 3. Three Backends

### 3.1 BrunoEntityAdapter (Neural Graph)

**Source:** `src/memory/bruno-entity-adapter.ts`
**Agent:** Bruno
**Backing store:** bruno-entity neural graph (external project; script paths are configurable adapter options)

The adapter shells out to two external scripts:

- **recall()** — runs `node <entity-root>/scripts/recall.mjs --query <Q> --topK <N>`
  and parses the JSON response containing neurons with activation scores.
- **remember()** — runs `python3 <substrate-root>/5_ENGINE/inbox_writer.py --type OBSERVATION ...`
  to write an observation into the agent's inbox for later consolidation.
- **bootstrap()** — runs recall with a broad query ("recent context session work") to
  pull the most recently activated neurons for session boot.

Key design decisions:

- **Shell-out architecture**: The external scripts are standalone and versioned
  independently. The adapter is a thin bridge.
- **Injectable exec**: The `execFn` is pluggable for testability — tests can inject
  a mock without spawning actual processes.
- **Argument injection protection**: Tag values starting with `-` are rejected to
  prevent argument injection into the Python script.
- **End-of-options delimiter**: Uses `--` before the `--tags` flag so argparse treats
  remaining tokens as positional, never as flags.

### 3.2 AbelMemAdapter (HTTP Service)

**Source:** `src/memory/abel-mem-adapter.ts`
**Service:** `src/services/abel-mem.ts`
**Agent:** 2B
**Backing store:** External HTTP service (abel-mem engine at port 3579)

The adapter wraps `AbelMemService`, which makes HTTP calls to the abel-mem engine.

Key design decisions:

- **Bearer token auth**: All requests carry a shared Bearer token managed by
  `getBearerToken()`. The token can be rotated.
- **Graceful degradation**: If the engine is unreachable, the service caches
  `engineAvailable = false` and returns empty results or error statuses.
- **Circuit-breaker pattern**: Failed health checks or API calls flip the
  availability flag, preventing repeated attempts against a down service.
- **Timeouts**: Each HTTP call has a timeout (5–30s depending on operation)
  to avoid hanging.

### 3.3 AnimaEntityStore (SQLite)

**Source:** `src/memory/anima-entity-store.ts`
**Backing store:** SQLite database at `~/.anima/_shared/memory-contract.db`
**Used by:** All standard colony agents (fallback)

The most full-featured backend, implementing a full neuron-synapse graph with
hybrid search:

**Schema:**
- `neurons` — core entity table with id, type, content, metadata, scope, tags,
  source, confidence, access_count, timestamps
- `synapses` — directed weighted edges between neurons (source → target)
- `neurons_fts` — FTS5 full-text search virtual table
- `embeddings` — binary vector storage for semantic search

**Search — RRF Hybrid:**

1. **FTS5 keyword search** over the `content` column
2. **Vector similarity search** using Gemini embedding-2 model (when
   `GEMINI_API_KEY` is configured)
3. **Reciprocal Rank Fusion (RRF)** combines both result sets with `k=60`

Entry points that are NOT part of the contract but exposed for direct use:
- `addNeuron()` / `getNeuron()` / `updateNeuron()` / `deleteNeuron()` / `listNeurons()`
- `addSynapse()` / `getSynapses()` / `deleteSynapse()`
- `search()` — direct hybrid search access
- Embedding generation and storage

Key design decisions:

- **Graceful embedding fallback**: If no GEMINI_API_KEY is set or the embedding
  call fails, search degrades to FTS-only.
- **Fire-and-forget embeddings**: Embedding generation after remember() never
  blocks the response.
- **Prepared statement cache**: SQL statements are compiled once and cached in
  a Map keyed by SQL text.
- **WAL mode**: SQLite uses WAL journal for concurrent read performance.
- **idempotent initialization**: `CREATE TABLE IF NOT EXISTS` with migration
  ALTER TABLE attempts for scope/tags/source/confidence columns.

---

## 4. Store Registry Pattern

**Source:** `src/memory/store-registry.ts`

The registry is a factory function that routes agent names to their appropriate
backend:

```
createAgentMemoryStore(config, roomDir)
  │
  ├─ agentName === "abel"    → AbelMemAdapter
  ├─ agentName === "bruno"  → BrunoEntityAdapter
  └─ else                  → AnimaEntityStore (shared SQLite)
```

Only agents with `config.memory.crossSessionBootstrap === true` get a store.
All others return `undefined` (no cross-session memory).

Agent classification sets:
- `ABEL_MEM_AGENTS = new Set(["abel"])`
- `BRUNO_ENTITY_AGENTS = new Set(["bruno"])`

---

## 5. Cross-Session Memory Lifecycle

The lifecycle is orchestrated across several modules.

### 5.1 Session End: Summary + Persist

**Source:** `src/session/cross-session-memory.ts`

When a session ends (`SessionManager.newSession()` or `SessionManager.closeSession()`):

1. The `onEnd` hook fires, calling `buildSessionEndHandler()`
2. All turns from the session are fetched
3. A `Compactor` generates a natural language summary
4. The summary is persisted via `memoryStore.remember()`

```typescript
buildSessionEndHandler(memoryStore, provider, sessionStore, model)
  → (sessionId, agentName) => {
      turns = sessionStore.getTurns(sessionId)
      summary = compactor.summarize(turns)
      memoryStore.remember({
        content: summary.summary,
        scope: "observation",
        tags: ["session-summary", `session-${sessionId}`],
        ...
      })
    }
```

### 5.2 Session Start: Bootstrap

**Source:** `src/agents/loader.ts` (AgentLoader.load — lines 123-137)

During agent loading:

1. If `config.memory.crossSessionBootstrap` is true, the loader calls
   `bootstrap()` on the MemoryAdapter
2. Entry contents are formatted as a bullet list for system prompt injection
3. The `memoryStore` is also instantiated from the registry and attached to
   the `LoadedAgent` object

### 5.3 Bootstrap Content Injection

**Source:** `src/session/cross-session-memory.ts` (formatBootstrapContent)

```typescript
formatBootstrapContent(entries: string): string
  → "## Bootstrap Memory\n\n<entry content>"
```

The formatted string is injected into the session system prompt during
`AgentSession.run()`.

---

## 6. Adding a New Backend

To add a new memory backend:

1. **Create the adapter class** implementing `AgentMemoryStore`:
   ```typescript
   import { AgentMemoryStore, AgentMemoryEntry, RecallOptions, BootstrapOptions } from "./contract";

   export class MyCustomAdapter implements AgentMemoryStore {
     async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> { ... }
     async recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> { ... }
     async bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]> { ... }
   }
   ```

2. **(Optional) Create a factory function** for convenience.

3. **Register the agent** in `src/memory/store-registry.ts`:
   - Add the agent name to the appropriate classification set
   - Or add a new `if` branch in `createAgentMemoryStore()`

4. **Export** from `src/memory/index.ts` if the adapter should be publicly
   accessible.

5. **Wire the lifecycle** in `src/session/cross-session-memory.ts` if the new
   agent needs custom session-end handling.

The contract interface in `src/memory/contract.ts` has zero runtime dependencies
and contains only TypeScript types — backend authors never need to import
application code.

---

## 7. File Reference

| File | Role |
|------|------|
| `src/memory/contract.ts` | Type definitions (AgentMemoryStore, AgentMemoryEntry, MemoryScope, etc.) |
| `src/memory/store-registry.ts` | Factory routing agent names to backends |
| `src/memory/boot.ts` | 4-step boot sequence executor |
| `src/memory/anima-entity-store.ts` | SQLite-backed full-featured store |
| `src/memory/bruno-entity-adapter.ts` | Bruno's neural graph bridge |
| `src/memory/abel-mem-adapter.ts` | 2B's HTTP service adapter |
| `src/services/abel-mem.ts` | HTTP client for abel-mem engine |
| `src/agents/loader.ts` | AgentLoader that wires memoryStore into LoadedAgent |
| `src/session/cross-session-memory.ts` | Session-end summary + session-start bootstrap formatting |
| `src/session/manager.ts` | SessionManager with onEnd hook that triggers summary |
| `src/session/compactor.ts` | LLM-based session turn summarizer |
