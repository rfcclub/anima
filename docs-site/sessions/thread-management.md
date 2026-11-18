# Thread Management

## Overview

Thread management maintains conversation history per agent per channel. ANIMA has two implementations:

| Implementation | Storage | Use Case |
|---------------|---------|----------|
| **ThreadStore** | In-memory (Map) | Lightweight, ephemeral sessions |
| **PersistentThreadStore** | SQLite (bun:sqlite) | Telegram, long-running sessions |

## In-Memory ThreadStore

```typescript
import { ThreadStore } from "../memory/thread-store";

const store = new ThreadStore();
store.add("telegram-123", "bruno", "user", "Hello");
store.add("telegram-123", "bruno", "assistant", "Hi there!");

const thread = store.getThread("telegram-123", "bruno");
// [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi there!" }]
```

### Properties
- **20-message window** per thread (oldest evicted)
- **100-thread LRU** cap (least-recently-used evicted)
- **Thread key**: `{channelId}:{agentName}`
- **Isolation**: different agents in same channel = separate threads

### API

| Method | Description |
|--------|-------------|
| `add(channelId, agentName, role, content)` | Append message to thread |
| `getThread(channelId, agentName)` | Get all messages in thread |
| `clear(channelId, agentName)` | Delete thread |

## PersistentThreadStore

```typescript
import { Database } from "bun:sqlite";
import { PersistentThreadStore } from "../memory/thread-store";

const db = new Database("sessions.db");
const store = new PersistentThreadStore(db, 50);

store.add("telegram-123", "bruno", "user", "Remember this");
store.add("telegram-123", "bruno", "assistant", "Stored.", [
  { tool: "anima_remember", args: "scope=identity", resultPreview: "ok" }
]);
```

### Properties
- **SQLite-backed** with WAL mode
- **50-message window** (configurable)
- **Auto-compaction**: when thread exceeds max size, older messages summarized
- **Tool summaries**: stores which tools were used per message
- **Summary role**: compacted messages become `summary` type (mapped to `user` for LLM compatibility)

### Compaction

When a thread exceeds `maxSize`:

```
[Msg 1] [Msg 2] ... [Msg 25] [Msg 26] ... [Msg 50]
                                      ▲ compaction point

After compaction:
[Summary of 1-25] [Msg 26] ... [Msg 50]
```

The summary extracts:
- Questions asked (lines ending with `?`)
- Decisions made (lines with `→`, `confirmed`, `agreed`)
- First and last lines of each message

### Schema

```sql
CREATE TABLE thread_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  agent_name   TEXT NOT NULL,
  role         TEXT NOT NULL,      -- 'user' | 'assistant' | 'summary'
  content      TEXT NOT NULL,
  tool_summary TEXT,               -- JSON array of ToolSummaryEntry
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_thread_lookup
  ON thread_messages(channel_id, agent_name, id);
```

## Thread Lifecycle

```
User sends message
    ↓
Session reads thread history
    ↓
Thread messages prepended to LLM context
    ↓
LLM responds
    ↓
User message + assistant response appended to thread
    ↓
If thread > maxSize → compact oldest messages into summary
```

## Integration with Sessions

```typescript
// Simplified from session.ts
const threadMessages = threadStore.getThread(channelId, agentName);
const messages = [
  { role: "system", content: systemPrompt },
  ...threadMessages,  // conversation history
  { role: "user", content: newMessage }
];
```

Thread history is injected **after** the system prompt and **before** the new user message. This gives the LLM full conversation context without bloating the static prompt prefix.

## Cross-Channel Isolation

Each (channel, agent) pair has an independent thread:

```
ThreadStore
├── telegram-123:bruno → [msg1, msg2, msg3]
├── telegram-456:bruno → [msg1, msg2]           ← separate thread
├── telegram-123:eli → [msg1]                  ← different agent
└── cli:bruno → [msg1, msg2, msg3, msg4]         ← CLI channel
```

## Memory vs Thread

| Aspect | Thread | Memory |
|--------|--------|--------|
| **Scope** | Current conversation | Cross-session |
| **Storage** | In-memory or SQLite | JSONL / SQLite |
| **Persistence** | Session-scoped | Permanent |
| **Content** | Raw messages | Structured observations |
| **Use** | LLM context | Recall on demand |

Threads provide **recency** (what just happened). Memory provides **retention** (what was learned).
