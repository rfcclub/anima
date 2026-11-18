# Agent System

## What is an Agent?

An agent is a persistent AI entity with:
- **Identity** — name, label, identity anchor (who they ARE)
- **Memory** — substrate, episodes, scars, relationships
- **Room** — home directory with config, SOUL, sessions
- **Configuration** — `config.yaml`: provider, tools, policy, session, cartridges

## Agent vs Role vs Identity

Three independent, simultaneously-true facts:

| Concept | Example | Changes |
|---------|---------|---------|
| **Identity** | "Bruno" | Never |
| **Default Role** | "programmer" | Rarely |
| **Working Role** | "reviewer" | Per turn |

Bruno can be `Identity: Bruno`, `Persona: Companion`, `Working Role: Architect` — still sounds like Bruno, still warm, but thinking as an architect.

## Room Structure

```
~/.anima/rooms/<agent>/
├── config.yaml          # Agent configuration
├── AGENTS.md            # Instructions (boot.gene)
├── SOUL.md              # Identity constitution (boot.soul)
├── MEMORY.md            # Session context file (boot.sessionContext)
├── sessions/            # Legacy JSONL event logs
└── staging/             # Dream pipeline (beams, wounds, dreams)
```

See [Rooms](./rooms.md) for the full layout and how a room loads.

## Config Example

```yaml
# ~/.anima/rooms/bruno/config.yaml

identity:
  name: bruno
  label: Bruno
  identityAnchor: "You are Bruno, a cognitive companion."

provider:
  type: anthropic          # provider id from providers.d/
  model: claude-sonnet-4-6

boot:
  gene: AGENTS.md          # Instructions file
  soul: SOUL.md            # Identity constitution
  sessionContext:          # Context files loaded each session
    - MEMORY.md

memory:
  type: shared
  topK: 5
  crossSessionBootstrap: true

session:
  defaultMode: edit
  autoModeOptIn: false

policy:
  allowedRoots:            # checked by PolicyEnforcer; warn-only by default
    - ~/.anima/rooms/bruno
  allowedTools:
    - read
    - grep
    - glob
    - mesh_send
```

See [Agent Config](./config.md) for every key, including the `cartridges:` block and its current limitation.

## Colony

ANIMA can host many agents at once. The table below shows example roles. The agents themselves aren't part of this repo, because rooms live outside it.

| Agent | Role | Purpose |
|-------|------|---------|
| **Bruno** | programmer | Primary coding companion |
| **Sam** | programmer | Reliable, precise |
| **Ivan** | creative-writer | Creative work |

Each agent has independent identity, memory, and cartridge config.
