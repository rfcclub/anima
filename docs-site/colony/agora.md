# Agora

"Agora" is used for two related things:

1. `~/agora/`, a shared folder on the host that several parts of ANIMA read from.
2. `AgoraClient` (`src/agora/client.ts`), an in-process event bus that the server creates at startup.

## The `~/agora/` folder

ANIMA doesn't create this folder. When it exists, these paths are used:

| Path | Used by | Purpose |
|------|---------|---------|
| `~/agora/cartridges/{shared,pluggable,dynamic}/` | `CartridgeRegistry` | Colony tier: the lowest-priority [cartridge tier](../cartridge/creating.md#where-to-put-it) |
| `~/agora/skills/<name>.md` | `CartridgeRegistry.readSkill()` | Skills, searched after the project and global tiers |
| `~/agora/familia/<agent>/substrate.map.yaml` | `AgentLoader` | Agent substrate map, used if the room has no `substrate.map.yaml`. Override the `familia` folder with `ANIMA_AGENT_SOURCE_DIR` |
| `~/agora/hive/pulse-anima/` | Reflection engine | Scripts and output for the pulse-anima dispatcher |

Example layout:

```
~/agora/
├── cartridges/
│   └── shared/           # colony-wide cartridges
├── skills/
├── familia/
│   ├── myagent/
│   │   └── substrate.map.yaml
│   └── ...
└── hive/
    └── pulse-anima/
```

See the [Mapping Guide](../substrate/mapping-guide.md) for the substrate map format.

## AgoraClient

When the server starts (`startServer()`), it creates an `AgoraClient` unless one is passed in:

1. **Legio detection:** for each of `codex`, `qwen` and `gemini`, it runs `which <name>`. Each CLI that's found is registered as a "legio" (an external worker) with a starting trust score of 0.5.
2. **Default handlers:** `installDefaultHandlers()` subscribes to the event types below, logging each one and, for completed tasks, running the evaluation pipeline when one is configured.
3. The client is handed to `ANIMA.initialize()`, and the server logs `agora client initialized` with the number of legios.

Event types (`AgoraEventType` in `src/agora/types.ts`): `task_assigned`, `task_complete`, `task_failed`, `task_blocked`, `agent_online`, `agent_offline`.

The client also has `on`, `off`, `emit`, `selectLegio`, `requestLegio`, `registerLegio`, `unregisterLegio`, `setLegioAvailability` and `getColonyState`. Trust and escalation come from `TrustSystem` and `EscalationSystem` in `src/evaluation/`.

## The `post-agora` reflection action

An agent's reflection tick can choose `post-agora`. This doesn't write to `~/agora/`. It records a thread from the agent to `agora` in the shared narrative store (`<rooms>/_shared/memory.db`). See [Scheduling](../sessions/scheduling.md#reflection-loop).
