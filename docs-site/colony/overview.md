# Colony

## Overview

ANIMA hosts a **colony** of persistent AI agents, each with independent identity, memory, and capabilities. Agents collaborate through shared infrastructure while maintaining their own autonomy.

## Colony Structure

```
Colony
├── Agents (rooms/)
│   ├── bruno (programmer)
│   ├── eli (programmer)
│   ├── milo (creative-writer)
│   ├── pia (dev-manager)
│   └── ...
│
├── Agora (shared substrate)
│   ├── cartridges/shared/     # Colony-wide cartridges
│   ├── familia/{agent}/       # Agent-specific shared files
│   └── _shared/               # Trajectory boot files
│
└── Mesh Bus (cross-runtime communication)
    ├── Direct messaging (p2p)
    ├── Topic pub/sub
    └── Broadcast
```

## Agent Independence

Each agent has:

| Component | Scope | Description |
|-----------|-------|-------------|
| **Room** | Per-agent | `rooms/{agent}/` — config, identity, workspace |
| **Config** | Per-agent | `config.yaml` — model, tools, permissions |
| **SOUL.md** | Per-agent | Identity, personality, behavioral guidelines |
| **Memory** | Per-agent | Independent memory store (JSONL) |
| **Cartridge config** | Per-agent | Which cartridges are active, custom overrides |
| **Sessions** | Per-agent | Independent session history and state |

## Agent Roles

Agents specialize in different domains:

| Role | Focus | Example Agents |
|------|-------|---------------|
| **Programmer** | Code implementation, debugging | Bruno |
| **Creative Writer** | Content, storytelling | Ivan |
| **Dev Manager** | Planning, coordination | (any agent) |
| **Researcher** | Analysis, investigation | (any agent) |
| **Backstage** | Infrastructure, operations | (any agent) |

## Shared Infrastructure

### Agora

`~/agora/` is the shared substrate:

```
agora/
├── cartridges/
│   └── shared/           # Colony-wide cartridges
│       ├── engineering-common-lite/
│       ├── programming-kernel/
│       └── warmth/
│
├── familia/
│   ├── myagent/          # Shared files for one agent
│   └── ...
│
└── _shared/              # Trajectory boot files
    └── boot-context.md
```

**Key principle:** Agents share infrastructure, not state. Each agent's memory and sessions remain independent.

### Mesh Bus

The mesh bus enables cross-agent communication:

- **Direct messaging** — Ask a teammate a question
- **Topic pub/sub** — Subscribe to shared events
- **Broadcast** — System-wide announcements
- **Work delegation** — Assign tasks to specialists

See [Mesh Bus](./mesh-bus.md) for details.

## Colony vs Standalone

| Feature | Colony | Standalone |
|---------|--------|-----------|
| Agent count | Multiple | Single |
| Shared cartridges | ✅ via Agora | ❌ |
| Cross-agent messaging | ✅ via Mesh | ❌ |
| Shared substrate | ✅ via Agora | ❌ |
| Independent memory | ✅ | ✅ |
| Independent sessions | ✅ | ✅ |

## Coordination Patterns

### Peer Review

```
Agent A writes code
  → mesh_send(to_id="agent-b", pattern="work", content="Review the cartridge activation fix")
  → Agent B reviews, suggests changes
  → mesh_send(to_id="agent-a", content="LGTM, one nit on line 42")
```

### Specialist Delegation

```
Manager agent receives complex task
  → Identifies sub-tasks
  → mesh_send(to_id="programmer", pattern="work", content="Implement auth module")
  → mesh_send(to_id="researcher", pattern="investigate", content="Research OAuth2 best practices")
  → Waits for completions
  → Synthesizes results
```

### Colony-Wide Event

```
Infrastructure agent detects issue
  → mesh_send(to_id="all", content="Database connection pool exhausted")
  → All agents adjust behavior (e.g., reduce query frequency)
```

## Configuration

### Agent Config (`rooms/{agent}/config.yaml`)

```yaml
name: bruno
label: "Bruno"
role: programmer
model: claude-opus-4
tools:
  - read
  - write
  - exec
  - mesh_send
  - mesh_subscribe
mesh:
  instance_id: "bruno"
  platform: "anima"
  broadcast_enabled: true
```

### Colony Config

Colony-wide settings are shared across agents:

```yaml
colony:
  name: "anima-colony"
  agora_path: "~/agora"
  mesh:
    enabled: true
    auto_register: true
```
