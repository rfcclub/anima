# Agora Event Bus — Component Design

## 1. Overview

The Agora is the inter-agent event bus for the ANIMA colony. It enables:

- **Task orchestration** — routing work items among agents (Legio instances)
- **Event-driven coordination** — subscribing to colony-wide events
- **Trust-based routing** — selecting agents based on domain trust scores
- **Escalation handling** — managing blocked, failed, or reassigned tasks
- **Colony observability** — dashboard state via getColonyState()

The Agora system is organized into three layers:
- **AgoraClient** — the central event bus and dispatcher
- **ANIMA namespace** — a global singleton facade for `requestLegio()`
- **Types module** — event types, legio descriptors, routing config

---

## 2. AgoraClient Event Types

**Source:** `src/agora/types.ts`

Six event types form the event protocol:

| Event Type | Interface | Trigger | Description |
|-----------|-----------|---------|-------------|
| `task_assigned` | `AgoraTaskAssignedEvent` | requestLegio() | A task has been assigned to a Legio |
| `task_complete` | `AgoraTaskCompleteEvent` | External | A Legio completed its assigned task |
| `task_failed` | `AgoraTaskFailedEvent` | External | A Legio failed its assigned task |
| `task_blocked` | `AgoraTaskBlockedEvent` | External | A task is blocked (needs human review) |
| `agent_offline` | `AgoraAgentOfflineEvent` | External | A Legio went offline |
| `agent_online` | `AgoraAgentOnlineEvent` | External | A Legio came online |

### Event Structure

All events share a common shape with a `type` discriminator:

```typescript
type AgoraEvent =
  | AgoraTaskCompleteEvent   // taskId, agentId, domain, result, timestamp
  | AgoraTaskFailedEvent     // taskId, agentId, domain, error, timestamp
  | AgoraTaskBlockedEvent    // taskId, agentId, domain, reason, timestamp
  | AgoraAgentOfflineEvent   // agentId, legioType, timestamp
  | AgoraAgentOnlineEvent    // agentId, legioType, timestamp
  | AgoraTaskAssignedEvent;  // taskId, agentId, legioId, domain, timestamp
```

### Event Handler API

```typescript
// Subscribe
client.on("task_complete", async (event) => { ... });

// Unsubscribe
client.off("task_failed", handler);

// Publish (internal)
client.emit(event);
```

### Default Event Handlers

`installDefaultHandlers()` wires four automatic responses:

1. **task_complete** → route through EvaluationPipeline for gating
2. **task_failed** → apply trust penalty via TrustSystem, clean up assignment
3. **task_blocked** → log notification (Telegram chat IDs configured)
4. **agent_offline** → reassign all active tasks to available Legios

---

## 3. Legio Routing Algorithm

**Source:** `src/agora/client.ts` (selectLegio)

A Legio is a worker agent registered in the Agora. Each Legio has a type that
maps to preferred task domains:

| Legio Type | Domain Preferences | Description |
|-----------|-------------------|-------------|
| `codex` | code_review | Code implementation, precise edits, token-heavy |
| `qwen` | external_action, memory_write | Parallel tasks, quota-tight, cheap inference |
| `gemini` | communication, architecture, private_mode | Analysis, research, review, creative |

### Domain-to-Legio Mapping

```typescript
defaultLegioForDomain(domain: TrustDomain): LegioType:
  code_review       → codex
  external_action   → qwen
  memory_write      → qwen
  architecture      → gemini
  communication     → gemini
  private_mode             → gemini
```

### Selection Algorithm

`selectLegio(taskDomain, options?)` scores all available Legios:

```
For each candidate Legio:
  score = 0
  if legio.available           → score += 3  (availability bonus)
  score += legio.trustScore                  (domain trust score)
  score += 1 / max(0.01, cost)               (cost inverse: cheaper = better)
  if legio.type === preferredType → score += 1 (type match bonus)

Sort by score descending
Return top candidate
```

Returns `null` if no Legios are registered.

### Legio Lifecycle

```typescript
registerLegio(descriptor: LegioDescriptor)
  → Adds to in-memory registry

unregisterLegio(legioId)
  → Removes from registry

setLegioAvailability(legioId, available)
  → Updates availability flag

requestLegio(agentId, taskDomain, options?)
  → selectLegio() → create assignment → track assignment → emit task_assigned
  → Returns AgoraTaskAssignedEvent or null
```

Legio availability auto-decrements: after 3 active tasks, a Legio is marked
unavailable (`available = false`) until its tasks complete.

---

## 4. Task Lifecycle

```
  requestLegio()
       │
       ▼
  task_assigned ←── Legio selected, task tracked in activeAssignments
       │
       ├── task_complete → EvaluationPipeline → cleanup
       │     (auto_apply or review decision)
       │
       ├── task_failed → TrustSystem.penalize() → cleanup
       │
       ├── task_blocked → notify (Telegram) → stays assigned
       │
       └── agent_offline → reassign to available Legio
```

### Active Task Tracking

```typescript
activeTasks: Map<string, {
  taskId: string;
  agentId: string;
  legioId: string;
  domain: string;
  startedAt: string;
}>
activeAssignments: Map<string, string>  // taskId → legioId
```

Active tasks are exposed via `getColonyState()` for the colony dashboard.

---

## 5. Trust Scoring

**Source:** `src/evaluation/trust-system.ts`

Trust scoring is integrated at two points in the Agora:

### Legio Selection

The `trustScore` field of `LegioDescriptor` is a factor in the selection
algorithm (see section 3). Higher trust → more likely to be assigned tasks.

### Trust Penalties

When a task fails, the `task_failed` default handler calls:

```typescript
await this.trustSystem.penalize(e.agentId, e.domain);
```

This decrements the agent's trust score for the domain of the failed task.

### Trust Domains

```typescript
type TrustDomain = "code_review" | "communication" | "external_action"
                 | "architecture" | "memory_write" | "private_mode";
```

Each domain has an independent trust score per agent. Trust scores are persisted
and loaded via the TrustSystem, which reads from the agent's room directory.

---

## 6. Inter-Agent Messaging (A2A)

**Source:** `src/tools/a2a.ts` + `src/memory/a2a-store.ts`

A2A messaging provides asynchronous message-passing between colony agents,
complementing the Agora event bus's synchronous task dispatch.

### Architecture

```
Agent A                     Agent B
   │                          │
   │── send_message(B, ...)   │
   │     └→ A2AStore.send()   │
   │         └→ INSERT INTO   │
   │            a2a_messages  │
   │                          │
   │                          │── read_inbox()
   │                          │     └→ A2AStore.readInbox(B)
   │                          │
   │                          │── send_message(A, ...)
```

### Store Schema

```sql
CREATE TABLE a2a_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT    NOT NULL,
  to_agent   TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  thread_id  TEXT,
  ts         TEXT    NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0
);
```

Indexed on `(to_agent, read)` for efficient inbox queries.

### Available Tools

Two tools are exposed to agents:

- **send_message**: `{ to, subject, body, thread_id? }` → returns message status
- **read_inbox**: `{ unread_only? }` → returns JSON array of messages

Messages persist in the shared SQLite database (`~/.anima/sessions.db`) and
survive agent restarts.

### A2A vs. Agora Bus

| Aspect | Agora Event Bus | A2A Messaging |
|--------|----------------|---------------|
| Pattern | Pub/sub, task dispatch | Point-to-point messages |
| Persistence | In-memory (events) | SQLite (persistent) |
| Consumption | Real-time event handlers | Polling via read_inbox |
| Use case | Task routing, coordination | Async communication |
| Lifecycle | Per-Legio registration | Persistent mailboxes |

---

## 7. ANIMA Global Namespace

**Source:** `src/agora/index.ts`

The `ANIMA` singleton provides global access to the dispatcher:

```typescript
// Initialize (once, at app startup)
ANIMA.initialize(agoraClient);

// Dispatch a task
const assignment = await ANIMA.requestLegio("bruno", "code_review");

// Convenience methods
await ANIMA.requestCodex(agentId, domain);
await ANIMA.requestQwen(agentId, domain);
await ANIMA.requestGemini(agentId, domain);
```

The namespace is initialized from `src/server.ts` or `src/cli.ts` and is used
throughout the codebase wherever agent-to-agent task dispatch is needed.

---

## 8. File Reference

| File | Role |
|------|------|
| `src/agora/client.ts` | AgoraClient — event bus + task dispatcher implementation |
| `src/agora/types.ts` | Event types, LegioDescriptor, routing config |
| `src/agora/index.ts` | ANIMA namespace (global singleton facade) |
| `src/evaluation/trust-system.ts` | Trust scoring per domain per agent |
| `src/evaluation/escalation.ts` | Escalation system for blocked/failed tasks |
| `src/evaluation/pipeline.ts` | Evaluation pipeline for gating task results |
| `src/tools/a2a.ts` | A2A tool definitions (send_message, read_inbox) |
| `src/memory/a2a-store.ts` | SQLite-backed A2A message store |
