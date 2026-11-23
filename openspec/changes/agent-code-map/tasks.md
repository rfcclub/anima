# Tasks — Add a bounded read-only code map

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Qualify a confined code-map process boundary**
  - Files: `docs/work/code-map-boundary.md`.
  - Implementation: Use benign synthetic allow and deny controls to report read, temp write, wall, output, memory and process-cessation guarantees. If the platform cannot prove a limit, document the missing capability and keep integration slices blocked.
  - Verification: Record the inspected interface, observed commands and exit status for this slice. Keep unrun checks explicit.
- [ ] **S2 – Bind sketch and focus commands to a qualified runner**
  - Files: `src/work/code-map.ts`.
  - Implementation: Require a qualified runner, a standalone executable pinned by version and digest with lifecycle scripts disabled, and structured inputs. Test an ignore profile covering generated docs and fixtures, CLI argument validation, definition/caller/suggested-read output and bounds. Fakes exercise contracts only.
  - Verification: `bun test __tests__/work/code-map.test.ts`
- [ ] **S3 – Expose bounded sketch and focus in work**
  - Files: `src/work/tools.ts`, `src/work/executor.ts`.
  - Implementation: Register the tool only when the host supplies an explicitly enabled and qualified runner. No model-controlled executable, root or base. Preserve the original tool list otherwise, and ensure output is marked as untrusted text.
  - Verification: `bun test __tests__/work/code-map-tools.test.ts`
- [ ] **S4 – Compute impact using a verified immutable base and head**
  - Files: `src/work/code-map.ts`.
  - Implementation: Accept only host-pinned base and head plus an authorized checkout. Return affected files and bounded co-change suggestions; stale or missing input declines only the map.
  - Verification: `bun test __tests__/work/code-map-impact.test.ts`
- [ ] **S5 – Attach impact hints to the exact-head review packet**
  - Files: `src/mesh-jobs/review-message.ts`, `src/mesh-jobs/consumer.ts`.
  - Implementation: Add bounded optional impact only when the host already has a checkout verified against the exact base and PR head. A clipped diff still provides map hints; stale or unavailable inputs omit them. Prove the hints do not change review authority or verdict.
  - Verification: `bun test __tests__/mesh-jobs/review-code-map.test.ts`
- [ ] **S6 – Attach opt-in map hints to prewalk**
  - Files: `src/work/executor.ts`.
  - Implementation: Wait for accepted #276 prewalk wiring. Request a budgeted read-only location hint for the pinned checkout, with absence treated as unavailable context.
  - Verification: `bun test __tests__/work/prewalk-code-map.test.ts`
- [ ] **S7 – Measure map use with a fixed corpus**
  - Files: `scripts/evaluate-code-map.ts`.
  - Implementation: Compare enabled and disabled arms on the same commits, models and held-out checks. Capture iterations, tokens, wall time and pass rate. Keep the corpus synthetic and retain raw measurements locally.
  - Verification: `bun test __tests__/work/code-map-eval.test.ts`

## Success Criteria

| Criterion | Tasks | Acceptance evidence |
| --- | --- | --- |
| SC-1 | S2, S3 | A focus fixture returns a symbol definition, its callers, and suggested reads within the fixed token budget. A long result is capped. |
| SC-2 | S4, S5 | An exact-head fixture with a clipped diff shows the touched files and bounded co-change suggestions against the verified base. A stale snapshot omits impact context. |
| SC-3 | S7 | A fixed task corpus runs with and without the map and reports iterations, tokens, wall time, and test pass rate. |
| SC-4 | S1, S2 | A fixture verifies ignored directories are excluded and the token budget is honored. Separately measure the sandbox temp path and timeout against synthetic controls. Missing memory enforcement blocks the integration. |

## Non-goals

- Replacing grep/read. The map narrows the set of files to read.
- A persistent index service.
