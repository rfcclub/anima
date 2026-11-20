# Work plan — pair-mode-worker-pool

Refs #275. Every slice must obtain its own approval before implementation. Size estimates count production files; tests and local verification artifacts are separate. Stop and split a task when its production work exceeds approximately forty lines or its tests expose a separate boundary.

## Implementation tasks

### S0 — Qualify the pinned worker process and resume mode

- [ ] Confirm the candidate backend build is identified before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/adapter-low.test.ts` and record RED before modifying `docs/pair-mode-qualification.md`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Document the verified one-shot exit and session-resume interface. Capture any real VM probe only under separate authorization and keep raw evidence local.
- [ ] Run `bun test __tests__/work/adapter-low.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1A — Parse default-off pair mode and bounded slot count

- [ ] Confirm the previous config-only draft is checked for reuse before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/mesh-jobs/config.test.ts` and record RED before modifying `src/mesh-jobs/config.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Parse default-off pair configuration with four slots by default and a validated upper bound. An omitted setting keeps the existing config behavior.
- [ ] Run `bun test __tests__/mesh-jobs/config.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1B — Persist worker slot ownership

- [ ] Confirm S1A is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/pair-pool-store.test.ts` and record RED before modifying `src/work/store.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Add restart-safe slot records with unique ownership binding and explicit free, leased and quarantined states. Preserve existing work records when the table is added.
- [ ] Run `bun test __tests__/work/pair-pool-store.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1C — Reserve one slot and one work session atomically

- [ ] Confirm S1B is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/pair-pool-store.test.ts` and record RED before modifying `src/work/store.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Within reserveSession assign a free slot with the new session generation, or return pool-full without inserting the session or changing budget, generation or state.
- [ ] Run `bun test __tests__/work/pair-pool-store.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1D — Return saturated jobs to their queue

- [ ] Confirm S1C is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/consumer.test.ts` and record RED before modifying `src/work/consumer.ts`, `src/work/runtime.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Hand back pool-full claims only through a configured release-capable queue and keep the prior work state. Pair mode refuses startup when safe release is unavailable.
- [ ] Run `bun test __tests__/work/consumer.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1E — Release a worker slot after proved cessation

- [ ] Confirm S1C is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/pair-pool-store.test.ts` and record RED before modifying `src/work/store.ts`, `src/work/runtime.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Free the exact session slot on positive cessation proof and quarantine it otherwise; stale generations cannot mutate a newer lease.
- [ ] Run `bun test __tests__/work/pair-pool-store.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1F — Recover abandoned leases without reusing unsafe capacity

- [ ] Confirm S1E is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/reconciler.test.ts` and record RED before modifying `src/work/store.ts`, `src/work/reconciler.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Quarantine a lease left by a restarted supervisor. Only positive, bound cessation proof permits re-use.
- [ ] Run `bun test __tests__/work/reconciler.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S1G — Resolve expired waiting assignments

- [ ] Confirm S1D and S1F are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/reconciler.test.ts` and record RED before modifying `src/work/reconciler.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] When a waiting job is positively known expired, record a visible blocked reason for operator recovery without silently re-enqueueing or freeing unrelated capacity.
- [ ] Run `bun test __tests__/work/reconciler.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S2A — Normalize one worker report per assignment

- [ ] Confirm S0 confirms the output contract before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/adapter-low.test.ts` and record RED before modifying `src/work/adapter.ts`, `src/work/adapter-low.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Use one typed report for the active assignment, with done, unverified, question, error and stopped-short outcomes. Stale or duplicate reports cannot complete a newer assignment.
- [ ] Run `bun test __tests__/work/adapter-low.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S2B — Persist the worker conversation reference

- [ ] Confirm S2A is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/adapter-low.test.ts` and record RED before modifying `src/work/store.ts`, `src/work/adapter-low.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Bind an eligible conversation reference to the exact work and backend under its generation, without exposing it to a separate work or carrying worker claims as approval.
- [ ] Run `bun test __tests__/work/adapter-low.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S2C — Provide fresh VM home and allowlisted history

- [ ] Confirm S0 and S2B are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/container-runner.test.ts` and record RED before modifying `src/work/container-runner.ts`, `src/work/vm.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Copy only permitted conversation history into a fresh HOME and regenerate readiness and credentials for every physical worker process. Preserve the baseline isolation for other workers.
- [ ] Run `bun test __tests__/work/container-runner.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S2D — Continue a trusted conversation on revision

- [ ] Confirm S2C is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/adapter-low.test.ts` and record RED before modifying `src/work/container-runner.ts`, `src/work/adapter-low.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Resume review feedback using the saved conversation or announce a fresh conversation when the backend changes or the trusted snapshot is unavailable. Capture snapshots only after proved cessation.
- [ ] Run `bun test __tests__/work/adapter-low.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S3A — Expose incremental worker progress

- [ ] Confirm S2A is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/container-runner.test.ts` and record RED before modifying `src/work/vm.ts`, `src/work/container-runner.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Expose a bounded incremental progress signal without leaking output or credential values. Keep final output behavior and terminate collection on proven process cessation.
- [ ] Run `bun test __tests__/work/container-runner.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S3B — Mark a stalled worker and offer steering or abort

- [ ] Confirm S1E and S3A are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/adapter-low.test.ts` and record RED before modifying `src/work/adapter-low.ts`, `src/work/consumer.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Mark a worker stalled after an injected silence interval. Route abort or steer-and-resume through cessation and the active assignment fence.
- [ ] Run `bun test __tests__/work/adapter-low.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S4A — Validate an ordered fallback list

- [ ] Confirm S2A is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/mesh-jobs/config.test.ts` and record RED before modifying `src/mesh-jobs/config.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Parse ordered explicitly configured fallback entries. Preserve non-pair behavior and reject malformed inputs without printing configuration secrets.
- [ ] Run `bun test __tests__/mesh-jobs/config.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S4B — Switch on a qualified quota or rate-limit stop

- [ ] Confirm S2D and S4A are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/consumer.test.ts` and record RED before modifying `src/work/consumer.ts`, `src/work/store.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Advance to the next eligible fallback on a qualified stop using the same revision and verified recovery boundary. Announce the change, retain safe conversation semantics, and make list exhaustion visible.
- [ ] Run `bun test __tests__/work/consumer.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### S5 — Verify host evidence before invoking Main review

- [ ] Confirm S2A is available before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/completion.test.ts` and record RED before modifying `src/work/complete.ts`, `src/work/evidence.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Bind evidence to the exact checked branch commit, reject forbidden paths and false test claims, and continue through independent review only with host-verified evidence.
- [ ] Run `bun test __tests__/work/completion.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

## Acceptance and verification
| ID | Scenario | Executable evidence |
| --- | --- | --- |
| PM-1 | WHEN Main sends a task THEN the worker report arrives through one latch/inbox regardless of backend | S2A and S5. `bun test __tests__/work/adapter-low.test.ts`, concurrent and stale reports. |
| PM-2 | WHEN Main asks for changes THEN the same worker session continues with the revision | S2B–S2D. `bun test __tests__/work/adapter-low.test.ts`, revised input and history binding; qualified VM probe before enabling. |
| PM-3 | WHEN a provider stops on quota THEN the next ordered fallback resumes the step and the switch is announced | S4A–S4B. `bun test __tests__/work/consumer.test.ts`, ordered fallback and switch evidence. |
| PM-4 | WHEN the worker stops responding THEN the watchdog marks it and offers steer or abort | S3A–S3B. `bun test __tests__/work/adapter-low.test.ts`, fake clock then recover or quarantine. |
| PM-5 | WHEN a fake low process exits THEN the tests cover done, not verified, question, error and stopped-short outcomes | S0 and S2A. `bun test __tests__/work/adapter-low.test.ts`, table-driven exit assertion. |
| PM-6 | WHEN the worker pool is full or a previous writer cannot prove cessation THEN a free, positively safe slot is required before another work session consumes budget | S1B–S1G. `bun test __tests__/work/pair-pool-store.test.ts`, reproduce under concurrent transactions and restart. |
Run `bun test __tests__/work __tests__/mesh-jobs`, typecheck and build. Record the fake/real proof boundary and avoid enabling pair mode from test results alone.
## Rollback
Disable pair mode for new work. Leave in-flight work, quarantined slots and session history fenced. Prove cessation before making any slot reusable. Keep the existing loop available.
