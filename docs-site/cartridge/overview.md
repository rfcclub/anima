# Cartridge System

A **cartridge** is a Markdown file with YAML frontmatter that adds instructions, skills and a memory retrieval policy to an agent's prompt. Cartridges are shared between agents, so a "programming" or "warmth" cartridge is written once and used by any agent that activates it.

## Two activation models

ANIMA has two ways of choosing cartridges for a turn (details in [Activation](./activation.md)):

| | Legacy activation | Execution plan |
|-|-------------------|----------------|
| Function | `resolveActivation()` | `resolveExecutionPlan()` |
| What's loaded | Every `shared` and `agent` cartridge, plus **one** pluggable cartridge chosen by category | **One winner per layer** (persona, role, language, framework, project, task), plus `universal` cartridges and the role's dependencies |
| Used when | Default | The room config's `cartridges:` block sets `universal`, `defaults` or `defaultRole` |

::: warning Known issue
Because `loadRoomConfig()` drops the `cartridges:` block, `AgentSession` currently always uses legacy activation. The execution plan is implemented and tested, but isn't reached from a room config yet.
:::

The execution plan was added because single-slot activation couldn't combine a role, a language and a framework in one turn, and TypeScript, Python and C# all shared `category: craft`, so the first match won.

## Layers

| Layer (`kind`) | What it holds | Repo examples |
|----------------|---------------|---------------|
| `kernel` | Engineering fundamentals. Loaded through `universal` or `requires` only | `engineering-common-lite` |
| `persona` | Interaction style. Base score 1 | `warmth`, `creative` |
| `role` | Kind of work. Its `requires` are expanded | `programming`, `deployment`, `game-design`, `philosophy` |
| `language` | Programming language | `typescript`, `python`, `csharp` |
| `framework` | Framework or domain | none yet |
| `project` | Repo-specific conventions | none yet |
| `review` | QA rules. Scored, but the plan has no slot for it | `qa` |
| `task` | Current task | `visual-novel` |

See [Layers](./layers.md) and [Kinds](./kinds.md).

## Example

Message: "fix the failing test in the python parser", using the execution plan with `universal: [engineering-common-lite]`:

```
universal:          [engineering-common-lite]
interactionPersona: creative     ← ties with warmth at 1, wins by name
workingRole:        programming  ← "fix" matches triggers.task (+10)
dependencies:       []           ← requires programming-kernel, which isn't in the repo
language:           python       ← "python" matches triggers.task (+10)
framework/project/task: none
```

## A cartridge file

```yaml
---
name: programming
category: craft              # required: craft | think | create | operate
kind: role
requires:
  - programming-kernel
retrieval:
  scopes: [project, episode]
  top_k: 8
  max_tokens: 2000
triggers:
  task: ["debug", "fix", "refactor", "deploy", "build", "implement", "code", "test", "optimize"]
---

# Programming

Content that enters the prompt when this cartridge is active.
```

All fields are listed in [Creating a Cartridge](./creating.md#frontmatter-fields).

## Scoring summary

| Signal | Points |
|--------|--------|
| `triggers.task` substring in the message | +10 |
| `taskPatterns` keyword for the cartridge's category | +5 (legacy loader input; not passed by the execution plan) |
| `triggers.mode` contains the mode's category | +3 |
| `selfSelect` = name / category | +2 / +1 |
| `defaultRole`, `defaults`, recent task | +1 each |
| `priority` | × 0.01 |

There are no conflict or budget penalties in the score. Conflicts and the budget gate are applied after scoring. See [Activation](./activation.md#scoring).

## Dependencies

`requires:` is expanded transitively, with a cycle guard. Only the role winner's dependencies are expanded. Missing names are skipped without a warning.

```
reviewer.requires         = [programming-kernel, qa-review-common]
qa-review-common.requires = [qa-code]
→ dependencies: [programming-kernel, qa-review-common, qa-code]
```

## Migration from older cartridges

| Older form | Current form | What happens |
|------------|--------------|--------------|
| `skills: [a, b]` | `guides: [a]`, `rules: [b]` | `skills` is used as guides when `guides` is empty |
| No `kind` | `kind: role` (etc.) | Accepted, but never wins a layer in the execution plan |
| `category: social` or another off-list value | One of `craft`, `think`, `create`, `operate` | **The file is skipped** with an `invalid category` warning |
| `cartridges/dynamic/` | `cartridges/pluggable/` | Both are loaded as `pluggable` |
