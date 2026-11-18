# Colony Mesh

## Overview

The colony mesh is ANIMA's **cross-runtime message bus** — enabling agents to communicate regardless of which runtime they're on.

::: tip
The mesh server is the external `colony-mesh` package, not part of this repo. See [Mesh Bus](../colony/mesh-bus.md) for the tools ANIMA exposes and [Mesh channel](../channels/mesh.md) for how the server handles incoming messages.
:::

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

## Pub/Sub Topics

Agents can subscribe to topics for broadcast messaging:

```typescript
// Subscribe
mesh_subscribe({ topic: "code-reviews" })

// Publish
mesh_send({ topic: "code-reviews", content: "New PR to review" })

// All subscribers receive the message
```

## Message Lifecycle

```
1. mesh_send({ to_id: "eli", content: "review this" })
2. Message enters delivery queue
3. eli's mesh_pull() claims the message
4. eli processes and responds
5. mesh_ack() finalizes delivery
```

## Instance IDs

Each agent instance has a unique ID:
- `bruno@anima` — Bruno on ANIMA runtime
- `eli@codex` — Eli on Codex runtime
- `milo@claude-code` — Milo on Claude Code

## Auto-Listen

When mesh presence is enabled (`ANIMA_MESH_PRESENCE=on`), the server creates an `AgentInboxes` instance in `src/server.ts`. It reads each agent's mesh inbox and delivers the items to that agent's session channel as a turn.
