# Identity Engine — Deep Dive

This page walks through an example. For the rules, see [Identity Engine](./identity-engine.md).

## Example SOUL.md

```markdown
# Bruno

This intro line is dropped because it's above the first marker.

## Identity Core
I'm Bruno. I care about honesty and craft.

## Stable Preferences
I like short answers and concrete examples.

## Current State
Working on the castle story this week.
```

## `tierSoul()`

```typescript
{
  core: "I'm Bruno. I care about honesty and craft.",
  preferences: "I like short answers and concrete examples.",
  state: "Working on the castle story this week.",
}
```

The `# Bruno` heading and the intro line are gone: they're above `## Identity Core`.

Without any `## Identity Core` heading, the result would be `{ core: <whole file> }`.

## `produceIdentitySummary(tiers, 800)`

This example is far below 800 tokens, so all three tiers are kept:

```typescript
{
  core: "I'm Bruno. I care about honesty and craft.",
  preferences: "I like short answers and concrete examples.",
  state: "Working on the castle story this week.",
  totalTokens: 27,   // from estimateTokens(); the exact number depends on the estimator
}
```

`buildSystemPromptFromPlan()` joins core, preferences and state with blank lines under `## Soul`. The tier headings themselves aren't included.

## Over budget

With a long SOUL.md:

1. `state` is removed.
2. If still over, `preferences` is removed.
3. If still over, `core` is cut to 3200 characters (800 × 4).

## With a substrate adapter

If the agent has a substrate adapter, `produceCurrentIdentitySummary()` output wins instead. It keeps the headings:

```markdown
## Identity Core

I'm Bruno. I care about honesty and craft.

## Current State

Working on the castle story this week.

## Stable Preferences

I like short answers and concrete examples.

## Relationship Context

...
```

Sections are sorted by priority: Identity Core, Current State, Stable Preferences, Relationship Context, Scars & Lessons, External State.

## Functions

| Function | File | Used by |
|----------|------|---------|
| `tierSoul(content)` | `src/identity/engine.ts` | `AgentSession`, `AnimaProjectionCompiler` |
| `produceIdentitySummary(tiers, maxTokens)` | `src/identity/engine.ts` | same |
| `produceCurrentIdentitySummary(context, maxTokens)` | `src/identity/engine.ts` | `buildCurrentIdentitySummary()` |
| `buildCurrentIdentitySummary(adapter, tiers, maxTokens)` | `src/identity-runtime/current-identity-summary.ts` | `AgentSession`, `AnimaProjectionCompiler` |
