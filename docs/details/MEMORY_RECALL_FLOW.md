# MEMORY_RECALL_FLOW

Per-turn memory recall integrated into the heartbeat tick loop. Provides mid-session context injection to prevent amnesia after context compression.

## Per-Turn Recall Gate

Every heartbeat tick runs a tick classifier before recall:

```
Orient → Classify → {Full Recall | Context Pin | Skip} → Decide → Act
```

- **Substantive tick**: user message, task assignment, Telegram reply -> full recall
- **Mechanical tick**: health check, queue poll, heartbeat-status -> context pin only
- **Null tick**: no active duty, agent asleep -> skip

Classification is deterministic: if the tick's input contains user-authored text, it is substantive. Otherwise it is mechanical.

```
classifyTick(input): "full" | "pin" | "skip"
  if input is null or empty -> "skip"
  if input.source is "user" or "telegram" or "task" -> "full"
  -> "pin"
```

## Recall Execution

Full recall shells out to the configured `recall.mjs` script:

```typescript
const result = await execFn([
  "node", recallScript,
  "--query", query,
  "--topK", "5",
], { timeout: 5000 });
```

Safety constraints:
- **execFile only** -- never passes query through shell interpolation. Arguments are passed as an array to `Bun.spawn()`.
- **5-second timeout** via `AbortSignal.timeout(5000)`.
- **Graceful degradation**: on timeout, non-zero exit, or parse failure, recall silently returns `[]`. An error line is logged at `console.error` level.

## Result Formatting

Recall results are formatted as a `[Memory Context]` section injected into the system prompt before the agent's response:

```
[Memory Context]
3 recalled neurons (query: "user message here"):
  - [high] Growth Ring 14: Session summary 2026-05-28 (confidence: 0.9)
  - [medium] Observation: Colony routing decision (confidence: 0.6)
  - [low] Scent: Telegram thread context (confidence: 0.3)
```

This matches the ANIMA AgentSession format where structured context blocks precede the conversation history.

## State Tracking

The recall phase maintains three state variables in memory:

```typescript
interface RecallState {
  turnCount: number;           // total turns processed
  lastFullRecall: number;      // turnCount at last full recall
  recallScope: "full" | "pin" | "skip";  // scope of current tick
}
```

- `turnCount` increments every tick, regardless of recall type
- `lastFullRecall` is set to `turnCount` after a full recall completes
- `recallScope` is set each tick by the classifier

## Mid-Session Re-Grounding

After 30 turns or 60 minutes without a full recall (whichever comes first), the next substantive tick triggers a mandatory re-grounding sequence:

1. Full recall with a broad query combining recent context and drift keywords
2. Re-read `drift_lessons.md` and check the 7 baselines
3. Inject re-grounding context as a `[Re-Grounding]` block

```typescript
if (turnCount - lastFullRecall >= 30 || timeSinceLastRecall >= 3600000) {
  triggerReGrounding();
}
```

## Role-Based Scope

Scope is determined by the agent's colony role:

| Role | Recall Mode | TopK | Details |
|------|-------------|------|---------|
| **Storehouse** | Full | 10 | Complete neural graph recall, metadata included |
| **Bridge** | Context pin | 3 | Current context pin only: active duties, recent observations |
| **None** | Skip | 0 | No per-turn recall; boot-time injection only |
