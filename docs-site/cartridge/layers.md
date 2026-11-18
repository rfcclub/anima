# Layers

When the [execution plan](./activation.md#execution-plan) is used, ANIMA picks at most one cartridge per layer, independently, in this order:

| Layer | How it's chosen | Dropped when over budget? |
|-------|-----------------|---------------------------|
| Kernel | Only through `universal` or the role's `requires` | No |
| Persona | Scored, with a base score of 1 so a persona usually wins | No |
| Role | Scored. Its `requires` are expanded as dependencies | No |
| Language | Scored | Yes |
| Framework | Scored | Yes |
| Project | Scored | Yes |
| Task | Scored | Yes |

The `review` kind is scored too, but the plan has no slot for it.

## Cartridges in this repo

| Folder | Cartridge | Kind |
|--------|-----------|------|
| `cartridges/shared` | `engineering-common-lite` | kernel |
| | `warmth`, `creative` | persona |
| | `programming`, `deployment`, `game-design`, `philosophy` | role |
| | `qa` | review |
| `cartridges/pluggable` | `typescript`, `python`, `csharp` | language |
| | `visual-novel` | task |
| `cartridges/dynamic` | `writing`, `proofreading` | none |

There are no `framework` or `project` cartridges in the repo. You add your own in any [tier](./creating.md#where-to-put-it).

## Example

A message "refactor the parser in TypeScript" with a `programming` role that triggers on "refactor" and a `typescript` language cartridge that triggers on "typescript":

- Persona: `creative` and `warmth` both have only the base score of 1, and ties go to the name that sorts first, so `creative` wins. Add `warmth` to `defaults` to make it win instead
- Role: `programming` (+10). It `requires` `programming-kernel`, which isn't in the repo, so no dependency is added. Missing dependencies are skipped without a warning
- Language: `typescript` (+10)
- Framework, project, task: nothing, because no candidate scored above 0

The result is a plan with `interactionPersona`, `workingRole` and `language` set. See [ExecutionPlan](../api/execution-plan.md).
