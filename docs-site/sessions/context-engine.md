# Context Engine

This page covers how the system prompt for a turn is put together. Two parts of the code are involved:

- **Prompt builders** in `src/agents/prompter.ts`: `buildSystemPrompt()` and `buildSystemPromptFromPlan()`. They return `{ full, staticPrefix, dynamicSuffix, staticHash }`.
- **The DAG context engine** in `packages/context-engine`: a per-agent conversation store that keeps history and summaries across turns. `AgentSession` asks it for extra context each turn.

## Static prefix and dynamic suffix

Each prompt has a static prefix that stays the same between turns of a session, and a dynamic suffix that can change. The prefix is what providers can cache (see [Prompt Caching](../misc/prompt-caching.md)). `staticHash` is a short hash of the prefix, used to track cache stability.

### With an execution plan

`buildSystemPromptFromPlan()`, in order:

| Part | Section |
|------|---------|
| Static | `# <name> - <label>` |
| | `## Soul` (see [Identity Engine](../substrate/identity-engine.md#what-ends-up-in-soul)) |
| | `## Instructions` (the agent's instructions file, cut to 4000 chars) |
| | `## Context` (session context files) |
| | `## Pre-loaded Context`, `## Additional Context`, `## Additional Boot File: <name>` (when present) |
| | `## Universal: <name>`, `## Dependency: <name>` |
| | `## Persona: <name>`, `## Role: <name>` |
| | `## Runtime` (`Model: <model> @ <provider> \| Agent: <name>`) |
| | `## Mode` (see [Session Modes](./modes.md)) |
| | `## Tools` (summary of the tool policy) |
| | `## Language`, `## Framework`, `## Project`, `## Task` (when present) |
| Dynamic | `Date: YYYY-MM-DD` |
| | `## Trusted Memory`, `## Unverified Candidates` (from [per-cartridge retrieval](../substrate/retrieval.md)) |
| | `## Memory Recall` |
| | Bootstrap content (from `memory.crossSessionBootstrap`) |

Every layer winner is in the static prefix, including language, framework, project and task.

### Without an execution plan

`buildSystemPrompt()` has the same title, soul, instructions, context, runtime, mode and tools sections. The differences:

- Base cartridges (scope `shared` and `agent`) are in the static prefix as `## Cartridge: <scope>/<category>/<name>`.
- The active pluggable cartridge is in the dynamic suffix as `## Active Cartridge: <scope>/<category>/<name>`.
- There are no Trusted Memory or Unverified Candidates sections.

The CLI always uses this builder.

## What `AgentSession` adds after the builder

After the prompt is built, `AgentSession` appends, when available:

1. The substrate view (blocks assembled from the agent's substrate map, up to 2000 tokens).
2. Host context: the lifecycle context and the DAG context engine's `systemPromptAddition`.
3. `[Memory Context]`: per-turn recall from the [memory adapter](../substrate/memory.md#recall-adapters), or bootstrap entries from the memory store.
4. The **identity anchor** (`identity.identityAnchor` in the room config), always last. Any earlier copy is removed first, so it's at the end on every turn.

These are added after the static prefix was measured, so they're outside the hashed prefix.

## DAG context engine

`AgentLoader` creates a `BunContextEngine` for each agent (`createBunContextEngine()` in `src/memory/context-store.ts`), stored at `~/.anima/rooms/<agent>/context.db`. If it can't be opened, the agent runs without it.

The `ContextEngine` interface (`packages/context-engine/src/types.ts`) has `initialize`, `bootstrap`, `ingest`, `assemble`, `compact`, `search`, `checkIntegrity` and `dispose`. Each turn, `AgentSession` calls `assemble({ conversationId, prompt, tokenBudget })` with `session.compactThreshold` (default 200000) as the budget, and adds the result's `systemPromptAddition` to the prompt.

Compaction summarises old messages into a tree of summaries. The defaults are in `DEFAULT_COMPACTION_CONFIG` (for example, the newest 64 messages stay uncompacted).

## Inspecting a prompt

There's no CLI command that prints the assembled prompt. To see what went in:

- The event log (`~/.anima/sessions.db`) has the `cartridge_*` and `substrate_context_starved` events for each turn.
- The server log has `substrate retrieval executed` (trusted, unverified and starved counts) and `substrate view assembled`.
- `anima cartridge list` and `anima cartridge expand <name>` show which cartridges exist and their expanded text.
