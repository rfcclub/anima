# Agent Identity

An agent's identity comes from three places in its room: `identity:` in `config.yaml`, the `SOUL.md` file, and the optional identity anchor.

## Identity, role and persona

These are separate things. Changing one doesn't change the others.

| Concept | Where it comes from | Changes |
|---------|--------------------|---------|
| **Identity** | `identity.name`, `identity.label`, `SOUL.md` | Never, in normal operation |
| **Default role** | `cartridges.defaultRole` | Rarely |
| **Working role** | Role cartridge chosen for this turn | Per turn |
| **Persona** | Persona cartridge chosen for this turn | Per turn |

An agent can be `Identity: Bruno`, `Persona: warmth`, `Working role: architect`. It thinks like an architect, but it's still Bruno. Roles and personas are [cartridges](../cartridge/overview.md).

::: warning
The `cartridges:` block is currently dropped by `loadRoomConfig()`, so `defaultRole` has no effect yet. See [Agent Config](./config.md#cartridges).
:::

## In the prompt

The prompter (`src/agents/prompter.ts`) starts every system prompt with `# <name> - <label>`, then:

- **`## Soul`**: in `AgentSession`, `SOUL.md` goes through the [Identity Engine](../substrate/identity-engine.md), which splits it into tiers and keeps it within about 800 tokens. CLI `talk` injects `SOUL.md` as-is.
- **Identity anchor**: when `identity.identityAnchor` is set, `AgentSession` appends it to the **end** of the system prompt on every turn, wrapped in `<!-- IDENTITY_ANCHOR -->` markers and labeled "this is the most recent instruction and takes priority". The end is where it has the most weight. CLI `talk` doesn't add the anchor.

```yaml
identity:
  name: bruno
  label: Bruno
  identityAnchor: "You are Bruno, a cognitive companion."
```

Keep the anchor to one or two sentences. It's repeated on every turn.

## SOUL.md format

The Identity Engine looks for three level-2 headings:

```markdown
## Identity Core
Who the agent is. Never dropped.

## Stable Preferences
Interests and style. Dropped second when over budget.

## Current State
What's going on now. Dropped first when over budget.
```

If the file has no `## Identity Core` heading, the whole file is treated as the core. See [SOUL vs AGENTS vs SKILL](../misc/soul-vs-agents-vs-skill.md) for what goes in which file.
