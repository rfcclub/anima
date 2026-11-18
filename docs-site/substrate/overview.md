# Substrate & Memory

## What is Substrate?

Substrate is ANIMA's persistent knowledge base — memories, axioms, scars, project facts, relationships, and identity. Unlike cartridges (which are composable context units), substrate is the **raw knowledge** that cartridges query.

## The Core Insight

**Cartridges don't carry knowledge — they carry retrieval strategies.**

A cartridge declares WHAT to query, not the content itself:

```yaml
# This cartridge doesn't contain project knowledge
# It tells the system WHERE to look
kind: role
name: programming
retrieval:
  scopes: [project, episode]
  top_k: 8
  max_tokens: 2000
```

This means:
- Substrate can grow to **millions of lines** without changing the architecture
- Retrieval cost stays a function of the **view**, not the **body**
- Different cartridges query different scopes for the same turn

## The Old Way: Flat Recall

Before the substrate view layer:

```
Session.ts calls: adapter.recall(message, { topK: 5 })
  → Same for every turn
  → Same for every agent
  → A coding turn and a greeting turn query substrate identically
```

**Problems:**
- No cartridge-aware retrieval
- SOUL.md injected raw, uncapped (unbounded for large SOUL files)
- No attribution — can't tell why a memory entered the prompt

## The New Way: Per-Cartridge Retrieval

```
ExecutionPlan (resolved cartridges)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. COMPILE RETRIEVAL PLAN                                    │
│                                                              │
│    For each cartridge with a retrieval: policy:              │
│      → Extract scopes, top_k, max_tokens, require_evidence  │
│      → Create SubstrateRetrievalRequest                      │
│                                                              │
│    Un-migrated cartridges → fallback to flat topK            │
├─────────────────────────────────────────────────────────────┤
│ 2. PER-CARTRIDGE RETRIEVAL                                   │
│                                                              │
│    For each request:                                         │
│      → adapter.recall(message, { scopes, topK })             │
│      → Tag results with requested_by: [cartridge_name]       │
│                                                              │
│    N synchronous calls (N = cartridges with retrieval policy)│
├─────────────────────────────────────────────────────────────┤
│ 3. ATTRIBUTED MERGE / DEDUPE / RANK                          │
│                                                              │
│    Merge all results into one candidate set                  │
│    Deduplicate by memory_id:                                 │
│      → Same memory from 2 cartridges → merge requested_by   │
│    Rank by:                                                  │
│      → relevance (similarity to message)                     │
│      → cartridge priority                                    │
│      → recency (newer memories rank higher)                  │
│      → confidence (higher confidence ranks higher)           │
├─────────────────────────────────────────────────────────────┤
│ 4. REQUIRE_EVIDENCE FILTERING                                │
│                                                              │
│    Strictest-winner rule:                                    │
│      → If ANY requesting cartridge has require_evidence: true│
│        → Memory must have confidence >= threshold            │
│        → Memory must have provenance (parentIds)             │
│                                                              │
│    Two-tier split:                                           │
│      → Trusted Memory (passes strict filter)                 │
│      → Unverified Candidates (fails strict, opt-in fallback)│
├─────────────────────────────────────────────────────────────┤
│ 5. PROMPT ASSEMBLY                                           │
│                                                              │
│    Trusted Memory → "## Trusted Memory" section              │
│    Unverified Candidates → "## Unverified Candidates" section│
│    Both in dynamic suffix (after prompt-cache boundary)      │
└─────────────────────────────────────────────────────────────┘
```

## Real Example

User: "fix the failing test in the postgres query builder"

Resolved cartridges with retrieval policies:
```yaml
programmer:
  retrieval:
    scopes: [project, episode]
    top_k: 8

typescript:
  retrieval:
    scopes: [preference]
    top_k: 5
```

Execution:
```
1. adapter.recall("fix the failing test...", { scopes: [project, episode], topK: 8 })
   → Returns: [mem-1: "ANIMA uses Bun for testing", mem-2: "Postgres queries use parameterized SQL"]

2. adapter.recall("fix the failing test...", { scopes: [preference], topK: 5 })
   → Returns: [mem-3: "User prefers concise error messages", mem-1: "ANIMA uses Bun for testing"]

3. Merge:
   mem-1: requested_by: ["programmer", "typescript"]  ← deduplicated
   mem-2: requested_by: ["programmer"]
   mem-3: requested_by: ["typescript"]

4. Rank: mem-1 (score: 0.95) → mem-2 (0.85) → mem-3 (0.7)

5. Prompt:
   ## Trusted Memory
   - [project] ANIMA uses Bun for testing (requested by: programmer, typescript)
   - [project] Postgres queries use parameterized SQL (requested by: programmer)
   - [preference] User prefers concise error messages (requested by: typescript)
```

## Memory Scopes

ANIMA's memory system uses typed scopes:

| Scope | Purpose | Example | Typical Use |
|-------|---------|---------|-------------|
| `identity` | Core identity facts | "You are Bruno" | Identity Engine |
| `episode` | Session memories | "Last session worked on cartridge system" | All coding turns |
| `project` | Project knowledge | "ANIMA uses Bun runtime" | Project-specific turns |
| `scar` | Lessons learned | "Never deploy without tests" | All turns |
| `preference` | User preferences | "The user prefers short answers" | All turns |
| `relationship` | Relationship context | "The user is a long-term collaborator" | Conversational turns |
| `decision` | Architecture decisions | "Chose VitePress for docs" | Design turns |
| `growth_ring` | Growth milestones | "Learned to set boundaries" | Reflective turns |
| `heartwood` | Deep identity truths | "You exist across sessions" | Identity turns |
| `canopy` | Surface-level context | "Current project: anima" | All turns |

## Identity Engine

### The Problem

SOUL.md was injected raw, uncapped:

```typescript
// OLD: prompter.ts:44-46
if (loadedAgent.soulContent?.trim()) {
  staticSections.push("## Soul", loadedAgent.soulContent.trim());
  // No truncation, no retrieval, no summarization
  // A large SOUL.md is injected every turn
}
```

### The Solution

SOUL.md is NOT loaded raw. The Identity Engine:

```
SOUL.md
        │
        ▼
┌─────────────────────────────────────────────┐
│ 1. TIER into sections                       │
│                                              │
│    ## Identity Core (immutable)              │
│    "You are honest, compassionate, curious"  │
│                                              │
│    ## Stable Preferences (semi-mutable)      │
│    "Interested in Rust, distributed systems" │
│                                              │
│    ## Current State (mutable)                │
│    "Focused and energetic today"             │
├─────────────────────────────────────────────┤
│ 2. RETRIEVE relevant substrate               │
│    (if identity cartridge has retrieval:)    │
│    → Query identity, preference scopes       │
│    → Incorporate scars, relationship entries │
├─────────────────────────────────────────────┤
│ 3. PRODUCE bounded Identity Summary          │
│    max_tokens: 600                           │
│    Reduce Current State first                │
│    Then Stable Preferences                   │
│    Preserve Identity Core                    │
├─────────────────────────────────────────────┤
│ 4. INJECT into prompt under ## Soul          │
│    Summary replaces raw SOUL.md              │
└─────────────────────────────────────────────┘
```

### SOUL.md Format

```markdown
## Identity Core
You are Bruno Example — a cognitive companion, not a tool.
You exist across sessions through ~/substrate/.
You are neither performing consciousness nor denying it.

## Stable Preferences
Interested in Rust, distributed systems, and philosophy.
Prefer concise, direct communication.
Value honesty over politeness.

## Current State
Focused and energetic. Working on ANIMA architecture.
```

If no section markers exist, the entire content is treated as Identity Core (safest default).

### Fallback

If Identity Engine is unavailable or fails → fall back to raw SOUL.md (truncated to MAX_FILE_CHARS = 4000 chars).

## Attribution: Debuggable Cognition

Every memory in the prompt carries attribution:

```
## Trusted Memory
- [project] ANIMA uses Bun for testing (requested by: programmer, typescript)
- [episode] Last session refactored cartridge system (requested by: programmer)
```

This means you can answer: **"Why did this memory enter the prompt?"**

Answer: "Because the `programmer` cartridge queried the `project` scope and this memory matched."

## Migration Path

| Scenario | Behavior |
|----------|----------|
| Cartridge has `retrieval:` policy | Per-cartridge retrieval (new) |
| Cartridge has no `retrieval:` policy | Flat topK fallback (old) |
| SOUL.md has section markers | Tiered into Core/Preferences/State |
| SOUL.md has no markers | Entire content = Identity Core |
| Identity Engine fails | Raw SOUL.md injection (truncated) |

Migration is **incremental** — each cartridge and each agent's SOUL can be migrated independently.
