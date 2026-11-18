# Activation

Activation decides which cartridges go into the prompt for a turn. `AgentSession` (`src/agents/session.ts`) has two paths:

| Path | Function | Used when |
|------|----------|-----------|
| Legacy activation | `resolveActivation()` | Default |
| Execution plan | `resolveExecutionPlan()` | The room config's `cartridges:` block sets `universal`, `defaults` or `defaultRole` |

Both are in `src/cartridge/activation.ts`. Neither runs when `continuity.identityRuntime` is enabled.

::: warning Known issue
`loadRoomConfig()` doesn't keep the `cartridges:` block from `config.yaml`, so in `AgentSession` the agent's cartridge config is always empty. As a result the legacy path is the one that runs today, and `selfSelect`, `taskPatterns`, `budgetTokens`, `defaultRole`, `defaults` and `universal` have no effect there.
:::

## Legacy activation

1. Every cartridge with scope `shared` or `agent` goes into the prompt as a base block.
2. One pluggable cartridge is picked:
   - an explicit override (`/cartridge <name>`) wins;
   - otherwise `CartridgeLoader.resolveWithSource()` picks a **category**: `selfSelect` if it's a category, then `taskPatterns` keywords in the message, then the [permission mode](../sessions/modes.md#cartridge-category) (`plan` → `think`, `edit` → `craft`, `auto` → `operate`);
   - the first pluggable cartridge with that category is used.
3. Budget check: if the base blocks plus the chosen cartridge are over budget (`budgetTokens`, else the cartridge's `budget_tokens`, else 5000), the cartridge isn't added and a `cartridge_budget_exceeded` event is logged. `force` skips this check.
4. A `cartridge_activated` event records the name and why it was picked (`override`, `self-select`, `task` or `mode`).

## Execution plan

```
Turn arrives
  → Inject universal cartridges (by name)
  → For each layer kind except kernel: score candidates, take the top one
  → Expand the role winner's `requires` (transitively)
  → Resolve conflicts between layer winners
  → Budget gate: drop language/framework/project/task if over budget
  → Compile the substrate retrieval plan
```

An override forces that cartridge to win its kind. An override of `null` turns off all layer winners. Universal cartridges and dependencies still apply.

### Scoring

`CartridgeLoader.resolveLayer()` (`src/cartridge/loader.ts`) scores each cartridge whose `kind` matches the layer:

| Signal | Points |
|--------|--------|
| Persona base (persona layer only) | 1 |
| A `triggers.task` string appears in the message | +10 (first match only) |
| `triggers.mode` contains the mode's **category** (no task match) | +3 |
| A `taskPatterns[category]` keyword appears in the message (no task match) | +5 |
| `selfSelect` equals the cartridge name | +2 |
| `selfSelect` equals the cartridge category | +1 |
| Name equals `defaultRole` | +1 |
| Name is in `defaults` | +1 |
| Name is in the recent tasks from the event log | +1 |
| `priority` | + priority × 0.01 |

Only cartridges with a score above 0 are candidates. The highest score wins, and ties go to the name that sorts first. There are no conflict or budget penalties in the score. `resolveExecutionPlan()` doesn't pass `taskPatterns`, so the +5 signal doesn't apply on this path.

::: tip Mode triggers use categories
`triggers.mode` is compared with the category (`think`, `craft`, `create`, `operate`), not with `plan`/`edit`/`auto`. A trigger such as `mode: ["edit", "auto"]` never matches.
:::

### Conflicts

If one layer winner lists another winner in `conflicts`, the one with the higher `priority` stays (ties keep the one that declared the conflict). A `cartridge_conflict` event names the winner and the dropped cartridge. Within a layer, candidates named in the top candidate's `conflicts` are removed.

### Budget gate

The limit is `budgetTokens`, default **5000**. If the estimated total is over the limit:

1. Language, framework, project and task winners can be dropped. Universal, dependencies, persona and role are protected.
2. Droppable layers are dropped lowest `priority` first, each with a `cartridge_budget_exceeded` event.
3. If the protected layers alone are still over, `cartridge_budget_unrecoverable` is logged and they're kept.

## Events

All activation events go to the agent's event log with the session id: `cartridge_activated`, `cartridge_override_missing`, `cartridge_conflict`, `cartridge_budget_exceeded`, `cartridge_budget_unrecoverable`.
