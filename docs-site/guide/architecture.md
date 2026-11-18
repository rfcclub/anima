# Architecture

## System Overview

ANIMA is a multi-agent runtime that hosts persistent AI agents, each with its own identity, memory and tool access. It runs as a Bun HTTP server (port 3700 by default) with a Web UI, an optional Telegram gateway and a mesh listener, plus a CLI.

## The Big Picture

```
User (CLI / HTTP / Telegram / Web UI / mesh)
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ Channels                                                      │
│   CLI: src/cli.ts          HTTP + Web UI: src/server.ts       │
│   Telegram: src/channels/  Mesh: src/mesh/                    │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│ Agent Session (src/agents/session.ts)                         │
│   1. Permission mode (plan / edit / auto)                     │
│   2. Cartridge activation (legacy or execution plan)          │
│   3. Per-cartridge substrate retrieval (execution plan only)  │
│   4. Prompt assembly (static prefix + dynamic suffix)         │
│   5. Provider call (tools via the executor)                   │
│   6. Events, cost log, session-end hooks                      │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│ Cartridges (src/cartridge/)                                   │
│   Tiers: colony ~/agora → global ~/.anima → project → agent   │
│   Layers: kernel, persona, role, language, framework,         │
│           project, review, task                               │
│   Scoring: task trigger 10, keyword 5, mode 3, selfSelect 2/1,│
│            defaultRole 1, defaults 1, recent task 1,          │
│            priority × 0.01                                    │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│ Identity & substrate                                          │
│   Identity Engine: SOUL.md → tiers → bounded summary          │
│   Retrieval: adapter.recall() per cartridge → merge/dedupe →  │
│              Trusted / Unverified                             │
│   Substrate view layer: blocks from substrate.map.yaml        │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│ Providers (src/providers/)                                    │
│   Registry: providers.d/*.yaml (openai-completions,           │
│             anthropic-messages, openai-responses)             │
│   Built-ins: claude, gemini                                   │
│   Router (CLI): mode map or fallback chain + circuit breaker  │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────┐
│ Storage                                                       │
│   Event log: SQLite ~/.anima/sessions.db (+ JSONL copies)     │
│   Recall adapter: per memory.type (module / custom / shared)  │
│   Cross-session store: per-agent memory.db                    │
│   Context engine DB: ~/.anima/rooms/<agent>/context.db        │
│   Cost: ~/.anima/cost.db                                      │
└───────────────────────────────────────────────────────────────┘
```

Background jobs (reflection ticks, dreams, Town/Castle flushes) run inside the server process. See [Scheduling](../sessions/scheduling.md).

## Module Map

| Module | Path | Purpose | Key files |
|--------|------|---------|-----------|
| **Agents** | `src/agents/` | Agent loading, session, prompt | `session.ts`, `loader.ts`, `prompter.ts` |
| **Cartridge** | `src/cartridge/` | Registry, loader, activation, retrieval | `activation.ts`, `loader.ts`, `registry.ts`, `retrieval.ts` |
| **Identity** | `src/identity/`, `src/identity-runtime/` | SOUL tiering, identity summaries | `engine.ts`, `current-identity-summary.ts` |
| **Memory** | `src/memory/` | Event stores, recall adapters, memory stores | `sqlite-store.ts`, `dual-store.ts`, `store-registry.ts`, `contract.ts` |
| **Context engine** | `packages/context-engine/` | Conversation DAG, compaction | `src/types.ts`, `src/dag/` |
| **Providers** | `src/providers/` | Provider registry, router, provider classes | `registry.ts`, `router.ts`, `openai-v1-chat.ts`, `anthropic.ts` |
| **Proxy** | `src/proxy/` | `/ai/v1/*` LLM proxy | `index.ts`, `model-resolver.ts` |
| **Session** | `src/session/` | Session manager, lifecycle, compaction | `manager.ts`, `lifecycle.ts`, `compactor.ts` |
| **Tools** | `src/tools/`, `src/mcp/` | Tool definitions, executor, MCP | `definitions.ts`, `executor.ts` |
| **Continuity** | `src/continuity/` | Reflection loop, activation layer, staging | `reflection-engine.ts`, `activation-layer.ts`, `staging.ts` |
| **Dream** | `src/dream/` | Light nap, deep and lucid dreams | `deep-dream.ts`, `lucid-dream.ts` |
| **Mesh** | `src/mesh-a2a/` | A2A inbox and presence for colony-mesh | `agent-inbox.ts`, `agent-presence.ts` |
| **Server** | `src/server.ts` | HTTP server and routes (no WebSocket) | — |
| **CLI** | `src/cli.ts` | Command-line interface | — |

## Data Flow: A Single Turn

This example uses the execution plan path and the cartridges in this repo. By default the legacy activation path runs instead (see [Activation](../cartridge/activation.md)).

```
1. User sends "fix the failing test in the python parser"
        │
2. AgentSession picks the permission mode: session.defaultMode, e.g. "edit"
        │
3. CartridgeRegistry lists every tier (colony → global → project → agent)
        │
4. resolveExecutionPlan() scores each layer:
   - Universal: engineering-common-lite (if listed in `universal`)
   - Persona: creative and warmth tie at the base score 1 → creative (name order)
   - Role: programming (task trigger "fix" +10)
   - Language: python (task trigger "python" +10)
        │
5. Dependencies: programming.requires → programming-kernel (not in the repo, skipped)
        │
6. Conflicts, then the budget gate (limit 5000 tokens)
        │
7. compileRetrievalPlan() → executeRetrievalPlan(): adapter.recall() per
   cartridge, merge/dedupe/rank, Trusted vs Unverified
        │
8. Identity Engine: SOUL.md → bounded summary
        │
9. buildSystemPromptFromPlan(): static prefix (soul … role, mode, tools,
   language) + dynamic suffix (date, memories)
        │
10. AgentSession appends substrate view, [Memory Context] and the identity anchor
        │
11. Provider call with system + cachePrefix
        │
12. Events and token usage are logged; on session close, a light nap runs
```

## Key Design Principles

### 1. Cartridges Don't Carry Knowledge — They Carry Retrieval Strategies
A cartridge declares WHAT to query, not the content itself. This means substrate can grow to millions of lines without changing the architecture.

### 2. Per-Layer Independent Resolution
Each layer resolves independently. Language doesn't compete with Role. They compose.

### 3. Identity Is Separate from Role
`Identity: Bruno` ≠ `Default Role: programmer` ≠ `Working Role: reviewer`. Three independent facts.

### 4. Debuggable Cognition
Every retrieved memory keeps `requested_by` (the cartridges that asked for it) and `policy_id`, and activation decisions are written to the event log as `cartridge_*` events. The prompt itself only shows each memory's scope and content.

### 5. Graceful Degradation
Legacy cartridges (no `kind` field) still work. No retrieval policy = flat topK fallback. Migration is incremental.
