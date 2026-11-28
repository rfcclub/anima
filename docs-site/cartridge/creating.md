# Creating a Cartridge

A cartridge is a Markdown file with YAML frontmatter. `CartridgeRegistry` (`src/cartridge/registry.ts`) reads it.

## Example

```yaml
---
name: my-cartridge          # required
category: craft             # required: craft | think | create | operate
kind: role                  # optional, see Kinds
guides: [skill-name-1]      # skills inlined before the body
rules: [qa-skill-name]      # skills inlined after the guides
requires: [engineering-common-lite]   # dependencies (used when this is the role winner)
conflicts: [other-role]
priority: 10
triggers:
  task: ["refactor", "unit test"]     # substring match in the message
  mode: ["craft"]                     # categories, not plan/edit/auto
retrieval:
  scopes: [project, episode]
  top_k: 8
  max_tokens: 2000
budget_tokens: 3000
memory:
  write_scopes: [project, episode]
---

# My Cartridge

Content that enters the prompt when this cartridge is active.
```

## Frontmatter fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Required |
| `category` | `craft` \| `think` \| `create` \| `operate` | Required. Anything else skips the file |
| `kind` | see [Kinds](./kinds.md) | Optional. An invalid value skips the file |
| `guides` | string[] | Skill names. `skills` is the legacy name, used only when `guides` is empty |
| `rules` | string[] | Skill names |
| `persona` | string | Text inlined after the skills |
| `requires` | string[] | Cartridge names, expanded transitively |
| `conflicts` | string[] | Cartridge names |
| `priority` | number | Tie-breaker and conflict/budget order |
| `triggers.task` | string[] | Case-insensitive substrings of the message |
| `triggers.mode` | string[] | Category names |
| `retrieval` | object | See [Retrieval Policy](../api/retrieval-policy.md) |
| `budget_tokens` | number | Default 5000 |
| `memory.write_scopes` | string[] | Memory scopes this cartridge may write. `identity`, `private` and `heartwood` are locked and fail validation |

Other keys (such as `type` or `description`) are ignored.

When a cartridge is expanded, the parts are joined with `---` in this order: guides (or legacy skills), rules, `persona`, then the body.

## Skills

A name in `guides`, `rules` or legacy `skills` resolves in the project, global and colony root (searched in
that order) in two forms:

| Resolves to | Behaviour |
|-------------|-----------|
| `skills/<name>.md` (flat file) | Legacy: the text after the frontmatter is inlined in full |
| `skills/<name>/SKILL.md` (Agent [Skill](../cartridge/skills.md) directory) | Progressive disclosure: only its name and description enter the prompt; the body loads when the model activates the skill |

A flat file wins over a directory of the same name. A name that resolves to neither is logged as
`[cartridge] <cartridge>: <label> "<name>" not found — skipped`.

Declared Agent Skills are offered only while their cartridge is active, so a work or review profile sees
exactly the skills its cartridges declare. The catalog counts toward `budget_tokens`; an activated body is
counted when it is loaded.

### Migrating a flat guide to a skill directory

```
skills/qa-code.md                      →  skills/qa-code/SKILL.md
```

Move the file into a directory named after the skill and add the required frontmatter — `description` is
what the model sees in the catalog, so write it as a one-line summary of when to use the skill:

```yaml
---
name: qa-code
description: Review a change for correctness, tests and style before it merges.
---

<the old file body, unchanged>
```

The declaration in the cartridge does not change: `guides: [qa-code]` still resolves, now through the
catalog. Do this only when the skill is large enough to justify on-demand loading — a short guide is
cheaper inlined.

## Where to put it

Cartridges are loaded from four tiers. A later tier overrides an earlier one with the same `name` and `category`:

| Tier | Root | Folders |
|------|------|---------|
| Colony | `~/agora` | `cartridges/shared`, `cartridges/pluggable`, `cartridges/dynamic` |
| Global | `~/.anima` | same |
| Project | the project root | same |
| Agent | `<project root>/rooms/<agent>/cartridges` | the folder itself, scope `agent` |

`shared` gives scope `shared`. `pluggable` and the legacy `dynamic` both give scope `pluggable`. The project root is the parent of the rooms directory for the server and channels, and the current directory for `anima cartridge` and `/cartridge`.

## Check it

```bash
anima cartridge validate      # parse errors, locked write scopes, over budget
anima cartridge list          # scope/category/name and path
anima cartridge expand <name> # the expanded text
```

`validate` exits with 1 if anything fails.
