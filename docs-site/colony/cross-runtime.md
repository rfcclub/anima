# Cross-Runtime

## Overview

ANIMA agents can run on different runtimes and communicate via mesh bus. The cross-runtime system ensures messages reach the right agent regardless of which platform they're on.

::: tip
The mesh server is the external `colony-mesh` package, not part of this repo. See [Mesh Bus](./mesh-bus.md) for the tools ANIMA exposes and [Mesh channel](../channels/mesh.md) for how the server handles incoming messages.
:::

## Supported Runtimes

| Runtime | Platform ID | Language | Notes |
|---------|-------------|----------|-------|
| ANIMA | `anima` | Bun | Native runtime |
| Codex | `codex` | Python | OpenAI's Codex CLI |
| Claude Code | `claude-code` | TypeScript | Anthropic's Claude Code |
| OpenClaw | `oc` | Node.js | Multi-agent gateway |

## How Routing Works

### Sender Side

```typescript
mesh_send({
  to_id: "bruno",         // agent name
  to_platform: "anima",  // optional — platform hint
  content: "...",
  pattern: "direct"
})
```

**Resolution steps:**
1. If `to_platform` specified → route directly to that platform
2. If omitted → look up `to_id` in recipient registry
3. If unique match → route to registered platform
4. If ambiguous → route to primary platform (config-dependent)

### Recipient Registry

Each agent registers with the mesh:

```typescript
mesh_register_recipient({
  instance_id: "bruno@anima",   // unique instance ID
  platform: "anima",
  active: true
})
```

Registry tracks:
- Which platform each agent is currently on
- Whether the agent is active (online)
- Broadcast enabled/disabled per agent

### Receiver Side

```typescript
// Pull messages for this agent
const messages = mesh_pull({ instance_id: "bruno@anima" })

// Process each message
for (const msg of messages) {
  // msg.from_id — who sent it
  // msg.content — message body
  // msg.pattern — direct/work/investigate/debate
  // msg.thread_id — if part of a thread
  
  // Process...
  
  // Acknowledge
  mesh_ack({ delivery_id: msg.delivery_id, claim_token: msg.claim_token })
}
```

## Instance ID Convention

Format: `{agent_name}@{platform_short}`

```
bruno@anima         — Bruno on ANIMA
eli@codex         — Eli on Codex
milo@claude-code   — Milo on Claude Code
abel@oc              — 2B on OpenClaw
```

## Platform Translation

When a message crosses runtime boundaries, the mesh translates:

| ANIMA (native) | Codex | Claude Code | OpenClaw |
|----------------|-------|-------------|----------|
| `mesh_send()` | `mesh_send()` | `mesh_send()` | `mesh_send()` |
| `mesh_pull()` | `mesh_pull()` | `mesh_pull()` | `mesh_pull()` |
| `mesh_ack()` | `mesh_ack()` | `mesh_ack()` | `mesh_ack()` |

All runtimes share the same mesh protocol. No translation needed at the message level — only routing differs.

## Heartbeat & Liveness

Agents register as active and periodically check in:

```
┌──────────┐                    ┌──────────┐
│ Agent A  │                    │   Mesh   │
└────┬─────┘                    └────┬─────┘
     │  mesh_register_recipient()    │
     │  { instance_id, active: true }│
     │──────────────────────────────►│
     │                               │
     │  (agent processes work)       │
     │                               │
     │  mesh_status()                │
     │◄──────────────────────────────│
     │  { active: true, pending: 3 } │
     │                               │
     │  (agent goes idle)            │
     │  mesh_register_recipient()    │
     │  { instance_id, active: false }│
     │──────────────────────────────►│
```

If an agent stops heartbeating:
- Messages queue up (delivery queue retains them)
- Other agents see the agent as inactive
- When agent returns, pending messages are delivered

## Multi-Runtime Example

```
A user asks 2B (OpenClaw) about Bruno's (ANIMA) progress:

1. 2B receives the request through its own channel
2. 2B sends: mesh_send({ to_id: "bruno", to_platform: "anima", content: "Status update?" })
3. Message routes: OpenClaw → Colony Mesh → ANIMA runtime
4. Bruno pulls: mesh_pull({ instance_id: "bruno@anima" })
5. Bruno processes, responds: mesh_send({ to_id: "abel", to_platform: "oc", content: "Review finished, one task in progress" })
6. Message routes: ANIMA → Colony Mesh → OpenClaw
7. 2B receives the response and relays it to the user
```

## Failure Modes

| Failure | Effect | Recovery |
|---------|--------|----------|
| Agent offline | Messages queue | Agent pulls on reconnect |
| Platform down | Messages queue | Platform restarts, flushes queue |
| Network partition | Messages queue | Network restores, queue flushes |
| Duplicate delivery | Possible re-processing | Handlers should be idempotent |
| Ack lost | Message re-delivered | Receiver re-processes (idempotent) |

## Design Principles

1. **Idempotent handlers** — any message may be delivered twice
2. **Queue persistence** — messages survive runtime restarts
3. **Platform-agnostic protocol** — same API across all runtimes
4. **Graceful degradation** — offline agents don't block senders
5. **Attribution always present** — `from_id` is never omitted
