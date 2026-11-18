# Session Lifecycle — Component Design

## 1. Overview

A session in ANIMA represents an interactive turn between a human (or channel)
and an agent. The session lifecycle encompasses booting the agent, running the
conversation loop (including tool execution, memory recall, and evaluation),
and cleanly closing the session with state persistence.

The lifecycle spans four modules:
- **AgentLoader** — loads agent substrate (config, genes, soul, memory)
- **AgentSession** — runs a single message through the provider + tool loop
- **SessionLifecycle** — manages channel-level open/close lifecycle with
  context assembly
- **SessionManager** — manages session records, turns, compaction, and the
  onEnd hook for cross-session memory

---

## 2. AgentLoader Boot Sequence

**Source:** `src/agents/loader.ts`

`AgentLoader.load(name)` produces a `LoadedAgent` object that is the complete
description of an agent ready for session execution.

### Boot Steps

```
load(name)
  │
  ├─ 1. Resolve roomDir from roomsDir/{name}
  ├─ 2. Read and parse config.yaml → RoomConfig
  ├─ 3. Read boot files:
  │    ├─ gene          (required)
  │    ├─ soul          (optional)
  │    ├─ sessionContext files
  │    ├─ additionalSessionContext files
  │    └─ additional boot files
  ├─ 4. Run extraActions (shell commands defined in config)
  ├─ 5. Load MemoryAdapter:
  │    ├─ "custom" → CustomMemoryAdapter (with entityScript)
  │    ├─ "shared" → SharedMemoryAdapter
  │    └─ default  → import memory-adapter.js from roomDir
  ├─ 6. Bootstrap cross-session memory (if crossSessionBootstrap enabled)
  └─ 7. Create AgentMemoryStore from registry
```

### Security Constraints

- **Path escaping prevention**: Read paths are validated against escaping the room
  directory unless they use `~/` or are absolute.
- **Tool policy**: The agent's `policy.allowedTools` list gates which tools the
  provider can call in auto mode.

### LoadedAgent Shape

```typescript
interface LoadedAgent {
  name: string;
  label: string;
  roomDir: string;
  config: RoomConfig;
  geneContent: string;          // Core identity prompt
  soulPath?: string;            // Optional soul file path
  soulContent?: string;         // Optional soul file content
  sessionContextFiles: SessionContextFile[];  // Context files for system prompt
  additionalSessionContext?: SessionContextFile[];  // Deeper context files
  extraActionResults?: ExtraActionResult[];    // Results of boot shell commands
  memoryAdapter: MemoryAdapter;  // Session memory
  memoryStore?: AgentMemoryStore; // Cross-session memory (optional)
  bootstrapContent?: string;     // Formatted bootstrap entries for prompt
}
```

---

## 3. AgentSession Run Loop

**Source:** `src/agents/session.ts`

`AgentSession.run()` executes a single message through the full session pipeline.

### Run Sequence

```
run(agent, message, options)
  │
  ├─ 1. Resolve permission mode (default or auto)
  ├─ 2. Generate sessionId + read recent events from JSONL store
  ├─ 3. Build system prompt via buildSystemPrompt()
  │      (includes identity, gene, recent events, mode context)
  ├─ 4. Inject lifecycleContext (if provided)
  ├─ 5. Inject cartridge layer (shared + agent-scoped cartridges)
  │      └─ Dynamic cartridge: task-detect or manual override
  ├─ 6. Memory recall via MemoryAdapter (query = user message)
  │      └─ Injects [Memory Context] section into system prompt
  ├─ 7. Thread context prepend (if channelId + threadStore provided)
  ├─ 8. Inject identity anchor at recency boundary
  ├─ 9. Log user_message event to JSONL store
  ├─ 10. Start MCP manager (if MCP servers configured)
  ├─ 11. Run tool loop:
  │      └─ Provider query → tool execution → loop (max 64 iterations)
  ├─ 12. Log assistant_message event to JSONL store
  ├─ 13. Evaluate response through EvaluationPipeline
  ├─ 14. If auto_apply: memory store + thread update
  └─ 15. Stop MCP manager
```

### Tool Loop

The tool loop at `runToolLoop()` drives the provider's tool-use capabilities:

```
for iteration = 0..63:
  1. Provider.query(messages, system, tools)
  2. If no tool_calls → return response (done)
  3. Append assistant message with tool_calls to messages
  4. For each tool_call:
     a. Permission check (auto guard or manual approval)
     b. If MCP tool → call via mcpManager
     c. Else → executeTool() for built-in tools
     d. Append tool_result to messages
  5. Continue loop
```

Tool execution results are logged with the agent name, tool name, iteration
number, and output length.

### Auto Mode Guard

In auto mode (`mode === "auto"`), a `ProviderPermissionHandler` gate checks each
tool call against the agent's `policy.allowedTools` set. Blocked tools return a
descriptive error to the provider.

### Evaluation Pipeline Gate

The evaluation pipeline runs after the response is generated:

- `decision === "auto_apply"` → memory is stored, thread is updated
- `decision !== "auto_apply"` → memory is held, thread is not updated
- Pipeline error → fail-open: allow by default (null result)

---

## 4. Tool Execution and MCP Integration

### Built-in Tools

**Source:** `src/tools/definitions.ts` + `src/tools/executor.ts`

Built-in tools are loaded from the agent's `policy.allowedTools` configuration
and include filesystem operations, code execution, agent-to-agent messaging,
and ANIMA-specific commands.

### MCP Integration

**Source:** `src/mcp/manager.ts` + `src/mcp/client.ts`

If the agent's config defines MCP servers under `config.mcp.servers`, an
`McpManager` is started before the run loop:

```typescript
const mcpManager = agent.config.mcp?.servers.length
  ? mcpManagerFactory(agent.config.mcp.servers)
  : undefined;

// Lifecycle:
await mcpManager.start();           // Start all MCP servers
const mcpTools = mcpManager.getTools();  // Get tool definitions
// ... merged with built-in tools ...
await mcpManager.stop();            // Stop all MCP servers
```

MCP tools are detected in the tool loop by comparing against `mcpToolNames`.
MCP tool results are formatted through `formatMcpToolResult()` which extracts
text content from the standard MCP result envelope.

### Agent-to-Agent (A2A) Tools

**Source:** `src/tools/a2a.ts`

Two tools are available to agents:
- `send_message(to, subject, body, thread_id?)` — sends a message to another
  agent's inbox (backed by `A2AStore` SQLite table)
- `read_inbox(unread_only?)` — reads the agent's incoming messages

The A2A store uses a shared SQLite database (`~/.anima/sessions.db`) with an
`a2a_messages` table.

---

## 5. Memory Recall/Inject/Remember Cycle

The memory cycle spans three phases during a session:

### Phase 1: Session Open (Memory Context Injection)

**Source:** `src/session/lifecycle.ts` (`SessionLifecycle.onOpen()`)

When a channel session opens, the lifecycle assembles context from:
- Session context files
- Additional session context files
- Extra action results
- Crossing manager (continuity state)
- Dream beams (LightNap summaries from past sessions)
- **Entity memory recall** — queries the MemoryAdapter with `"session open <agentId>"`
- Trust context initialization

All sections are concatenated into `session.systemContext` and injected into the
system prompt of every subsequent `AgentSession.run()` call via `lifecycleContext`.

### Phase 2: Session Run (Memory Recall)

**Source:** `src/agents/session.ts` (`AgentSession.run()`, step 6)

Before the provider call, the MemoryAdapter is queried:

```typescript
const recalled = await adapter.recall(message, {
  namespace: agent.name,
  topK: agent.config.memory?.topK ?? 5,
  mode: agent.config.memory?.recallMode,
  recentDays: agent.config.memory?.recentDays,
  sessionStore,
  sessionId,
});
```

Recalled entries are formatted as `[Memory Context]\n- <entry1>\n- <entry2>...`
and appended to the system prompt.

### Phase 3: Session Run (Memory Store)

**Source:** `src/agents/session.ts` (`AgentSession.run()`, step 14, gated by eval)

After the response is generated and evaluated:

```typescript
await adapter.store({
  namespace: agent.name,
  content: `User: ${message}\nAssistant: ${responseText}`,
  type: "message",
  timestamp: new Date().toISOString(),
});
```

### Phase 4: Session Close (Cross-Session Summary)

**Source:** `src/session/lifecycle.ts` (`SessionLifecycle.onClose()`)
+ `src/session/cross-session-memory.ts`

When a session closes:
1. All session events are collected
2. A **LightNap** dream run is triggered (async, tracked in `pendingLightNaps`)
3. A **crossing** entry is written (continuity state)
4. The `onEnd` hook fires via `SessionManager`, which:
   - Summarizes session turns via the `Compactor`
   - Persists the summary via `memoryStore.remember()`

---

## 6. Session End Handler

### SessionLifecycle.onClose()

```typescript
async onClose(agentId, channelId):
  1. Look up active session by composite key {agentId}\0{channelId}
  2. Collect all session events from JSONL store
  3. Log session_lifecycle_close event
  4. Trigger LightNap (async, fire-and-forget with tracking)
  5. Write crossing entry
  6. Spawn write-daily-memory.mjs (fire-and-forget)
```

### SessionManager.closeSession()

```typescript
closeSession(agent, channel):
  1. Look up active session
  2. Fire onEnd hook (→ cross-session memory summary)
  3. End the session record in SessionStore
```

### SessionManager.newSession()

```typescript
newSession(agent, channel):
  1. If an active session exists:
     a. Fire onEnd hook
     b. End the session
  2. Create a new session
```

### drain()

`SessionLifecycle.drain()` awaits all in-flight LightNap promises. This is
called before process shutdown to ensure dream state is persisted.

---

## 7. Cross-Session Bootstrap

### Session Start

When `AgentLoader.load()` runs:
1. If `config.memory.crossSessionBootstrap` is true, the loader calls
   `memoryAdapter.bootstrap()` (if the adapter has a bootstrap method)
2. Entry contents are formatted as a bullet list
3. The `AgentMemoryStore` is created via `createAgentMemoryStore()` and
   attached to `LoadedAgent.memoryStore`

### Session End

`buildSessionEndHandler()` in `src/session/cross-session-memory.ts`:

```typescript
buildSessionEndHandler(memoryStore, provider, sessionStore, model)
  → async (sessionId, agentName) => {
      const turns = sessionStore.getTurns(sessionId);
      if (turns.length === 0) return;
      await writeSessionSummary(memoryStore, provider, sessionId, turns, model);
    }
```

`writeSessionSummary()`:
1. Maps TurnRecord[] to SessionTurn[]
2. Creates a Compactor with the provider
3. Calls `compactor.summarize()` to generate a natural language summary
4. Calls `memoryStore.remember()` to persist the summary with tags
   `["session-summary", "session-{id}"]`

---

## 8. Compaction

**Source:** `src/session/compactor.ts` + `src/session/manager.ts`

The SessionManager monitors token usage per session. When a session approaches
the token limit, compaction is triggered:

- **Soft threshold** (70% of maxTokens): trigger compaction, but it can wait
- **Hard threshold** (85% of maxTokens): immediate compaction needed
- **Protected recent turns** (default 6): the most recent N turns are never
  compacted, preserving conversational context

Compaction uses branch-based soft deletion: turns on the active branch before
the protected cutoff are marked as deleted in the SessionStore.

---

## 9. File Reference

| File | Role |
|------|------|
| `src/agents/loader.ts` | AgentLoader — loads agent substrate from disk |
| `src/agents/session.ts` | AgentSession — runs a message through provider + tool loop |
| `src/agents/loop.ts` | Loop run mode — autonomous multi-iteration task loops |
| `src/agents/prompter.ts` | System prompt builder from LoadedAgent |
| `src/agents/messages.ts` | Message builder from turns |
| `src/session/lifecycle.ts` | SessionLifecycle — open/close lifecycle with context assembly |
| `src/session/manager.ts` | SessionManager — session records, turns, compaction |
| `src/session/cross-session-memory.ts` | Cross-session memory summary and bootstrap |
| `src/session/compactor.ts` | LLM-based turn summarizer |
| `src/session/types.ts` | SessionTurn and related types |
| `src/mcp/manager.ts` | MCP server lifecycle management |
| `src/tools/a2a.ts` | Agent-to-agent messaging tools |
| `src/evaluation/pipeline.ts` | Evaluation pipeline for gating actions |
