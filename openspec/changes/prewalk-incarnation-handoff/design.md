# Native work prewalk handoff

Source issue #276. Design and plan for review.

## Architecture

Reuse `prewalk-session-handoff`, `prewalk-phase-aware-recall` and `prewalk-evaluation`. Preserve the single code-session and stable identity guarantees. `WorkStore` owns an optional immutable pair of registry model references, plan receipt and phase transition state. Legacy or disabled works still use their original single pin. Resolve both through the same host provider factory. The runtime carries one session ID, the complete ordered messages and normal budget, and uses mutable provider/model selection only at the next query boundary. `src/work/executor.ts` builds the work-only callbacks and `src/agents/loop.ts` observes authoritative outcomes after a tool step. Session history, prompt profile and identity stay owned by the same runtime.

Accept a validated host-owned plan record after checking objective, ordered steps and verification commands. A model string or tool output cannot change the phase directly. Before a plan exists, explicitly withhold edit/write and publish operations. For shell, use the existing host-enforced sandbox primitive in read-only mode while walking without a plan. With a plan, classify shell mutation using a trusted audit that can prove the operation succeeded. If reliable audit is unavailable, do not offer arbitrary shell writes in walker phase. A write tool announces structured success only after a proved sandbox outcome. Withhold later same-batch mutations after the first success until the executor owns the next model call, with an explicit tool result for each withheld call. Persist the plan receipt and boundary result using the existing work lease/generation fencing. On interruption with a possibly applied mutation, reconcile existing open step evidence before any repeat. A failed executor lookup records one decline and continues the walker under the same cap. Revise starts on the executor unless a trusted review policy explicitly requests a new plan. Compact after executor continuation settles, spending the same work budget and preserving the transcript. External adapters remain on current behavior until they expose the same audited boundary.

## Test strategy

Use a fake model pair and local work fixtures for plan-required, denied and failed writes, first successful mutation, same-batch fencing, swap failure, revise role, compaction and restart reconciliation. Compare cost, tokens, wall time and pass rate against a single-model baseline using the same fixed tasks and hard caps. Report observations without a promised saving.

## Non-goals

Chat sessions, persona-memory changes, additional credentials, separate model transcripts and external-adapter rollout are outside this work.
