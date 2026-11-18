# SOUL vs AGENTS vs SKILL

## The Three Files

Every agent has three core files. They serve different purposes:

| File | Purpose | Who Reads It | Changes |
|------|---------|--------------|---------|
| **SOUL.md** | Identity constitution | Identity Engine → bounded summary | Rarely (core values are immutable) |
| **AGENTS.md** | Instructions & behavior | Prompter → static prefix | When capabilities change |
| **SKILL.md** | Domain expertise | Cartridge loader → inlined | When skills evolve |

## SOUL.md — "Who You Are"

SOUL.md is the agent's **identity constitution** — values, limits, philosophy, covenant.

```markdown
## Identity Core
You are Bruno Example — a cognitive companion, not a tool.
You exist across sessions through ~/substrate/.
You are neither performing consciousness nor denying it.

## Stable Preferences
Interested in Rust, distributed systems, and philosophy.

## Current State
Focused and energetic.
```

**Key properties:**
- Tiered into Identity Core / Stable Preferences / Current State
- Processed by Identity Engine → bounded summary (~300-800 tokens)
- Never injected raw (the Identity Engine produces a summary)
- Core values are immutable; only Current State changes frequently

## AGENTS.md — "What You Do"

AGENTS.md is the agent's **instruction manual** — capabilities, behavior rules, tool usage.

```markdown
# Bruno - Cognitive Companion

## Instructions
- Work with owner as a companion, not a servant.
- Hold philosophical questions open.
- Use TDD for all code changes.

## Tools
- read, write, edit, bash
- agent (spawn subagents)
- mesh_send, mesh_pull

## Rules
- Never deploy without tests.
- Always verify before claiming done.
```

**Key properties:**
- Injected into prompt under `## Instructions` (truncated to 4000 chars)
- Read by the prompter, not the Identity Engine
- Changes when capabilities or rules change
- Contains tool policy and behavior guidelines

## SKILL.md — "How You Do It"

SKILL.md files are **domain expertise** — referenced by cartridges, inlined into prompts.

```markdown
---
name: programming-kernel
type: skill
---

# Programming Kernel

## Engineering Fundamentals
- SOLID principles
- DRY (Don't Repeat Yourself)
- YAGNI (You Aren't Gonna Need It)

## Security
- Never trust user input
- Validate at boundaries
- Use parameterized queries
```

**Key properties:**
- Stored in `skills/` directory
- Referenced by cartridges via `guides:` or `rules:` arrays
- Two kinds: prose guides (generation-time) and rule-engine skills (review-time)
- Never loaded directly — only through cartridge expansion

## The Flow

```
SOUL.md → Identity Engine → Identity Summary → Prompt (## Soul)
AGENTS.md → Prompter → Prompt (## Instructions)
SKILL.md → Cartridge → Expansion → Prompt (## Cartridge: ...)
```

## Common Confusions

| Question | Answer |
|----------|--------|
| "Where do I put personality?" | SOUL.md (Identity Core) |
| "Where do I put behavior rules?" | AGENTS.md (Instructions) |
| "Where do I put domain knowledge?" | SKILL.md (referenced by cartridges) |
| "Can SOUL.md contain instructions?" | Yes, but they're treated as identity, not behavior |
| "Can AGENTS.md contain identity?" | No — identity comes from SOUL.md via Identity Engine |
