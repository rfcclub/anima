# Implementation Plan: work-adapter-trial

Parent intent #420. Approve each slice separately and execute its named RED/GREEN check before combining slices.

### Task 1 — Exercise Low completion and host publication

- Scope. New `__tests__/work/adapter-trial-completion.test.ts`; use the existing adapter and Git integration fixture. No production changes.
- Behavior. An isolated fake-runner completion produces a checked host commit and uses the fake publisher to create a draft; the session records `done`.
- RED. Assert host commit identity, checked tree, one fake draft call and recorded stop cause; the fixture has no live remote.
- Run `bun test __tests__/work/adapter-trial-completion.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 2 — Exercise Low deadline and lease-loss cleanup

- Scope. New `__tests__/work/adapter-trial-stops.test.ts`; start after #419 abort provenance. No production changes.
- Behavior. Record `deadline` for a host deadline and `interrupted` for lease loss. Keep publication fenced until cessation is proven and deny it on lease loss.
- RED. Use one fake timer/VM sequence per stop and assert kill, proven absence and external calls. Add separate unproven-cessation refusal.
- Run `bun test __tests__/work/adapter-trial-stops.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 3 — Exercise Low startup and publication refusal

- Scope. New `__tests__/work/adapter-trial-refusals.test.ts`. No production changes.
- Behavior. Produce named refusals for a missing runtime/image, branch movement, executable Git configuration and synthetic secret-shaped content; no push or draft call.
- RED. Test each reason with local fixtures and a fake publisher. Verify startup fallback never runs Loop and cessation stays unproven if cleanup is unresolved.
- Run `bun test __tests__/work/adapter-trial-refusals.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 4 — Add an opt-in scratch trial entry point

- Scope. `scripts/work-adapter-scratch.ts` and `__tests__/work/adapter-trial-entrypoint.test.ts`. Limit this slice to flag/precondition and cleanup contracts.
- Behavior. Default to no execution; an explicit live flag admits only a fresh unmanaged scratch fixture with no remote. Track and clean only resources minted by the run.
- RED. Omit the live flag and point a fixture at a repo with a configured remote; assert there are no VM calls in either case. Mock cleanup failure and assert `fail`.
- Run `bun test __tests__/work/adapter-trial-entrypoint.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 5 — Verify live isolation with synthetic canaries

- Scope. `scripts/work-adapter-scratch.ts` and `__tests__/work/adapter-trial-boundary.test.ts`; wait for scratch entry point.
- Behavior. Record distinct outcomes for out-of-workspace, separate Git directory, credential-shaped fixture and off-gateway listener checks; preserve synthetic canaries and report real cleanup.
- RED. Use a dry fixture to assert all outcomes are independently labeled and a missing prerequisite reports `not run`; separately execute only on an authorized scratch host.
- Run `bun test __tests__/work/adapter-trial-boundary.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 6 — Verify live Low concurrency isolation

- Scope. `scripts/work-adapter-scratch.ts` and `__tests__/work/adapter-trial-concurrency.test.ts`; wait for #411 and #419.
- Behavior. Exercise two sessions and then four only within the configured cap and verify gateway and workspace separation.
- RED. Fake session receipts and assert a cross-session rejection, no token in output and no launch above the cap. Record real evidence separately.
- Run `bun test __tests__/work/adapter-trial-concurrency.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 7 — Verify live Low resume after proven cessation

- Scope. `scripts/work-adapter-scratch.ts` and `__tests__/work/adapter-trial-resume.test.ts`; wait for #410 and #419 abort provenance.
- Behavior. Start the second session from the committed tree and covered note when the first VM is proven gone.
- RED. Assert tracked content and covered note reach the second worker, and that an unsettled first VM blocks continuation. Record real evidence separately.
- Run `bun test __tests__/work/adapter-trial-resume.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 8 — Prove sequential Loop author lane lifecycle

- Scope. `src/mesh-jobs/consumer.ts` and `__tests__/mesh-jobs/consumer.test.ts`; reuse the current polling boundary.
- Behavior. Hold one slot per author through session settlement, release on failure, and permit another author while respecting the global cap. Existing behavior may satisfy the logical-lane tests with no production change. These assertions do not establish worker-thread affinity. Hold the real comparison pending the explicit lane decision in the design.
- RED. Hold one worker promise, assert no same-author second execution, allow the other author, reject the held session, then assert the next eligible job starts.
- Run `bun test __tests__/mesh-jobs/consumer.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 9 — Resolve the author programming view

- Scope. New `src/work/programming-view.ts` and `__tests__/work/programming-view.test.ts`.
- Behavior. Compose existing activation, retrieval and assembly APIs using a trusted programming choice. Return bounded marked context or a stable named failure.
- RED. With the same fixture author and different activity, assert different scope sets including the programming scope; prove missing required context blocks.
- Run `bun test __tests__/work/programming-view.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 10 — Load the programming view inside the Loop session

- Scope. `src/work/executor.ts` and `__tests__/work/executor.test.ts`. Define an injectable narrow port before wiring production.
- Behavior. Resolve bounded programming context within its admitted author lane and before the first model request. Record elapsed time, covered scope count and estimated tokens only, or stop blocked.
- RED. Capture a real executor request using a fake loader, compare two lane identities, inject a named failure and assert no provider calls or raw context in the event.
- Run `bun test __tests__/work/executor.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 11 — Connect the production author loader to Loop work

- Scope. `src/work/production.ts` and `__tests__/work/production-programming-view.test.ts`; requires programming view and executor slices.
- Behavior. Use the configured author context via the existing agent loader and supply the port for Loop. The Low adapter receives no substrate.
- RED. Run two configured fixture authors and assert they use different substrate adapters; Low never invokes the view loader.
- Run `bun test __tests__/work/production-programming-view.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 12 — Report read-only adapter comparison metrics

- Scope. `scripts/work-adapter-report.ts` and `__tests__/work/adapter-trial-report.test.ts`.
- Behavior. Read a snapshot and injected PR/review reader to report metrics for each adapter plus explicit unknown/mixed buckets; emit no actor names, raw text or paths.
- RED. Check exact totals on a fixture including a handover and unavailable evidence. Hash the source snapshot before and after and assert a read-only remote port.
- Run `bun test __tests__/work/adapter-trial-report.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


## Verification

Run the focused commands in the stated dependency order, then run `bun run typecheck` and `bun run build` for production changes. Keep the reviewed design separate from executable acceptance. Preserve Orca plan and code gate verdicts.

## Success Criteria

| Criterion | Tasks | Acceptance evidence |
| --- | --- | --- |
| SC-1 | 1–3 | Fake-runner scenarios 1, 2, 3, 5 and 6 cover completion and draft publication, host deadline, lease-loss abort, host publish refusal and startup failure. Record a test result for each. |
| SC-2 | 4–5 | Record all four real scratch isolation outcomes independently as pass, fail or not run with a reason. No fixture may point at real credential data or unrelated services. |
| SC-3 | 8–11 | Load the programming view within the admitted author lane, record metadata only and prove a named blocker prevents a provider request on lookup failure. |
| Parent criterion 3a | 9 | Check that programming and another activity cover different scopes for the same fixture author. Record a view-layer defect if they do not differ. |
| SC-4 | 12 | Verify the report prints both adapters' fixture metrics and preserves the underlying snapshot. |
| SC-5 | All | Check committed artifacts for private paths, host names and operator or author identifiers. |

## Non-goals

Running more microVMs at once than the owner has allowed.
