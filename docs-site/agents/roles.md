# Roles

A role is a [cartridge](../cartridge/overview.md) with `kind: role`. It describes the kind of work the agent is doing, such as programming or deployment.

## Default role and working role

- The **default role** is what the agent usually does. It's set with `cartridges.defaultRole` in `config.yaml`.
- The **working role** is the role cartridge that wins for this turn. It's usually the default role, but a strong trigger in the message can pick another.

```yaml
cartridges:
  defaultRole: programming
```

::: warning Known issue
`loadRoomConfig()` currently drops the `cartridges:` block, so `defaultRole` doesn't reach the session yet. See [Agent Config](./config.md#cartridges).
:::

## How the working role is picked

`resolveExecutionPlan()` scores every `kind: role` cartridge with `CartridgeLoader.resolveLayer("role", ...)` and takes the top score. The default role only adds `+1`, so any task-trigger match (`+10`) beats it. See [Activation](../cartridge/activation.md#scoring) for the full scoring rules.

## Dependencies

A role can list other cartridges in `requires:`. When the role wins, those cartridges are added to the plan as dependencies, recursively, with a cycle guard. A name in `requires:` that isn't a cartridge is skipped.

```yaml
kind: role
name: programming
requires: [programming-kernel]
```

Inlined skills are different. `guides:` and `rules:` name files in `skills/`, which are inlined into the cartridge text when it's expanded.

## Role cartridges in this repo

| Name | File | Category |
|------|------|----------|
| `programming` | `cartridges/shared/programming.md` | `craft` |
| `deployment` | `cartridges/shared/deployment.md` | `operate` |
| `game-design` | `cartridges/shared/game-design.md` | `create` |
| `philosophy` | `cartridges/shared/philosophy.md` | `think` |

More roles can come from the colony tier (`~/agora/cartridges/`), the global tier (`~/.anima/cartridges/`), or an agent's own `cartridges/` directory. Run `anima cartridge list` to see what's available on your machine.
