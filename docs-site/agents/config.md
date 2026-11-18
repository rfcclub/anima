# Agent Configuration

Each agent is configured by one file: `<rooms dir>/<agent>/config.yaml`. The rooms directory is `ANIMA_ROOMS_DIR` if set. See [Rooms](./rooms.md) for the defaults.

`loadRoomConfig()` in `src/config/types.ts` parses the file. It throws `ConfigValidationError` with a message like `missing required field: policy.allowedRoots` or `invalid field: session.defaultMode` when something is wrong. A room that fails to parse is left out of `anima status` and can't be loaded.

## Minimal config

```yaml
identity:
  name: myagent
  label: My Agent
provider:
  type: openai
  model: gpt-4.1-mini
policy:
  allowedRoots: [~/.anima/rooms/myagent]
session:
  defaultMode: plan
boot:
  gene: AGENTS.md
  sessionContext: [MEMORY.md]
```

## Required fields

| Field | Type | Notes |
|-------|------|-------|
| `identity.name` | string | Agent id. Should match the room directory name |
| `identity.label` | string | Display name |
| `provider.type` | string | `claude`, `router`, or a provider id from `providers.d/` |
| `policy.allowedRoots` | string[] | Required, but **not enforced** yet. See [Tool Policy](../tools/policy.md) |
| `session.defaultMode` | `plan` \| `edit` \| `auto` | Default permission mode |
| `boot.gene` | string | Instructions file, injected as `## Instructions` |
| `boot.sessionContext` | list, non-empty | Context files, injected under `## Context` |

## identity

```yaml
identity:
  name: bruno
  label: Bruno
  identityAnchor: "You are Bruno, a cognitive companion."   # optional
```

`identityAnchor` is a short statement the prompter adds near the end of the prompt to keep the agent from drifting. See [Identity](./identity.md).

## provider

```yaml
provider:
  type: anthropic              # provider id, "claude", or "router"
  model: claude-sonnet-4-6     # model id within that provider
  retry: 3                     # optional, attempts before falling back
  fallback:                    # optional, ordered fallback chain
    - { type: gemini, model: gemini-2.5-flash, retry: 2 }
  modeMap:                     # optional, per-task-mode model lists
    programming: [claude-sonnet-4-6@anthropic]
    chatting: [gemini-2.5-flash@gemini]
```

- `modeMap` keys must be task modes: `chatting`, `programming`, `image`, `private`, `philosophy`, `creative`.
- `modeMap` values are `model@provider` references.
- `fallback` entries need `type` and `model`. `retry` is optional.

See [Provider Router](../providers/router.md) for how `retry`, `fallback` and `modeMap` are used.

## policy

```yaml
policy:
  allowedRoots: [/path/to/workspace]
  readOnlyRoots: []
  allowedTools: [read, grep, glob]
  deniedPatterns: []
```

Only `allowedTools` is enforced today. See [Tool Policy](../tools/policy.md).

## session

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `defaultMode` | `plan` \| `edit` \| `auto` | (required) | Permission mode when none is given |
| `autoModeOptIn` | boolean | `false` | Must be `true` before `auto` is allowed. Requires `policy.allowedTools` |
| `compactThreshold` | number | `60000` | Token threshold for session compaction |
| `idleTimeoutMs` | number | none | Session idle timeout |
| `maxTokens` | number | none | Max output tokens |

## boot

```yaml
boot:
  gene: AGENTS.md
  soul: SOUL.md
  sessionContext:
    - MEMORY.md
    - { path: ~/notes/today.md, label: Today, maxChars: 2000 }
  additionalSessionContext:
    - ~/notes/optional.md
  additional:
    - extra/STYLE.md
  extraActions:
    - label: recall
      run: ./scripts/recall.sh
    - Weather: curl -s wttr.in/?format=3     # shorthand { Label: command }
```

| Key | Notes |
|-----|-------|
| `gene` | Required. Injected as `## Instructions`, truncated to 4,000 characters |
| `soul` | Optional. Injected as `## Soul`. In `AgentSession` it goes through the [Identity Engine](../substrate/identity-engine.md) first. CLI `talk` injects it as-is |
| `sessionContext` | Required, non-empty. Each entry is a path or `{ path, label?, maxChars? }`. A missing file is **created empty**. Each file is truncated to `maxChars` (default 4,000) |
| `additionalSessionContext` | Optional. Same entry shape. Missing files are skipped with a warning. Injected as `## Additional Context` |
| `additional` | Optional list of paths, each injected as `## Additional Boot File: <name>` |
| `extraActions` | Optional. Each `run` is executed with `bash -c` when the agent loads, with `ANIMA_ROOM_DIR` set. 15-second timeout, stdout capped at 40,000 characters. Output from actions that exit with `0` is added to `## Memory Recall` |

**Path rules.** `~/` paths expand to your home directory. Absolute paths are used as given. Relative paths resolve against the room directory. For `gene`, `soul` and `additional`, a relative path that escapes the room (for example `../x.md`) is rejected with `boot path escapes room`.

## memory

| Key | Values | Meaning |
|-----|--------|---------|
| `type` | `module` (default), `custom`, `shared` | Which recall adapter to load. See [Memory](../substrate/memory.md) |
| `adapterModule` | path | For `module`: adapter file in the room (default `memory-adapter.js`) |
| `entityScript`, `substrateDir` | path | For `custom` |
| `recallMode` | `normal`, `semantic`, `neural` | Passed to the adapter |
| `topK` | number | Recall result count (CLI default `5`) |
| `recentDays` | number | Passed to the adapter |
| `fallback` | boolean | For `custom` |
| `crossSessionBootstrap` | boolean | Load bootstrap memories at boot and enable the per-agent memory store |
| `recallScope` | `full`, `pin`, `none` | Per-turn recall scope |

## mcp

```yaml
mcp:
  servers:
    - { name: files, command: npx, args: ["-y", "some-mcp-server"], env: { KEY: value } }
```

See [MCP](../tools/mcp.md).

## gate

| Key | Default |
|-----|---------|
| `model`, `fallbackModel` | none |
| `threshold` | `0.7` |
| `peerReview` | `false` |
| `profile` | `standard` (`gentle`, `standard`, `full`) |

## contextManagement

| Key | Default |
|-----|---------|
| `mode` | required: `flat` or `branching` |
| `tokenBudget` | `40000` |
| `protectedWindow` | `10` |
| `summarizeThreshold` | `1500` |
| `stubThreshold` | `300` |
| `ftsHotK` | `5` |
| `summaryModel` | none |

## reflection

```yaml
reflection:
  enabled: true
  intervalMs: 43200000     # default 3600000 (1 hour)
  urgencyThreshold: 3
```

The server's reflection scheduler also accepts the older form `session.reflectionEnabled` and `session.reflectionIntervalHours` (default `4`). If both are present, `reflection:` wins. See [Scheduling](../sessions/scheduling.md).

## continuity

| Key | Meaning |
|-----|---------|
| `incarnationPort` | Opt in to the `IncarnationPort.join()` call site. Default off |
| `identityRuntime` | Use an injected identity runtime. Can't be combined with `incarnationPort` |

## cartridges

```yaml
cartridges:
  universal: [engineering-common-lite]   # always loaded
  defaults: [warmth]                     # tie-break preference
  defaultRole: programmer                # +1 for this role
  selfSelect: null                       # cartridge name or category
  budgetTokens: 5000
  taskPatterns:                          # legacy path: category → keywords
    craft: [fix, implement]
```

`AgentSession` reads these keys to build the [ExecutionPlan](../api/execution-plan.md).

::: warning Known issue: the cartridges block doesn't reach the session
`loadRoomConfig()` builds a new object with only the keys listed above and **drops `cartridges`**. `AgentSession` reads `config.cartridges`, so it always gets an empty object. In practice, `universal`, `defaults`, `defaultRole`, `selfSelect`, `budgetTokens` and `taskPatterns` in `config.yaml` have no effect right now, and every turn uses the single-slot activation path with no agent preferences. This needs a code fix.
:::
