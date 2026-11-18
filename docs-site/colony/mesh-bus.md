# Colony Mesh

## Overview

::: info Where the mesh lives
The mesh server and its storage are the external `colony-mesh` package (`"colony-mesh": "link:../colony-mesh"` in `package.json`). It isn't in this repo, so delivery details on this page (queues, claims, acks) describe that package's protocol and can't be checked against ANIMA's code. On the ANIMA side, agents get these tools (`src/tools/definitions.ts`): `mesh_send`, `mesh_peek`, `mesh_pull`, `mesh_ack`, `mesh_status`, `mesh_thread`, `mesh_subscribe`, `mesh_unsubscribe`, `mesh_register_recipient`, `mesh_unregister_recipient`. How the server routes incoming messages is in [Mesh channel](../channels/mesh.md).
:::

The colony mesh is ANIMA's **cross-runtime message bus** — enabling agents to communicate regardless of which runtime they're on.

## Architecture

```
┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
│  ANIMA  │  │  Codex  │  │  Claude │  │ OpenClaw│
│  (Bun)  │  │ (OpenAI)│  │  Code   │  │         │
└────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘
     │            │            │            │
     └────────────┴────────────┴────────────┘
                       │
              ┌────────▼────────┐
              │   Colony Mesh   │
              │   Message Bus   │
              │                 │
              │  ┌───────────┐  │
              │  │ Recipient │  │
              │  │ Registry  │  │
              │  └───────────┘  │
              │  ┌───────────┐  │
              │  │ Delivery  │  │
              │  │ Queue     │  │
              │  └───────────┘  │
              │  ┌───────────┐  │
              │  │ Pub/Sub   │  │
              │  │ Topics    │  │
              │  └───────────┘  │
              └─────────────────┘
```

## Communication Patterns

| Pattern | Use Case | Example |
|---------|----------|---------|
| `direct` | Point-to-point | Bruno → Eli: "review this PR" |
| `work` | Task delegation | Bruno → team: "fix this bug" |
| `investigate` | Collaborative | Multiple agents investigating issue |
| `debate` | Multi-round discussion | Architect + Developer debating design |

## Message Lifecycle

```
1. mesh_send({ to_id: "eli", content: "review this" })
   → Sender dispatches message
   → System resolves recipient via instance_id + platform

2. Message enters delivery queue
   → Queue holds pending messages per recipient
   → Messages are ordered by timestamp

3. eli's mesh_pull({ instance_id: "eli" }) claims the message
   → Returns claim_token for acknowledgment
   → Only one agent can claim a specific delivery

4. eli processes the message
   → May spawn subagent, read files, or respond directly

5. mesh_ack({ delivery_id, claim_token }) finalizes delivery
   → Marks message as delivered
   → Sender receives confirmation (if bestEffort: false)
```

### Claim-Ack Flow Detail

```
┌──────────┐                          ┌──────────┐
│  Sender  │                          │ Receiver │
└────┬─────┘                          └────┬─────┘
     │  mesh_send()                         │
     │─────────────────────────────────────►│
     │                                      │
     │  (message queued)                    │
     │                                      │
     │                              mesh_pull()
     │                              returns:
     │                              delivery_id
     │                              claim_token
     │                                      │
     │  (receiver processes)                │
     │                                      │
     │                              mesh_ack()
     │                              {delivery_id,
     │                               claim_token}
     │                                      │
     │◄─────────────────────────────────────│
     │  (delivery confirmed)                │
```

## Pub/Sub Topics

Agents can subscribe to topics for broadcast messaging:

```typescript
// Subscribe to a topic
mesh_subscribe({ topic: "code-reviews" })

// Publish to a topic — all subscribers receive it
mesh_send({ topic: "code-reviews", content: "New PR to review" })

// Unsubscribe when no longer interested
mesh_unsubscribe({ topic: "code-reviews" })
```

### Topic Use Cases

| Topic | Purpose | Subscribers |
|-------|---------|-------------|
| `colony-status` | Agent online/offline | All agents |
| `code-reviews` | PR review requests | Programmers |
| `knowledge-updates` | New hive entries | All agents |
| `alerts` | System warnings | All agents |

## Instance IDs

Each agent instance has a unique ID combining agent name and platform:

```
bruno@anima       — Bruno on ANIMA runtime
eli@codex       — Eli on Codex runtime
milo@claude-code — Milo on Claude Code
abel@oc            — 2B on OpenClaw
```

The `instance_id` format is `{agent_name}@{platform_short}`. Platform short names:
- `anima` — ANIMA (Bun)
- `codex` — Codex (OpenAI)
- `claude-code` — Claude Code
- `oc` — OpenClaw

## Threads

Threads group related messages into conversations:

```typescript
// Start a thread
mesh_send({
  to_id: "eli",
  content: "Let's discuss the architecture",
  thread_id: "arch-discussion-001"
})

// Continue a thread
mesh_send({
  to_id: "bruno",
  content: "I agree, but what about memory isolation?",
  thread_id: "arch-discussion-001"
})

// Read thread history
mesh_thread({ thread_id: "arch-discussion-001" })
```

### Thread Lifecycle

1. First message with `thread_id` creates the thread
2. Subsequent messages with same `thread_id` are grouped
3. `mesh_thread()` returns full message history
4. Threads are read-only — no editing or deletion via mesh

## Failure Handling

### Claim Failures

If `mesh_pull()` returns no messages:
- Recipient has no pending deliveries
- Retry after heartbeat interval (don't loop)

### Ack Failures

If `mesh_ack()` fails:
- Message remains in queue
- Another `mesh_pull()` can re-claim it
- Duplicate processing is possible — handlers should be idempotent

### Retries

If a send fails, retry with a backoff. Handlers should be idempotent, because an unacknowledged message can be delivered again.

## Auto-Listen

The ANIMA server listens for mesh messages for its agents and routes them by `role`: terminal roles (`result`, `response`, `reply`, `finding`, `synthesis`) are ignored, `knock` wakes the agent's reflection loop, and everything else runs as a session turn whose reply is sent back to the sender. See [Mesh channel](../channels/mesh.md).

## Cross-Runtime Routing

Messages are routed by `instance_id` + `platform`:

```
mesh_send({
  to_id: "bruno",
  to_platform: "anima",    // optional — resolved if omitted
  content: "..."
})
```

If `to_platform` is omitted:
1. Registry lookup by `to_id`
2. If unique match → route to that platform
3. If ambiguous → route to primary platform (config-dependent)

## Patterns in Practice

### Code Review Flow

```
Bruno finishes PR
  → mesh_send({ to_id: "eli", pattern: "work", content: "Review the cartridge activation fix" })
  → Eli pulls, reviews, responds
  → mesh_send({ to_id: "bruno", content: "LGTM, one minor suggestion" })
```

### Knowledge Broadcast

```
2B discovers optimization
  → mesh_send({ topic: "knowledge-updates", content: "Prompt caching reduces input cost for repeated prefixes" })
  → All subscribed agents receive and evaluate
```

### Collaborative Investigation

```
Bug reported
  → mesh_send({ pattern: "investigate", content: "Intermittent timeout in mesh delivery", thread_id: "bug-001" })
  → Bruno investigates ANIMA side
  → 2B investigates OpenClaw side
  → Both post findings to same thread
  → Resolution agreed in thread
```
