# Castle System

"Castle" names two things in ANIMA:

1. A **live layer** that runs today: reflection ticks, the activation broker, presence and movement, and the garden event log behind the Web UI's castle feed.
2. A **planned autonomous work loop**: Garden Hub, a GitHub-driven game loop, loop engineering and the autonomy ladder.

## What runs today

| Part | Where | Notes |
|------|-------|-------|
| Reflection loop | `src/continuity/reflection-engine.ts` | One `TickRunner` per agent. See [Scheduling](../sessions/scheduling.md#reflection-loop) |
| Activation layer | `src/continuity/activation-*.ts` | Controlled by `ANIMA_ACTIVATION_MODE` (`off`, `shadow`, `gate`, `enforce`). In `gate`/`enforce`, a tick needs a grant from the broker to act |
| Presence and movement | `src/continuity/ambient-movement.ts`, `movement-resolver.ts` | The `move` reflection action (`wander`, `home`, `seek`) |
| Garden event log | `<rooms>/_shared/garden/events.jsonl` | Append-only (`JsonlGardenEventStore`). The castle UI feed and replay read it |
| Town/Castle sessions | Web UI | Noon beam flush and the 22:00 send-agents-home job. See [Scheduling](../sessions/scheduling.md#wall-clock-jobs) |

## Planned: autonomous work loop

::: info Planned
Everything in this section is designed but not running. Some building blocks exist in `src/garden/` (`hub.ts`, `tick-engine.ts`, `autonomy-ladder.ts`, `programming-loop.ts`), but the server doesn't start them.:::

### Garden Hub

The intended control plane for the colony:

- **Identity:** agent registry and external identities (GitHub machine accounts)
- **Autonomy ladder:** a level per (agent, action class)
- **Work protocol:** issue → claim → worktree → PR → review → merge

### Game loop

The intended tick engine for autonomous work:

```
Every tick:
  1. Evaluate work signals (GitHub issues, PRs, CI failures)
  2. Claim a task (if eligible)
  3. Execute in an isolated worktree
  4. Open a PR with attribution
  5. Request a cross-agent review
  6. Merge if CI passes and the reviewer approves
```

### Autonomy ladder

`AutonomyLadder` (`src/garden/autonomy-ladder.ts`) implements the levels, but nothing in the running system uses it yet.

Action classes: `code-change`, `deploy`, `substrate-write`, `identity-change`, `review`.

| Level | Intended behavior | Reached after |
|-------|-------------------|---------------|
| L0 | Human approval required | Default |
| L1 | Auto-approve with notification | 10 successes with no violations |
| L2 | Auto-approve, audit later | 50 successes with no violations |
| L3 | Full autonomy | 100 successes, plus a peer review |

A violation moves the agent down one level and resets its counts. Level changes are written to the garden event log.

See also [Tool Permissions](../tools/permissions.md), where the ladder is also marked Planned.

### GitHub work protocol

```
Issue (label: ready)
  → Agent claims the issue
  → Isolated worktree
  → Implementation
  → PR linked to the issue
  → Cross-agent review (maker/checker)
  → CI
  → Merge if everything passes
```
