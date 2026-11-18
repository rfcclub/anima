# Agent-Specific Substrate

## Overview

Each agent can have its own substrate — memories, knowledge, and context that only that agent accesses.

## Structure

```
rooms/<agent>/
├── SOUL.md              # Identity constitution
├── AGENTS.md            # Instructions
├── MEMORY.md            # Memory bootstrap
├── memory/              # Memory store (JSONL)
│   ├── 2026-07-01.jsonl
│   ├── 2026-07-02.jsonl
│   └── 2026-07-03.jsonl
├── sessions/            # Session history
└── cartridges/          # Agent-specific cartridges
    └── my-special-cartridge.md
```

## Memory Isolation

Each agent's memory is stored separately:

```
rooms/bruno/memory/     ← Bruno's memories
rooms/eli/memory/     ← Eli's memories
rooms/milo/memory/     ← Milo's memories
```

Memories are **not shared** between agents by default. Cross-agent memory sharing happens through:
- Agora (shared substrate)
- Mesh bus (direct messaging)
- Colony reflections (cross-agent insights)

## Self-Writing

Agents can write to their own substrate:

```typescript
// Write a memory
anima_scratchpad_write({ content: "Learned about cartridge architecture" })

// Write to SOUL.md (with approval)
anima_update({ file: "SOUL.md", section: "Current State", content: "..." })
```

## Cartridge-Driven Retrieval

When a cartridge declares a retrieval policy, it queries the agent's own memory:

```yaml
kind: role
name: programming
retrieval:
  scopes: [project, episode]
  top_k: 8
```

This means:
- Bruno's programming cartridge queries Bruno's memories
- Eli's programming cartridge queries Eli's memories
- Same cartridge, different substrate

## Why Agent-Specific?

- **Privacy** — each agent's memories are its own
- **Context** — different agents have different experiences
- **Growth** — agents learn independently
- **Safety** — one agent's mistakes don't contaminate others
