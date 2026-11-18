# Compaction Strategy — Anima Context Engine

*Sources: `packages/context-engine/src/dag/compaction.ts`, `packages/context-engine/src/types.ts`, `hermes_plugin/anima_memory/store.py`.*

---

## Two Independent Compaction Systems

Anima has **two separate compaction systems** that serve different purposes:

| System | Purpose | Trigger | Location |
|--------|---------|---------|----------|
| **Context Engine** (TS) | Shrink active conversation context to fit token budget | Token count vs. budget threshold | `packages/context-engine/src/dag/compaction.ts` |
| **AnimaMemoryStore** (Python) | Consolidate persistent cross-session memories | `anima_sleep` tool call | `hermes_plugin/anima_memory/store.py` |

These do **not** communicate. The context engine compacts the live session context. AnimaMemoryStore compacts the SQLite memory database that persists across sessions.

---

## 1. Context Engine Compaction (Active Session)

### When It Runs

`CompactionEngine.compact()` is called from `sessionManager.checkCompaction()` when:

```
current_tokens > target_tokens * 0.75
```

Compaction is **preemptive** — it triggers at 75% of budget, not when full.

### Architecture: Two-Phase DAG Compression

The engine maintains a **DAG of context items** (messages + summaries). Compaction runs two alternating passes until the context fits:

```
Phase 1: Leaf Pass
  └── Converts oldest raw messages → leaf summaries
      (preserves durable facts, discards verbatim turns)

Phase 2: Condensed Pass
  └── Merges same-depth leaf summaries → condensed summary
      (higher-level abstraction)
```

This repeats in rounds until `current_tokens <= target_tokens * 0.75` or limits are hit.

### Default Configuration

```typescript
DEFAULT_COMPACTION_CONFIG = {
  leafChunkTokens:       20_000,  // max raw messages per leaf summary
  leafTargetTokens:       2_400,  // target size of each leaf summary
  condensedTargetTokens:  2_000,  // target size of condensed summaries
  condensedMinFanout:         4,  // min sibling summaries to condense
  freshTailCount:           64,   // message-type items kept raw
  maxSweepIterations:       12,   // max passes per phase
  maxRounds:                10,   // max leaf+condensed cycles
  sweepDeadlineMs:      120_000,  // 2-min deadline per sweep
  compactUntilUnderDeadlineMs: 300_000,  // 5-min total deadline
}
```

### Fresh Tail Protection

The last `freshTailCount` (64) **message-type** items are never compacted. They remain as raw text. Only older items are eligible for compression.

### Three-Level Fallback on Summarization Failure

When `SummaryProvider.complete()` fails, compaction tries in order:

1. **Normal** — `temperature: 0.3`, `maxTokens: targetTokens`, system prompt: "preserve key facts"
2. **Aggressive** — `temperature: 0.1`, `maxTokens: targetTokens * 0.5`, system prompt: "essential facts only"
3. **Deterministic** — `truncateTextToEstimatedTokens()` — raw text cut to budget with `[Truncated]` prefix

Auth errors (401/403/auth in message) **propagate immediately** without fallback — auth failures should not silently truncate.

### Token Estimation

Uses `estimateTokens()` from `dag/estimate-tokens.js`. No external API calls for counting.

---

## 2. AnimaMemoryStore Consolidation (Cross-Session Persistence)

### Purpose

Keeps the SQLite memory database (`~/.anima/agents/<name>/memory.db`) lean across sessions. Runs on `anima_sleep` tool call (manual or cron-triggered).

### What It Does

Two-pass cleanup:

1. **Confidence filter**: Remove entries with `confidence < 0.2`
2. **Deduplication**: Remove entries sharing the same content prefix (SHA256[:12] of first 100 chars)

### Recall Budget Guard

Every `recall()` call enforces `RECALL_MAX_CHARS = 2000` (≈500 tokens) hard cap on total returned content.

```
Algorithm: fill-first, shortest-deferred-first
- Add entries in RRF score order until budget exhausted
- If an entry doesn't fit, defer it
- Then try to fill remaining budget with deferred entries (shortest first)
```

This means a single large entry cannot monopolize context. Small useful entries get priority.

### Hybrid Search (recall)

Uses **Reciprocal Rank Fusion** across three channels:

```
RRF_K = 60

score(neuron) =  1/(RRF_K + FTS5_rank)
              + 1/(RRF_K + vector_rank)     [if GEMINI_API_KEY available]
              + 0.5/(RRF_K + LIKE_rank)       [always runs, half weight]
```

- **FTS5**: Full-text search with BM25-style ranking
- **Vector**: Cosine similarity against Gemini embedding (3072-dim)
- **LIKE**: Trigram substring match, always available

### Bootstrap (Session Start)

Loads top-accessed + most-recent entries, **deprioritizing `observation` scope** (raw events get lowest priority; semantic/episodic preferred).

---

## Key Differences

| Aspect | Context Engine | AnimaMemoryStore |
|--------|---------------|------------------|
| Scope | Single active session | Cross-session persistent |
| Metric | Token count | Character count |
| Compression | LLM summarization (2-level) | Confidence threshold + dedup |
| Trigger | Token budget exceeded | Manual/cron `anima_sleep` |
| Fresh content | Last 64 messages protected | All entries eligible for recall |
| Embeddings | None | Gemini (optional, via API) |

---

## Not Covered Here

- **OpenClaw session compaction** — separate implementation in `OpenClaw runtime.llm.compact()`
- **Cross-platform sync** — AnimaMemoryStore shared across Hermes/ANIMA/OpenClaw via same SQLite file
- **Embedding backfill** — `anima_backfill_embeddings.sh` cron drains `embedding_retry_queue`
- **Growth ring / crossing.md** — Cleo's pre-compaction anchor writing (separate protocol)
