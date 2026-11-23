# Work plan — pair-mode-evidence-pilot

Refs #375. Every slice must obtain its own approval before implementation. Size estimates count production files; tests and local verification artifacts are separate. Stop and split a task when its production work exceeds approximately forty lines or its tests expose a separate boundary.

## Implementation tasks

### P1 — Establish the pilot baseline and local evidence index

- [ ] Confirm the #377 baseline source and review timing fields are checked before editing.
- [ ] For production changes, add a failing acceptance assertion using `git diff --check` and record RED before modifying `docs/pair-mode-pilot/evidence-template.md`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Specify the candidate commit, command, status, boundary, sample-size, and missing-data fields and cite the baseline when available.
- [ ] Run `git diff --check` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### P2 — Exercise saturation, quarantine and recovery against SQLite

- [ ] Confirm the #275 S1C and S1E candidate behaviors exist before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/pair-pool-pilot.test.ts` and record RED before modifying `__tests__/work/pair-pool-pilot.test.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Run a deterministic operation model and a contention barrier on real SQLite. Assert unique leases, unchanged waiting budget and reservations, nonreuse after unproven cessation, and release only after fenced proof across restart.
- [ ] Run `bun test __tests__/work/pair-pool-pilot.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### P3 — Demonstrate that the pool tests detect a targeted fault

- [ ] Confirm P2 passed on its exact candidate commit before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/pair-pool-pilot.test.ts` and record RED before modifying `docs/pair-mode-pilot/mutation-recipe.md`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Run isolated temporary mutations for duplicate ownership or premature release. Record expected failures, unexpected survivors, exact commit and commands. Restore the disposable tree before recording the unchanged green result.
- [ ] Run `bun test __tests__/work/pair-pool-pilot.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### P4 — Verify resume starts with a fresh HOME

- [ ] Confirm the #275 S2C and S2D candidate behaviors exist before editing.
- [ ] For production changes, add a failing acceptance assertion using `bun test __tests__/work/pair-resume-pilot.test.ts` and record RED before modifying `__tests__/work/pair-resume-pilot.test.ts`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Show that resume preserves approved history but never reads a prior readiness marker or reuses a prior credential. Label fake runner evidence separately from any authorized real VM result.
- [ ] Run `bun test __tests__/work/pair-resume-pilot.test.ts` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

### P5 — Assess the pilot with an independent reviewer

- [ ] Confirm P1 through P4 artifacts are available before editing.
- [ ] For production changes, add a failing acceptance assertion using `git diff --check` and record RED before modifying `docs/pair-mode-pilot/assessment.md`. For evidence or documentation work, state the observed precondition and qualification method.
- [ ] Report exact candidate and baseline sample sizes, lead time, rework, gate errors and gaps. Record the reviewer’s expand, adjust or stop recommendation without changing any verdict.
- [ ] Run `git diff --check` and record the result against the candidate commit. Run the repo typecheck and build for production changes.

## Acceptance and verification
| ID | Scenario | Executable evidence |
| --- | --- | --- |
| EP-1 | WHEN a pilot change reserves worker capacity THEN no slot is concurrently assigned to two sessions and a full pool consumes no session or reservation state | P2 and P3. `bun test __tests__/work/pair-pool-pilot.test.ts`, compare persisted snapshots. |
| EP-2 | WHEN cessation is unproven or a worker crashes THEN the affected slot is not reused without positive cessation proof, including recovery or restart cases | P2 and P3. `bun test __tests__/work/pair-pool-pilot.test.ts`, reopen the database between transitions. |
| EP-3 | WHEN a low session resumes THEN its HOME is fresh and prior readiness markers and credentials are not reused | P4. `bun test __tests__/work/pair-resume-pilot.test.ts`, inspect mounted sandbox inputs; label the fake boundary. |
| EP-4 | WHEN a pilot change is submitted for review THEN the exact commit, commands and outcomes, tested behavior, gate verdicts and unverified limitations are reviewable | P1 and P5. Independent artifact lookup and `git diff --check` for the evidence template. |
| EP-5 | WHEN the pilot is assessed THEN the report states baseline and pilot sample sizes, review lead time and rework, gate errors and missing data, and recommends expand, adjust or stop | P5. Checked report with baseline and pilot sample sizes and named measurement gaps. |
Run exact candidate checks; a gate or coverage number alone does not establish runtime success. Review evidence and metrics as separate deliverables.
## Rollback
End or narrow the pilot without changing worker behavior. Retain negative observations and actual gate findings locally, and leave any unapproved rollout untouched.
