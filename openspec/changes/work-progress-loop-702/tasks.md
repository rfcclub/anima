# Tasks: progress-aware work-loop observation

## SC-1: Distinct telemetry and cross-session history

- [x] Write failing tests in `__tests__/work/progress-guard.test.ts` for first observation, unchanged repeat, changed result, changed workspace state and comparison after a new valid session. Verify event classifications and streaks, and that raw arguments/results are absent.
- [x] Write failing tests for a stale generation and a mismatched claim, asserting distinct `stale` and `duplicate_worker` events and no mutation of the current owner's history.
- [x] Add an additive work-store observation table and transactional history update. Hash canonical call arguments and results; check the host signal and session/generation/claim before updating history. Emit bounded telemetry events without modifying existing fences.
- [x] Invalidate only the affected advisory cache entry when an observation becomes unknown, without deleting it. Test the invalidation and isolation from other works and calls across a store restart.
- [x] Add a bounded sandboxed state fingerprint over the host worktree, current branch and tracked/nonignored file contents. Never follow symlinks; any unavailable, unsafe, incomplete, timed-out or over-limit sample is `unknown` and cannot trigger enforcement. Test changed and unchanged contents, symlinks and bounded failure.

## SC-2: Observe-only and prospective false positives

- [x] Write failing tests proving that omitted and false enforcement produce telemetry for prospective interventions but no model warning or stop.
- [x] Classify exact operator-designated polling paths and shell commands, and a narrowly recognized read-only Git status command, as `polling`. Test unchanged polling past the threshold: telemetry identifies the would-be intervention as a false positive and no action occurs.
- [x] Persist only fingerprints and bounded labels; telemetry failure must not change the work session's result. Record an explicit observation-unavailable event for the external adapter, whose internal tools are not host-observable.

## SC-3: Explicit warning then stop

- [x] Write failing fake-provider loop tests for explicit enforcement: a warning appears in a later provider turn before any stop; a subsequent unchanged call stops as blocked after its tool marker is completed.
- [x] Test several repeated tool calls in one provider turn: they may schedule a warning but cannot stop before it is delivered. Test polling and unknown snapshots never warn or stop.
- [x] Add validated optional operator config for enforcement (default false), exact polling read paths and exact polling commands. Wire the guard to the in-process adapter's host-executed tool seam; preserve existing checkpoint and interruption handling.

## SC-4: Existing safety contracts

- [x] Run the unchanged lease/generation, work-store, step-marker, idempotency, reconciliation and executor tests alongside the new tests. Run typecheck and build.
- [x] Run executable `orca verify`, `orca gate-plan` and `orca gate-code`; preserve their actual receipts, including refusals and warnings.
