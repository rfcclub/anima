# Identity Engine

The Identity Engine (`src/identity/engine.ts`) turns an agent's `SOUL.md` into a bounded summary for the prompt's `## Soul` section.

## Pipeline

```
SOUL.md
  → tierSoul(): split into Identity Core, Stable Preferences, Current State
  → produceIdentitySummary(tiers, 800): fit into 800 tokens
  → buildCurrentIdentitySummary(): optionally combine with substrate scopes
  → prompt ## Soul
```

## Tiering

`tierSoul()` looks for these headings (exact text, case-insensitive):

```markdown
## Identity Core
## Stable Preferences
## Current State
```

- If there's no `## Identity Core` heading, the whole file becomes the core.
- If there is, text is assigned to the section of the heading above it. **Text before the first marker heading is dropped.**

## Budget

`produceIdentitySummary(tiers, maxTokens)`. `AgentSession` uses 800 tokens. When the total is over:

1. Current State is dropped.
2. Then Stable Preferences.
3. Then the core is cut to `maxTokens × 4` characters.

## Current Identity Summary

If the agent has a substrate adapter, `buildCurrentIdentitySummary()` (`src/identity-runtime/current-identity-summary.ts`) also reads the `scars`, `current_state` and `relationship` scopes (only results with status `ok` and trust `medium` or `high`). `produceCurrentIdentitySummary()` combines them with the SOUL tiers into one Markdown block of up to 800 tokens.

When over budget, sections are removed in this order: External State, Scars & Lessons, Relationship Context, Stable Preferences, Current State. Identity Core is kept and only shortened as a last resort. Headings inside the content are turned into plain text so the content can't add its own prompt sections.

## What ends up in `## Soul`

| Prompt builder | Order of preference |
|----------------|---------------------|
| `buildSystemPromptFromPlan()` (execution plan) | Current Identity Summary (cut to 4000 chars) → Identity Summary → raw SOUL.md cut to 4000 chars |
| `buildSystemPrompt()` (legacy activation) | Current Identity Summary (cut to 4000 chars) → raw SOUL.md, not cut |

The CLI (`anima talk`) calls `buildSystemPrompt()` without a Current Identity Summary, so it always injects the raw SOUL.md.

See [Identity Engine — Deep Dive](./identity-engine-detail.md) for an example.
