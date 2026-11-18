# ADR-0001: Cartridge Layered Architecture

**Status:** Accepted

## Context

ANIMA's original cartridge system used a single-slot model: one "active" cartridge per turn, selected by category (`craft|think|create|operate`). This caused:

1. **Language collision** — TypeScript, Python, and C# all shared `category: craft`. Selection was non-deterministic (whichever came first in scan order).
2. **No composability** — Role, Language, and Framework couldn't co-exist. A coding turn needed all three but could only have one.
3. **No per-agent scoping** — Every agent got every shared cartridge unconditionally.

## Decision

Replace single-slot activation with **7-layer independent composition**:

```
kernel → persona → role → language → framework → project → task
```

Each layer resolves its own winner via scoring. All winners compose into one turn's context.

### Key Design Decisions

1. **Per-layer scoring** — `score = exactTrigger + keyword + selfSelect + agentDefault + taskContinuity − conflict − budgetPenalty`
2. **Dependency graph** — Role cartridges declare `requires:`, resolved recursively
3. **Default Role + Working Role** — Agent has a default; each turn can override
4. **ExecutionPlan** — replaces ActivationResult as resolver output
5. **guides/rules split** — Prose skills (generation) vs rule-engine skills (review)
6. **kind taxonomy** — `kernel|persona|role|language|framework|project|review|task`

## Consequences

- **Positive:** Language selection is deterministic. Roles compose with languages. Per-agent config is explicit.
- **Negative:** Breaking change to activation contract. Existing tests must be rewritten.
- **Mitigation:** Legacy fallback — old config still works during migration.
