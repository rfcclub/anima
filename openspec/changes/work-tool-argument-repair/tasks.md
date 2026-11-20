# Implementation plan for Bounded work-tool argument repairs

Follow the slices in order. Each slice needs its own approval. Capture assertion failures before editing production code, then run the same focused test and the project build on the resulting head. Preserve Orca plan and code gate verdicts.

## Slice 1 — Classify shape failures before dispatch

- [ ] RED. In `__tests__/work/tools.test.ts`, add the assertions below and run `bun test __tests__/work/tools.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/tools.ts`. Add typed pre-dispatch outcomes for one case-only argument-key or enum miss. Keep unknown tool, parse, policy and post-dispatch failures outside learning.
- [ ] Run `bun test __tests__/work/tools.test.ts` again, then `bun run typecheck && bun run build`.

- A unique case mismatch produces one pre-dispatch candidate; ambiguous, malformed, semantic and permission-like outcomes produce none.

## Slice 2 — Persist bounded repair observations

- [ ] RED. In `__tests__/work/store.test.ts`, add the assertions below and run `bun test __tests__/work/store.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/store.ts`. Add agent- and schema-scoped observation accessors to the WorkStore with a per-scope cap and conflict refusal. Store only digests and declared replacements.
- [ ] Run `bun test __tests__/work/store.test.ts` again, then `bun run typecheck && bun run build`.

- Identical observations are deduplicated, expired-digest lookups miss, and records from another scope cannot affect a lookup.

## Slice 3 — Apply one validated repair

- [ ] RED. In `__tests__/work/tools.test.ts`, add the assertions below and run `bun test __tests__/work/tools.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/tools.ts`. Inject observation lookup and audit callbacks into work tools. On a repeated validated miss retry exactly once through ordinary dispatch. Include a deterministic same-root path-form classifier only if it passes the same boundary tests.
- [ ] Run `bun test __tests__/work/tools.test.ts` again, then `bun run typecheck && bun run build`.

- The first miss returns the original error; repeated unambiguous input makes at most one sandboxed call and records its outcome.
- A recorded candidate never changes the fate of a denied path or a semantic error.

## Slice 4 — Add an opt-in repair flag

- [ ] RED. In `__tests__/work/work-config.test.ts`, add the assertions below and run `bun test __tests__/work/work-config.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/config.ts`. Parse a default-false work profile field so legacy behavior and catalog are unchanged.
- [ ] Run `bun test __tests__/work/work-config.test.ts` again, then `bun run typecheck && bun run build`.

- Only an explicit valid profile flag enables repairs.

## Slice 5 — Wire profile-scoped work repair evidence

- [ ] RED. In `__tests__/work/tool-observability.test.ts`, add the assertions below and run `bun test __tests__/work/tool-observability.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/executor.ts`. Inject the WorkStore adapter only for enabled profiles; produce sanitized work events and metrics for repeat fingerprints.
- [ ] Run `bun test __tests__/work/tool-observability.test.ts` again, then `bun run typecheck && bun run build`.

- Disabled profiles retain first-miss behavior; enabled profiles count repeated misses by digest and log one repair result per step.

## Approved issue criteria

- **SC-1** — Slice 1 tests a unique shape mismatch rejected before tool dispatch. Slice 2 stores a candidate with its evidence and no raw argument.
- **SC-2** — Slices 3 and 5 repeat a recorded near-miss. Assert one normal gated tool call and one repair event per step.
- **SC-3** — Slices 1 and 3 exercise a nonzero shell exit, an edit miss and a missing file. Assert the observation store and repair event log receive no entry for each semantic failure.
- **SC-4** — Slice 2 changes the tool schema digest, then proves the earlier repair cannot be looked up or applied.
- **SC-5** — Focused tests for slices 1–3 cover learn, apply, ambiguity refusal, semantic exclusion and invalidation. Treat the rationale in pi-fabric `docs/repairs.md` and `docs/entropy.md` as a reference for review, without a runtime dependency.

## Rollback

Disable the repair flag for the affected profile to return to the original dispatch behavior. Retain bounded observations for inspection. Existing tools and sandbox policies remain available with the same privileges. A changed schema makes the saved candidates ineligible.
