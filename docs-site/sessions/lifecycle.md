# Session Lifecycle

## Overview

A session is a single interaction turn between a user and an agent. The `AgentSession` class (`src/agents/session.ts`) is the core execution engine — it builds the system prompt, invokes the LLM with tools, executes tool calls in a loop, and manages memory.

## Complete Turn Flow

When a user sends a message, `AgentSession.run()` executes this sequence:

```
User message arrives
    │
    ▼
┌─ 1. VALIDATION ──────────────────────────────────────────────┐
│  • Check mode (plan/edit/auto)                                │
│  • If auto mode → verify autoModeOptIn is true                │
│  • Generate sessionId (UUID)                                  │
│  • Read recent events from the event store (last 12)          │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 2. CARTRIDGE RESOLUTION ────────────────────────────────────┐
│  Two paths depending on agent config:                         │
│                                                               │
│  Path A: ExecutionPlan (new)                                  │
│    • resolveExecutionPlan() scores all cartridges             │
│    • Selects: universal + defaults + working role + task      │
│    • Produces: plan.universal, plan.dependencies, plan.task   │
│                                                               │
│  Path B: Legacy activation                                    │
│    • resolveActivation() with mode + message matching         │
│    • Produces: activation.base, activation.active             │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 3. IDENTITY ENGINE ─────────────────────────────────────────┐
│  (IdentitySummary is used only on the ExecutionPlan path;     │
│   a Current Identity Summary is used on both if available)    │
│                                                               │
│  soulContent → tierSoul() → {core, preferences?, state?}     │
│  tiered → produceIdentitySummary(tiered, 800) → IdentitySummary│
│                                                               │
│  This bounds the SOUL section to ~800 tokens instead of       │
│  dumping the full SOUL.md (which can be 2000+ tokens).       │
│  The summary preserves Identity Core first, then Preferences, │
│  then Current State (dropped in reverse order if over budget). │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 4. SYSTEM PROMPT ASSEMBLY ──────────────────────────────────┐
│                                                               │
│  Static prefix (cacheable):                                   │
│    # agent-name - label                                       │
│    ## Soul (identitySummary or raw soulContent)               │
│    ## Instructions (geneContent, truncated to 4000 chars)     │
│    ## Context (sessionContextFiles)                           │
│    ## Pre-loaded Context (file paths)                         │
│    ## Cartridge: universal/dependencies/role                  │
│    ## Runtime (model @ provider)                              │
│    ## Mode (plan/edit/auto directive)                         │
│    ## Tools (allowed roots, tools, patterns)                  │
│                                                               │
│  Dynamic suffix (per-turn):                                   │
│    Date: 2026-07-04                                           │
│    ## Active Cartridge (task-specific)                        │
│    ## Memory Recall (from adapter.recall)                     │
│    Bootstrap content (cross-session memory)                   │
│                                                               │
│  Identity anchor (injected at end for recency bias):          │
│    <!-- IDENTITY_ANCHOR -->                                   │
│    [Identity Anchor — this is the most recent instruction]    │
│    identityAnchor text from config                            │
│    <!-- IDENTITY_ANCHOR -->                                   │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 5. CONTEXT ASSEMBLY ────────────────────────────────────────┐
│  Multiple context sources merged into system prompt:          │
│                                                               │
│  5a. DAG Context Engine (if available)                        │
│      • Assembles conversation history as DAG                  │
│      • Adds systemPromptAddition to prompt                    │
│                                                               │
│  5b. Memory Recall (adapter.recall)                           │
│      • Queries memory store for relevant entries              │
│      • Appends as [Memory Context] section                    │
│      • topK from config (default 5)                           │
│                                                               │
│  5c. Memory Bootstrap (memoryStore.bootstrap)                 │
│      • Only if agent has anima_* tools                        │
│      • Injects recent memory entries                          │
│                                                               │
│  5d. Thread History (threadStore.getThread)                   │
│      • Prior turns from this channel+agent                    │
│      • Prepended to messages array                            │
│      • Gives LLM full conversation context                    │
│                                                               │
│  5e. Lifecycle Context (if provided)                          │
│      • Appended at end of system prompt                       │
│      • Used by reflection engine for context injection         │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 6. TOOL DEFINITION ─────────────────────────────────────────┐
│  • buildToolDefinitions(allowedTools) → built-in tools        │
│  • mcpManager.getTools() → MCP server tools                   │
│  • Combined into single tools array for provider              │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 7. PROVIDER CALL (with tool loop) ──────────────────────────┐
│                                                               │
│  for iteration = 0 to MAX_TOOL_ITERATIONS (64):              │
│    │                                                          │
│    ├── provider.query({system, messages, tools, model})       │
│    │                                                          │
│    ├── If no tool_calls → return result (done)                │
│    │                                                          │
│    ├── For each tool_call:                                    │
│    │    ├── canUseTool() check (auto-guard)                   │
│    │    ├── If MCP tool → mcpManager.callTool()               │
│    │    ├── If built-in → executeTool()                       │
│    │    ├── Log tool execution                                │
│    │    └── Append tool result to messages                    │
│    │                                                          │
│    └── Continue loop with updated messages                    │
│                                                               │
│  Token usage logged via logTokenUsage()                       │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 8. POST-RESPONSE ───────────────────────────────────────────┐
│                                                               │
│  8a. Safety rejection detection                               │
│      • Regex check for safety filter language                 │
│      • If detected → use fallback message                     │
│                                                               │
│  8b. Evaluation pipeline (if available)                       │
│      • evaluateResponse() gates memory writes                 │
│      • decision: auto_apply | hold | reject                   │
│      • If hold → memory store skipped                         │
│                                                               │
│  8c. Memory store (if auto_apply)                             │
│      • adapter.store({content, type, timestamp})              │
│      • Stores user+assistant exchange                          │
│                                                               │
│  8d. Context engine ingest                                    │
│      • Ingests user message + assistant response              │
│      • Updates DAG for next turn                              │
│                                                               │
│  8e. Thread update (if auto_apply)                            │
│      • threadStore.add(channel, agent, "user", message)       │
│      • threadStore.add(channel, agent, "assistant", response) │
│                                                               │
│  8f. Episode summary (if anima_* tools called)                │
│      • memoryStore.remember() with session summary            │
│      • Fire-and-forget, non-blocking                          │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌─ 9. CLEANUP ─────────────────────────────────────────────────┐
│  • mcpManager.stop()                                          │
│  • autoGuard.complete()                                       │
│  • Remove agentId from activeSet                              │
│  • Notify session end listeners                               │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
Return { sessionId, response }
```

## Key Source Files

| File | Role |
|------|------|
| `src/agents/session.ts` | Core execution engine — runs one turn |
| `src/agents/prompter.ts` | Builds system prompt (static + dynamic) |
| `src/identity/engine.ts` | Tiered SOUL parsing + bounded summary |
| `src/cartridge/activation.ts` | Cartridge resolution (ExecutionPlan or legacy) |
| `src/tools/executor.ts` | Built-in tool execution |
| `src/tools/definitions.ts` | Tool definition builder |
| `src/memory/scoped-store.ts` | Memory store with scope guards |
| `src/evaluation/pipeline.ts` | Evaluation pipeline for gating writes |
| `src/cost/logger.ts` | Token usage logging |

## Session State Tracking

```typescript
// AgentSession maintains static state across sessions
AgentSession.activeSet: Set<string>     // currently running agents
AgentSession.endListeners: Map<string, Array<() => void>>  // cleanup hooks

// Per-run state
this.sessionEvents: JsonlEvent[]        // events for this run
```

## Tool Loop Mechanics

The tool loop runs up to 64 iterations. Each iteration:

1. **Provider call** — sends system + messages + tools to LLM
2. **Response check** — if no tool_calls, return (conversation done)
3. **Permission check** — `canUseTool()` from auto-guard
4. **Tool dispatch** — MCP tools via mcpManager, built-in via executeTool
5. **Result append** — tool result added to messages for next iteration

```typescript
// Simplified tool loop
for (let i = 0; i < 64; i++) {
  const result = await provider.query({ system, messages, tools });
  
  if (!result.tool_calls?.length) return result; // done
  
  for (const tc of result.tool_calls) {
    const decision = await canUseTool?.(tc.name, input);
    if (!decision?.allow) {
      messages.push({ role: "tool", content: `Error: blocked` });
      continue;
    }
    
    const toolResult = isMcpTool(tc.name)
      ? await mcpManager.callTool(tc.name, input)
      : await executeTool(tc, roomDir, agentName, memoryStore);
    
    messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
  }
}
```

## Memory Integration Points

| Phase | When | What |
|-------|------|------|
| **Recall** | Before provider call | `adapter.recall()` → `[Memory Context]` |
| **Bootstrap** | Before provider call | `memoryStore.bootstrap()` → recent entries |
| **Store** | After response | `adapter.store()` → user+assistant exchange |
| **Episode** | After session | `memoryStore.remember()` → session summary |
| **Scope check** | After session | `memoryStore.violations()` → log violations |

## Evaluation Pipeline

High-stakes actions go through evaluation before execution:

```typescript
const evalResult = await this.evaluateResponse(options, responseText, sessionId);
const shouldAutoApply = !evalResult || evalResult.decision === "auto_apply";

if (shouldAutoApply) {
  await adapter.store(...);  // write to memory
  threadStore.add(...);      // update thread
} else {
  // memory write held — waiting for human review
}
```

Evaluation checks:
- **Communication domain** — is the response safe to send?
- **Trust scores** — does the agent have sufficient trust?
- **Content policy** — does it violate any rules?
