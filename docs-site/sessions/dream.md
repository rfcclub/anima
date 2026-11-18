# Dream System

"Dreaming" is how ANIMA turns session activity into material the agents can reflect on later. It's file-based: the outputs are Markdown files under `staging/` directories, and nothing here changes an agent's soul or substrate.

| Stage | Class | When | Output |
|-------|-------|------|--------|
| Light nap | `LightNap` (`src/dream/light-nap.ts`) | When a session closes | `<room>/staging/beams/<date>.md` |
| Deep dream | `DeepDream` (`src/dream/deep-dream.ts`) | Daily, 23:00 | `<rooms>/staging/dreams/<date>.md` |
| Lucid dream | `LucidDream` (`src/dream/lucid-dream.ts`) | `POST /dream`, or the weekly sweep | `<room>/staging/dreams/lucid-<timestamp>.md` |
| Lucid dream sweep | `LucidDreamSweep` (`src/dream/lucid-dream-sweep.ts`) | Weekly, Sunday 01:00 | One lucid dream per agent |

`<rooms>` is the rooms directory and `<room>` is one agent's room. Schedules use the server's local time. See [Scheduling](./scheduling.md).

## Light nap: beams

When a session closes (`SessionLifecycle` in `src/session/lifecycle.ts`), `LightNap.run()` goes through the session's events. Any event whose text contains one of the keywords `insight`, `learned`, `discovered`, `realized` or `pattern` becomes a **beam**. Beams are appended to `<room>/staging/beams/<YYYY-MM-DD>.md` as `## Beam — <timestamp>` entries with the keywords, source event type and content.

Web UI sessions write beams through `lightNapFromTurns()` (`src/session/cross-session-memory.ts`) when they end, and through the noon flush.

Light naps run in the background. A failure is logged as `light_nap_error` and doesn't affect the session.

## Deep dream

Every day at 23:00, `DeepDream.run(roomsDir)`:

1. Lists the agents (folders in `<rooms>` with a `config.yaml`, skipping names that start with `.` or `_`).
2. Reads each agent's beams for yesterday and today. If an agent has no beam files, it falls back to recent entries from `~/.anima/agents/<agent>/memory.db` (`$ANIMA_HOME` if set).
3. Cross-references beams between agents by shared keywords.
4. Writes one report to `<rooms>/staging/dreams/<YYYY-MM-DD>.md` with each agent's beams and the cross-agent links.

Progress is saved to `<rooms>/staging/.dream-state.json`. If a run fails partway, the next run continues from the agent that failed.

## Lucid dream

A lucid dream is one reflection by one agent:

1. Reads deep dream reports from the last 3 days. Only if there are none does it read the agent's own beams from the last 3 days.
2. Adds the agent's crossing context, if any (`CrossingManager`).
3. Sends a reflection prompt to the agent's provider in `plan` mode.
4. Writes `<room>/staging/dreams/lucid-<timestamp>.md`. Only the 5 newest lucid dream files are kept.

When a memory store is available, the reflection is also saved through `AgentMemoryStore.remember()`.

### On demand

```bash
curl -X POST http://127.0.0.1:3700/dream \
  -H 'Content-Type: application/json' \
  -d '{"agent": "bruno", "prompt": "What did you learn this week?"}'
```

- `agent` is required and must match `[a-zA-Z0-9_-]+`. The response is `404` if the room doesn't exist.
- `prompt` is optional. The default is "Reflect on your recent experience."
- The response is `{ "agent": "...", "reflection": { ... } }`.

### Lucid dream sweep

Every Sunday at 01:00, `LucidDreamSweep` runs a lucid dream for each agent with a fixed review prompt. Progress is saved to `<rooms>/staging/.lucid-sweep-state.json`. If one agent fails, the sweep stops and continues from that agent next time.

## Cross-agent reflections

`POST /colony/reflect` with `{ "from", "about", "content" }` (all required) stores a "Cross-Agent Reflection" as a beam in the `about` agent's room via `StagingManager.writeBeam()`.

## Staging layout

```
<rooms>/
├── staging/
│   ├── dreams/<YYYY-MM-DD>.md        # deep dream reports
│   ├── .dream-state.json
│   ├── .lucid-sweep-state.json
│   └── .*-schedule.json              # wall-clock markers
└── <agent>/staging/
    ├── beams/<YYYY-MM-DD>.md         # light nap beams
    ├── wounds/<YYYY-MM-DD>.md        # StagingManager.writeWound()
    └── dreams/lucid-<timestamp>.md   # lucid dreams
```

`StagingManager` (`src/continuity/staging.ts`) has `write`, `writeBeam`, `writeWound`, `list`, `summary` and `hasPending` for these folders.

## Tick Engine integration

::: info Planned
Driving dreams from the Garden `TickEngine` isn't wired up. The server doesn't start a tick engine (see [Scheduling](./scheduling.md#tick-engine-and-garden-hub)).
:::
