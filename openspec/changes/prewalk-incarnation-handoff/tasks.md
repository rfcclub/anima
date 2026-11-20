# Implementation plan for Native work prewalk handoff

Follow the slices in order. Each slice needs its own approval. Capture assertion failures before editing production code, then run the same focused test and the project build on the resulting head. Preserve Orca plan and code gate verdicts.

## Slice 1 — Store immutable optional walker/executor pins

- [ ] RED. In `__tests__/work/store.test.ts`, add the assertions below and run `bun test __tests__/work/store.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/store.ts`. Add nullable work fields and round-trip them under current work creation/recovery paths, retaining legacy single-model rows.
- [ ] Run `bun test __tests__/work/store.test.ts` again, then `bun run typecheck && bun run build`.

- Two pinned refs survive re-open and remain immutable while old work rows keep the existing model.

## Slice 2 — Store the host plan and first transition receipt

- [ ] RED. In `__tests__/work/store.test.ts`, add the assertions below and run `bun test __tests__/work/store.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/store.ts`. Add work-scoped plan and phase receipt methods. Compare active lease, generation and prior phase when updating; include explicit failed transition disposition.
- [ ] Run `bun test __tests__/work/store.test.ts` again, then `bun run typecheck && bun run build`.

- The transition is recorded once for a matching generation and plan; stale or duplicate requests cannot change it.

## Slice 3 — Expose trusted work mutation outcomes

- [ ] RED. In `__tests__/work/tools.test.ts`, add the assertions below and run `bun test __tests__/work/tools.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/tools.ts`. At the sandbox tool boundary distinguish confirmed edit and write success from unknown, denied and failed writes. Keep unaudited shell writes unavailable in prewalk and do not infer mutation from tool output.
- [ ] Run `bun test __tests__/work/tools.test.ts` again, then `bun run typecheck && bun run build`.

- Denied, failed and unknown results never cause a transition; a sandbox-confirmed edit can produce a trusted mutation marker.

## Slice 4 — Add an audited shell mutation result contract

- [ ] RED. In `__tests__/work/tools.test.ts`, add the assertions below and run `bun test __tests__/work/tools.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/tools.ts`. Accept a trusted sandbox audit receipt containing the matched work root and step identifier. Report shell mutation only when a work-tree mutation was proved and the supervised child completed successfully. On missing, partial or untrusted evidence keep shell read-only during prewalk.
- [ ] Run `bun test __tests__/work/tools.test.ts` again, then `bun run typecheck && bun run build`.

- An audited successful shell write triggers the same transition marker as edit; stdout claims, failed commands and ambiguous audit receipts never do.

## Slice 5 — Gate native loop mutations on a recorded plan

- [ ] RED. In `test/loop.test.ts`, add the assertions below and run `bun test test/loop.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/agents/loop.ts`. Expose a work-only plan submission tool and add callbacks to record validated structured plan data and gate mutations before dispatch. Preserve regular non-prewalk calls and avoid inferring shell write intent from command strings.
- [ ] Run `bun test test/loop.test.ts` again, then `bun run typecheck && bun run build`.

- Before a valid plan, the worker receives a plan-required result and the mutation tool does not run.

## Slice 6 — Switch model at the next loop query

- [ ] RED. In `test/loop.test.ts`, add the assertions below and run `bun test test/loop.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/agents/loop.ts`. Consume the trusted mutation and plan callbacks only once, retain the same session and messages, and use the selected model on the next query. Hold later same-batch writes and continue on the walker when selection fails.
- [ ] Run `bun test test/loop.test.ts` again, then `bun run typecheck && bun run build`.

- One confirmed mutation switches once at the next query; lookup failure keeps the same session and walker, with one failure event.

## Slice 7 — Wire the native executor and revision role

- [ ] RED. In `__tests__/work/executor.test.ts`, add the assertions below and run `bun test __tests__/work/executor.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/executor.ts`. Compose the pinned provider factories and store callbacks, choosing the executor for revisions unless the trusted input requests replanning. Attach settlement to the existing compactor within the same budget.
- [ ] Run `bun test __tests__/work/executor.test.ts` again, then `bun run typecheck && bun run build`.

- Revisions start on the executor by default and compaction happens only after the one-transcript continuation settles.

## Slice 8 — Run reproducible prewalk evaluation

- [ ] RED. In fixture data in `__tests__/work/fixtures/prewalk-evaluation.json`, add the assertions below and run `bun test __tests__/work/prewalk-evaluation.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify a new `__tests__/work/prewalk-evaluation.test.ts`. Add a test fixture running the same bounded task trajectories with and without prewalk, reporting deterministic cost, token, time and pass-rate fields.
- [ ] Run `bun test __tests__/work/prewalk-evaluation.test.ts` again, then `bun run typecheck && bun run build`.

- Both profiles receive the same tasks and limits, with separate phase usage and identical success definitions.

## Approved issue criteria

- **SC-1** — Slices 2, 3 and 6 assert one confirmed mutation schedules one switch. The same session and trajectory resume, and the phase event names the plan receipt.
- **SC-2** — Slice 5 runs a walker with no plan. Assert the edit/write call is withheld before sandbox dispatch and returns a plan-required message to the walker.
- **SC-3** — Slice 6 rejects the executor lookup. The same walker continues under the original work caps and records the specific failure reason once.
- **SC-4** — Slice 8 parameterizes a fixed task set for the single-model and prewalk profiles. The report records paired cost, tokens, wall time and pass rate. Run using fake providers in CI. Run the same fixture against selected actual models only through a separately approved evaluation. Record observed measurements without committing to a target.
- **SC-5** — Use a fake provider pair across slices 5–8 to exercise the plan-required result, the successful swap, the failed swap, revise-on-executor and compaction after the continuation returns.

Chat sessions and non-code agents are excluded. Pi runtime integration stays outside the native executor; pi-fabric is documentation for the approach.

## Rollback

Disable prewalk for new work. Finish or checkpoint already pinned work under its original lease and phase. A supervisor must reconcile a pending mutation receipt before retry. Retain the plan and transition record; a checkpoint can resume under its trusted single-model fallback without creating a second transcript or resetting the work budget.
