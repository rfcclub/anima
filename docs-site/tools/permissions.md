# Agent Permissions

This page covers the controls that decide what an agent may do, and how much of each one is enforced today.

| Layer | Where it's set | Enforced today |
|-------|---------------|----------------|
| [Tool policy](./policy.md) | `policy:` in `config.yaml` | `allowedTools` by the auto guard. Roots and patterns are checked by `PolicyEnforcer`, by default in `warn` mode (see [Tool policy](./policy.md)) |
| Permission mode | `session.defaultMode`, `--permission` | Prompt directive. The Claude provider also maps it to the SDK's permission mode |
| Auto opt-in | `session.autoModeOptIn` | Yes. `auto` is refused without it |
| Auto guard | Automatic in `auto` mode | Yes, by tool name |
| Autonomy ladder | `src/garden/autonomy-ladder.ts` | No. The module exists but isn't wired into the runtime |

## Permission modes

`PermissionMode` is `"plan" | "edit" | "auto"` (`src/config/types.ts`). Each room sets `session.defaultMode`. The CLI can override it per call with `--permission`.

What the mode changes:

- **Prompt directive.** `modeDirective()` in `src/agents/prompter.ts` adds one line:
  - `plan`: "Plan mode — prefer inspection and reasoning."
  - `edit`: "Edit mode — focused changes inside allowed roots, report what changed."
  - `auto`: "Auto mode — act autonomously within allowed roots and tool policy."
- **Claude Agent SDK provider.** `src/providers/anthropic.ts` maps `plan` to the SDK's `plan` mode, `edit` to `dontAsk`, and `auto` to `auto`.
- **Cartridge lane.** The mode maps to a cartridge category: `plan` to `think`, `edit` to `craft`, `auto` to `operate`. See [Activation](../cartridge/activation.md).
- **Auto guard.** Only `auto` turns on the per-call guard described below.

The mode doesn't change which tools are offered. For providers other than the Claude SDK, `plan` and `edit` only change the prompt.

## Auto mode

Auto mode needs two things in `config.yaml`:

```yaml
session:
  defaultMode: auto        # or pass --permission auto
  autoModeOptIn: true
policy:
  allowedTools: [read, grep, glob]   # required when autoModeOptIn is true
```

- Without `autoModeOptIn: true`, a request for `auto` fails with `AutoModeNotEnabledError`.
- Setting `autoModeOptIn: true` without `allowedTools` fails config loading.
- In `auto` mode, each tool call goes through the auto guard. A tool that isn't in `allowedTools` is refused and logged as a `tool_blocked` event with reason `not_in_allowedTools`.

The guard checks tool names only. It doesn't detect destructive commands, check budgets or ask for approval.

## Autonomy ladder

::: info Planned
`src/garden/autonomy-ladder.ts` implements a per-agent, per-action ladder, but the runtime doesn't use it yet. Only tests create an `AutonomyLadder` or a `GardenHub`. Nothing below affects what an agent can do today.
:::

The module defines:

- **Levels** `0` to `3`.
- **Action classes** `code-change`, `deploy`, `substrate-write`, `identity-change`, `review`.
- **Promotion thresholds**: cumulative successes with no violations. 10 to reach L1, 50 to reach L2, 100 to reach L3 (L3 also needs peer review).
- **Seeds** in `src/garden/autonomy-seed.ts`: an optional per-agent table of starting levels. Agents without a seed start at L0.

See [Castle System](../misc/castle-system.md) for the larger plan this belongs to.
