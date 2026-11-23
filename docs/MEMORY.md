# Memory & Session Storage

Anima persists session memory in SQLite. Each agent maintains a turn history that survives restarts, and old context is automatically compacted when it grows too large.

## Session Database

**Default location:** `~/.anima/anima-sessions.db`

Override with `ANIMA_SESSIONS_DB` environment variable.

All agents share this database unless `memory.type: custom` is set.

## Schema

### `sessions` table

```sql
CREATE TABLE sessions (
  id      TEXT PRIMARY KEY,    -- UUID
  agent   TEXT NOT NULL,       -- agent name (e.g. "bruno")
  channel TEXT NOT NULL,       -- channel (e.g. "telegram", "cli")
  started TEXT NOT NULL,       -- ISO timestamp
  ended   TEXT,                -- ISO timestamp, NULL if active
  active_branch_id INTEGER     -- current context branch (see Branching)
);
```

### `turns` table

```sql
CREATE TABLE turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content    TEXT NOT NULL,
  ts         TEXT NOT NULL,    -- ISO timestamp
  deleted    INTEGER DEFAULT 0,-- soft delete flag
  branch_id  INTEGER REFERENCES branches(id)
);
```

### `branches` table

```sql
CREATE TABLE branches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  parent_branch_id  INTEGER REFERENCES branches(id),
  fork_from_turn_id INTEGER REFERENCES turns(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, name)
);
```

## Compaction

When the accumulated context exceeds `session.compactThreshold` tokens (default: 60,000), the Compactor summarises older turns into a single `compact` assistant turn.

**What it preserves:** durable user intent, decisions, unresolved tasks, constraints, key facts.

**What it discards:** verbatim turn-by-turn content.

The summary turn is injected at the top of the context so recent turns still receive full detail while older history is condensed.

Configure the threshold in room config:

```yaml
session:
  compactThreshold: 60000   # tokens; lower = more frequent compaction
```

## Context Branching

Branches allow forking a session's context at a specific turn — useful for exploring alternatives or isolating experimental work without losing the main thread.

- Every session starts on the default branch (`main`)
- `branches` records the fork point (`fork_from_turn_id`) and parent (`parent_branch_id`)
- Turns are associated with their branch via `branch_id`
- Switching branches loads only turns for that branch + the chain of parent branches up to the fork point

Branches are created and switched via the session API or CLI session commands.

## Memory Types

Configured via `memory.type` in room config:

| Type | Description |
|------|-------------|
| `shared` (default) | All agents share `~/.anima/anima-sessions.db` |
| `module` | Agent uses its own DB at `mount/anima-session.db` |
| `custom` | Specify a custom adapter via `memory.customAdapter` |

```yaml
memory:
  type: module    # agent-private database in mount/
```

## Additional Session Context

Files loaded into context at boot alongside the gene/soul:

```yaml
memory:
  additionalSessionContext:
    - ~/substrate/myagent/CONTEXT_SNAPSHOT.md
    - label: "Long-term memory"
      path: mount/MEMORY.md
```

These files do not affect the SQLite store — they are injected as read-only context at boot.

## Snapshots

Snapshots are session-end summaries written to disk to bridge continuity across stateless LLM sessions.

**Write at session end:**
```bash
# ~/.claude/snapshots/<name>.snapshot  (Claude Code)
# ~/.openclaw/snapshots/<name>.snapshot (OpenClaw)
# ~/.anima/snapshots/<name>.snapshot   (anima server)
```

Content format (free text, typically ~50 lines):
- Who the agent is (1–2 sentences)
- What was done this session
- What is open or pending
- State: one sentence on where things stand

**Load at next session start:** if the snapshot file exists, it is injected into the boot context before the first user turn.

The snapshot path is runtime-scoped so concurrent runtimes (Claude Code + OpenClaw) do not overwrite each other.

## MEMORY.md

A curated long-term notes file maintained by the agent inside `mount/MEMORY.md`. Unlike the SQLite turn store (which is automatic), MEMORY.md is written by the agent when it wants to preserve something across compaction.

Add it to `sessionContext` to load it at boot:

```yaml
boot:
  sessionContext:
    - MEMORY.md
```

The agent can update it via the Write tool during sessions. This is the primary mechanism for durable, human-readable long-term memory.

## Continuity ledger (Phase B)

`src/memory/continuity-ledger.ts` is the canonical, durable record of continuity
signals, backed by `continuity-envelope.ts` for versioned shape validation. It is
deliberately separate from the memory store hierarchy: `AnimaEntityStore` stays
the durable local memory and Hindsight stays a supplementary recall backend, so
neither can silently become the authority for identity.

Current, already-implemented guarantees (all covered by
`__tests__/memory/continuity-ledger.test.ts`):

- A canonical record and its outbound delivery work commit in one transaction.
- A retried event returns the existing record; a changed source version is a new
  record; a reused idempotency key with different content is kept as a second
  event under a derived record key and gets its own backend document id.
- Hindsight imports are stored with `origin = "hindsight-import"` and get no
  delivery work, so an import cannot echo back out.
- Delivery has `pending` / `delivered` / `failed` states, retries reuse the same
  stable document id, and the backend id and version are recorded.
- `supersede()` is explicit and replay-safe; its audit row carries both parents
  and no subject, so it never surfaces as current advice.
- `currentForSubject()` excludes superseded and expired records;
  `history()` still returns them for authorized historical queries, and
  `conflicts()` reports unresolved disagreement instead of picking a winner.

Not yet wired: runtime capture hooks, delivery workers, wake/expand context and
background consolidation. Those are separate phases; this ledger only provides
the storage and transaction boundary they will use.
