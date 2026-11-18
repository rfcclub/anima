# Scheduling & Background Jobs

When `bun run src/server.ts` starts, the server sets up a few background jobs. They all run inside the server process. There's no separate scheduler daemon.

| Job | Schedule (server's local time) | Code |
|-----|------------------|------|
| Reflection loop | Per agent, every `intervalMs` / `reflectionIntervalHours` | `ReflectionScheduler`, `src/continuity/reflection-engine.ts` |
| Town noon beam flush | Daily, 12:00 | `src/server.ts` |
| Send agents home | Daily, 22:00 | `src/server.ts` |
| Deep dream | Daily, 23:00 | `DeepDream`, `src/dream/deep-dream.ts` |
| Lucid dream sweep | Weekly, Sunday 01:00 | `LucidDreamSweep`, `src/dream/lucid-dream-sweep.ts` |

## Wall-clock jobs

The daily and weekly jobs don't use a 24-hour `setInterval`. A timer checks every 5 minutes, and `fireDailyIfDue()` / `fireWeeklyIfDue()` (`src/continuity/wall-clock-schedule.ts`) decide whether to run:

- A job fires when the local hour equals its target hour (and, for weekly jobs, the weekday matches), and it hasn't fired yet that day.
- The last run is stored in a marker file under `<rooms>/staging/`, so a restart doesn't make a job run twice:
  - `.deep-dream-schedule.json`
  - `.lucid-sweep-schedule.json`
  - `.town-noon-flush-schedule.json`
  - `.town-send-home-schedule.json`
- If the server is down for the whole target hour, that day's run is skipped. Missed runs aren't caught up later.

What each job does:

- **Town noon flush (12:00):** writes a beam from each agent's open Web UI ("Town"/"Castle") session so far, without ending the session.
- **Send agents home (22:00):** closes each agent's open `ui` session. Closing runs the session-end handler (cross-session memory summary and light nap), so the next day starts a fresh session.
- **Deep dream (23:00):** see [Dream System](./dream.md#deep-dream).
- **Lucid dream sweep (Sunday 01:00):** see [Dream System](./dream.md#lucid-dream-sweep).

## Reflection loop

At startup the server calls `loadReflectionAgents(roomsDir)` (`src/continuity/reflection-config.ts`). It scans `<rooms>/*/config.yaml` (skipping folders that start with `_`) and accepts either of two config shapes:

```yaml
# Shape 1 — wins if both are present
reflection:
  enabled: true
  intervalMs: 43200000     # default 3600000 (1 h), rounded to whole hours, minimum 1
  urgencyThreshold: 3      # default 3
```

```yaml
# Shape 2
session:
  reflectionEnabled: true
  reflectionIntervalHours: 12   # default 4
  urgencyThreshold: 3
```

If no agent enables reflection, the server logs `reflection scheduler has ZERO agents` as an error and keeps running.

`ReflectionScheduler` creates one `TickRunner` per agent. Each tick:

1. **Orient:** gathers context such as unread mesh messages and whether the agent was knocked.
2. **Evaluate:** scores urgency. Unread messages add `min(5, 3 × count)` and a knock adds 5.
3. **Decide:** below the threshold, the agent rests. Otherwise the agent's provider is asked to choose one action, parsed by `parseReflectionAction()`.
4. **Act and record:** runs the action and records an observation.

A tick runs on the timer, or right away when a mesh message with role `knock` arrives for the agent (see [Mesh channel](../channels/mesh.md)). Only one tick runs at a time per agent.

The possible actions (`ReflectionAction`) are: `rest`, `message-agent`, `schedule-event`, `start-mission`, `post-agora`, `move`, `convene-meeting`, `join-meeting`, `speak` and `expedition`.

### Activation mode

`ANIMA_ACTIVATION_MODE` (`off` by default, or `shadow`, `gate`, `enforce`) controls the shared activation layer. In `gate` and `enforce`, a tick can only act if it claims a grant from the activation broker. Otherwise it rests. An invalid value stops the server with `invalid activation mode`.

## Tick Engine and Garden Hub

::: info Planned
`TickEngine` (`src/garden/tick-engine.ts`) and `GardenHub` (`src/garden/hub.ts`) exist in the code base, but the server doesn't create or start them. Colony task dispatch through a tick engine isn't running yet.
:::

## Checking what's running

- `GET /status` returns `{ "agents": [...] }`, the agents found in the rooms directory.
- The server logs JSON lines such as `reflection scheduler started`, `lucid dream sweep completed` and `town/castle noon beam flush completed`.

```bash
curl http://127.0.0.1:3700/status
```

## Shutdown

On `SIGTERM` or `SIGINT`, the server stops its mesh listeners and releases the shared writer lock. The timers above have no separate shutdown step. They end with the process.
