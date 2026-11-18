# Session Modes

ANIMA has two separate kinds of "mode". They're easy to mix up because the CLI's `--mode` flag accepts both.

| | Permission mode | Task mode |
|-|-----------------|-----------|
| Values | `plan`, `edit`, `auto` | `chatting`, `programming`, `image`, `private`, `philosophy`, `creative` |
| Type | `PermissionMode` | `TaskMode` (`src/config/types.ts`) |
| Default | `session.defaultMode` in the room config (required) | `chatting`, or what `anima mode` saved in `~/.anima/state.yaml` |
| Used for | The prompt's mode directive, cartridge category, Claude SDK permission mode, auto guard | Picking models in the [router's mode map](../providers/router.md#which-list-it-uses) |

This page is about permission modes.

## Setting the mode

- Room config: `session.defaultMode: plan | edit | auto` (required).
- CLI: `anima talk <agent> "<msg>" --permission edit`. `--mode plan|edit|auto` works too. Any other `--mode` value is read as a task mode.
- Channels and the HTTP API pass a `mode` per request where they support it. Telegram's `/mode` command doesn't change anything yet.

## What a mode changes

### Prompt directive

The static prompt gets a `## Mode` section (`modeDirective()` in `src/agents/prompter.ts`):

| Mode | Directive |
|------|-----------|
| `plan` | "Plan mode — prefer inspection and reasoning." |
| `edit` | "Edit mode — focused changes inside allowed roots, report what changed." |
| `auto` | "Auto mode — act autonomously within allowed roots and tool policy." |

This is an instruction to the model. ANIMA doesn't stop a model in `plan` mode from calling write tools, and "allowed roots" aren't enforced (see [Tool Policy](../tools/policy.md)).

### Cartridge category

When no self-selected category or task pattern matches, `CartridgeLoader.modeToCategory()` maps the mode to a category:

| Mode | Category |
|------|----------|
| `plan` | `think` |
| `edit` | `craft` |
| `auto` | `operate` |

See [Cartridge Activation](../cartridge/activation.md).

### Claude Agent SDK

With the CLI's `claude` provider (`src/providers/anthropic.ts`), the mode becomes the SDK's `permissionMode`: `plan` → `plan`, `edit` → `dontAsk`, `auto` → `auto`.

## Auto mode

Auto mode has two requirements:

1. `session.autoModeOptIn: true` in the room config. Otherwise the session throws `AutoModeNotEnabledError`.
2. `policy.allowedTools` must be set. Config validation fails with `allowedTools required when autoModeOptIn is true`.

In auto mode, every tool call goes through an **auto guard** (`createAutoGuard()` in `src/cli.ts`, and the same pattern in `AgentSession`):

- A tool whose name isn't in `allowedTools` is refused. A `tool_blocked` event with reason `not_in_allowedTools` is written to the event log.
- When the turn ends, an `auto_execution_complete` log line lists the tools used and the number of calls.

The guard checks tool names only. It doesn't look at arguments, paths or cost.

```yaml
session:
  defaultMode: edit
  autoModeOptIn: true
policy:
  allowedTools: [Read, Grep, Glob, Edit]
```
