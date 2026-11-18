# Rooms

A **room** is an agent's home directory: `<rooms dir>/<agent>/`. The directory name is the agent name that `AgentLoader.load(name)` and the HTTP and UI routes use.

## Where rooms live

| Component | Rooms directory |
|-----------|-----------------|
| CLI and `AgentLoader` default | `$ANIMA_ROOMS_DIR`, else `~/.anima/rooms` |
| Server (`src/server.ts`) and Web UI | `$ANIMA_ROOMS_DIR`, else `./rooms` in the working directory |
| Meeting room (`anima meet`) | Always `~/.anima/rooms` |

Set `ANIMA_ROOMS_DIR` so every component uses the same directory.

## What's in a room

Only `config.yaml` and the boot files it names are required. Everything else is created by the runtime or is optional.

```
<rooms dir>/myagent/
├── config.yaml           # required, see Agent Config
├── AGENTS.md             # boot.gene (name is up to you)
├── SOUL.md               # boot.soul (optional)
├── MEMORY.md             # a boot.sessionContext entry, created empty if missing
├── mount/                # optional; the server's /status reports "missing" without it
├── substrate.map.yaml    # optional substrate map (see Mapping Guide)
├── memory-adapter.js     # optional, for memory.type: module
├── cartridges/           # optional agent-tier cartridges
├── sessions/             # legacy JSONL event logs (YYYY-MM-DD.jsonl)
└── staging/              # dream pipeline input and output
    ├── beams/
    ├── wounds/
    └── dreams/
```

The rooms directory also has shared entries. Names that start with `_` are not agents. `AgentLoader.list()` skips them.

| Path | Used for |
|------|----------|
| `_shared/memory.db` | `memory.type: shared` adapter |
| `_shared/garden/events.jsonl` | Garden event log (activation audit) |
| `_meeting/` | Meeting transcripts (under `~/.anima/rooms`) |
| `staging/` | Schedule markers for deep dream, the lucid dream sweep, and the Town/Castle jobs |

## How a room loads

`AgentLoader.load(name)` in `src/agents/loader.ts`:

1. Reads and validates `config.yaml`. A missing file throws `RoomNotFoundError`.
2. Reads `boot.gene`, `boot.soul`, `boot.sessionContext`, `boot.additionalSessionContext` and `boot.additional`. A required boot file that can't be read throws `SubstrateNotMountedError`, which `anima status` shows as `mount: fail`.
3. Runs `boot.extraActions`.
4. Loads the memory adapter (`memory.type`) and, if `memory.crossSessionBootstrap` is on, the bootstrap memories.
5. Creates the cross-session memory store and the conversation context engine.
6. Loads a substrate map from the first one that exists: `<room>/substrate.map.yaml`, `$ANIMA_AGENT_SOURCE_DIR/<name>/substrate.map.yaml` (default `~/agora/familia`), or, for `bruno`, `$ANIMA_SUBSTRATE_DIR/substrate.map.yaml`.

## Creating a room

See [Getting Started](../guide/getting-started.md#create-a-room) for a step-by-step example, and [Agent Config](./config.md) for every key. For the known colony agents, `anima seed <agent> <substrate-path>` scaffolds a room from a substrate directory (see the [CLI Reference](../cli/reference.md#seed)).
