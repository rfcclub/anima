# Reflection Engine — Usage & How It Works

## What it does

The reflection engine runs a periodic autonomous tick loop per enabled agent. Each cycle is:

1. **ORIENT** — load `SOUL.md`, current state, and pending mesh inbox count. Also checks whether someone has sent a **knock** message.
2. **EVALUATE** — compute urgency score:
   - `+min(5, inboxCount)` if unread messages exist
   - `+5` if the agent was **knocked**
3. **DECIDE** — choose an action if score >= threshold:
   - `rest` (default)
   - `post-agora` when inbox has pending messages
   - `message-agent` when knocked
4. **ACT** — update agent state (`in-room`, `visiting:{target}`, etc.) and log intended action.
5. **RECORD** — save the tick to `~/.anima/rooms/_shared/reflection.db`.

## Enabling reflection for an agent

Add to the agent's `rooms/{agent}/config.yaml`:

```yaml
reflection:
  enabled: true
  intervalMs: 3600000   # 1 hour
  urgencyThreshold: 3   # score >= 3 triggers a non-rest action
```

Note: the engine only starts when the ANIMA server restarts.

## How to make one agent knock another

A "knock" forces the target agent to tick immediately and raises its urgency by 5.

### Option 1: send a mesh message with `role: "knock"`

From any colony runtime, use `mesh_send` to the target agent:

```json
{
  "to_id": "anima-eli",
  "pattern": "direct",
  "role": "knock",
  "subject": "knock",
  "content": "Please review the colony-mesh bridge design.",
  "client_msg_id": "optional-idempotency-key"
}
```

The reflection engine treats any pending `role: "knock"` message as a knock.

### Option 2: use the local CLI helper

```bash
bun scripts/reflection-knock.ts eli "Please review the colony-mesh bridge"
```

This publishes a knock message into the mesh database for `anima-eli`.

### Option 3: call from another agent via tool

If the agent has the mesh tools (`mesh_send` etc.), it can send the same payload above directly.

## Observation / reporting

To inspect recent activity without watching logs:

```bash
# All agents, last 48h
bun scripts/reflection-report.ts

# Single agent, last 24h
bun scripts/reflection-report.ts --agent eli --hours 24
```

Output example:

```
## eli
- ticks: 12
- avg urgency: 2.3
- inbox-triggered ticks: 4
- actions:
  - rest: 10
  - post-agora: 2
- recent ticks:
  - [2026-06-25T03:00:00.000Z] inbox=2 score=2/3 decision=rest | rest — no action needed
  - [2026-06-25T02:00:00.000Z] inbox=0 score=0/3 decision=rest | rest — no action needed
```

## What is currently NOT implemented

- Heuristic-based decisions only. The LLM-based DECIDE prompt exists as a stub.
- `message-agent` action does not actually send a mesh message yet; it records intent only.
- `schedule-event` and `start-mission` actions are stubs.
- No web UI for reflection observations yet; use `scripts/reflection-report.ts`.

## Files involved

- `src/continuity/reflection-engine.ts` — engine core
- `src/server.ts` — loads reflection configs from room YAML and starts the scheduler
- `scripts/reflection-knock.ts` — local knock utility
- `scripts/reflection-report.ts` — observation report CLI
- `docs/reflection-engine.md` — this file
