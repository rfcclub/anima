# Tasks — Qualify stock Pi in isolated profiles

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Build a disposable lifecycle probe for the pinned release**
  - Files: `scripts/qualify-pi.ts`.
  - Implementation: Exercise RPC launch, prompt, a settled response, and two revisions under one session identifier against a deterministic provider. Assert isolated prefix, profile and package version.
  - Verification: `bun test test/qualify-pi.test.ts`
- [ ] **S2 – Verify RPC cancellation and process cessation separately**
  - Files: `scripts/qualify-pi-cancel.ts`.
  - Implementation: Record a cancellation acknowledgement and an independent termination observation, then resume the same session in a new process. Reject missing cessation proof.
  - Verification: `bun test test/qualify-pi-cancel.test.ts`
- [ ] **S3 – Check retained values, restrictions and extension compatibility**
  - Files: `scripts/qualify-pi-surfaces.ts`.
  - Implementation: Exercise `codemode store` and `load` in a later call and after proven exit and resume. Record the refusal of a harmless denied operation inside Pi and the extension compatibility result. Use only a deterministic local provider in this slice.
  - Verification: `bun test test/qualify-pi-surfaces.test.ts`
- [ ] **S4 – Qualify the candidate on macOS and Windows**
  - Files: `docs/harness/stock-pi-qualification.md`.
  - Implementation: Run the same qualification on macOS and Windows. Compare the existing global Pi 1.0.1 binary and settings byte-for-byte without exposing their content. Record every Windows failure and its sanitized output. Track the strong-model/custom-provider run and owner decision separately, each pending its own authorization.
  - Verification: Record the inspected interface, observed commands and exit status for this slice. Keep unrun checks explicit.

## Acceptance and verification

| Criterion | Required behavior | Evidence |
| --- | --- | --- |
| SC-1 | Isolated Pi 1.1.x on macOS completes launch, prompt, settled output, two revisions in one session, cancellation, proven exit and resume. | S1/S2 focused tests and S4 qualification record. |
| SC-2 | A `codemode` `store` value survives a later `load` call and resume. | S3 surface test and S4 qualification record. |
| SC-3 | A denied tool operation is refused inside Pi and recorded. | S3 negative fixture confirms refusal and absence of the operation's effect. |
| SC-4 | One run completes on a strong model through a custom provider. | S4 separately authorized run records provider class and result without credentials. Keep pending until run. |
| SC-5 | Global Pi 1.0.1 binary and settings remain byte-identical before and after. | S4 records comparison outcomes without file contents. |
| SC-6 | The same checks pass on Windows, or each failure is recorded with its output. | S4 Windows result records each observed failure and sanitized output. Missing access remains pending. |
| SC-7 | The owner records Pi or fallback with reasons in this issue. | Confirm the decision in the parent issue only after an authorized write. |

## Rollback

Stop the disposable processes, then remove the disposable prefix, profile and fixture. Check that the global binary and setting comparisons are unchanged. Keep the previous harness selection.
