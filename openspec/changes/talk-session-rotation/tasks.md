# Work plan — talk-session-rotation

Refs #288. Every slice must obtain its own approval before implementation. Size estimates count production files; tests and local verification artifacts are separate. Stop and split a task when its production work exceeds approximately forty lines or its tests expose a separate boundary.

## Implementation tasks

### T1 — Parse per-agent talk rotation limits

- [ ] Confirm the parent design is accepted before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/config/types.test.ts` and record RED before modifying `src/config/types.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Parse optional positive-integer age and turn overrides, supply the proposed defaults, and reject invalid values at room-config validation.
- [ ] Run `bun test __tests__/config/types.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T2 — Count durable talk turn history

- [ ] Confirm T1 is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/talk-turn-count.test.ts` and record RED before modifying `src/memory/session-store.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Expose a targeted count including soft-deleted rows for the specific old session. Preserve current count consumers.
- [ ] Run `bun test __tests__/session/talk-turn-count.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T3 — Decide when a talk session has expired

- [ ] Confirm T1 and T2 are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/talk-rotation.test.ts` and record RED before modifying `src/session/talk-rotation.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Return an age or turn reason using injected time, inclusive thresholds, deterministic tie-breaking, and a safe invalid-time case.
- [ ] Run `bun test __tests__/session/talk-rotation.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T4 — Persist one rotation claim per old talk session

- [ ] Confirm T3 is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/talk-rotation-store.test.ts` and record RED before modifying `src/memory/session-store.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Create a durable talk-only rotation claim keyed by old session ID. Prove duplicate claims fail without writing an end time or opening a replacement.
- [ ] Run `bun test __tests__/session/talk-rotation-store.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T5 — Commit talk session replacement

- [ ] Confirm T4 is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/talk-rotation-store.test.ts` and record RED before modifying `src/memory/session-store.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Finalize a successfully claimed rotation atomically, ending the previous session, creating one replacement, and recording the pairing. A replay returns the existing pairing.
- [ ] Run `bun test __tests__/session/talk-rotation-store.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T6 — Expose awaited continuity summary result

- [ ] Confirm T4 is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/cross-session-memory.test.ts` and record RED before modifying `src/session/cross-session-memory.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Expose an awaited summary path that reports persistence or empty history, propagates failure, and makes the saved text available for the first new talk. Preserve existing asynchronous caller behavior.
- [ ] Run `bun test __tests__/session/cross-session-memory.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T7 — Serialize CLI talk sessions across processes

- [ ] Confirm T4 is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/talk-rotation-lock.test.ts` and record RED before modifying `src/session/talk-lock.ts`, `src/cli.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Hold a per-store, per-agent process lock across the whole ordinary talk request, return busy before a concurrent writer starts, and release on exit or proved process cessation.
- [ ] Run `bun test __tests__/session/talk-rotation-lock.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### T8 — Select the rotated talk session and log it

- [ ] Confirm T5 through T7 are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/session/talk-rotation.test.ts` and record RED before modifying `src/session/talk-rotation.ts`, `src/cli.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Await one continuity write before finalizing a rotation, give its text to the first new talk prompt, and emit the old and new session IDs and the reason only after replacement. Leave other channels unchanged.
- [ ] Run `bun test __tests__/session/talk-rotation.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

## Acceptance and verification
| ID | Scenario | Executable evidence |
| --- | --- | --- |
| TR-1 | WHEN a talk session is older than the limit or reaches the turn limit THEN the next talk ends it and starts a new session, and the session-end handler runs exactly once | T1–T8. `bun test __tests__/session/talk-rotation.test.ts`, delayed summary, participant races, and compaction history. |
| TR-2 | WHEN the talk session is younger than the limit and below its turn limit THEN the same session is reused as today | T3 and T8. `bun test __tests__/session/talk-rotation.test.ts`, both limits below threshold. |
| TR-3 | WHEN rotation happens THEN the log records old id, new id and reason | T8. `bun test __tests__/session/talk-rotation.test.ts`, spy on log and validate committed IDs. |
| TR-4 | WHEN an operator runs a separately approved deployment and comparison THEN the cost report records age at the next talk and daily compactor spend with sample sizes and gaps | Operator run, existing cost report before and after, comparable workload windows. Idle rows recorded separately. A reduction must be measured; never assume it. |
Run `bun test __tests__/session __tests__/config/types.test.ts`, typecheck and build after wiring. The deployed cost result remains unverified until authorized measurement.
## Rollback
Revert CLI wiring to keep reuse behavior. Keep the old transcripts and rotation claims. Resolve incomplete external summary claims before enabling rotation again.
