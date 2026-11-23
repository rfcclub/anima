# Tasks — Add a head-bound read-only OpenCode review session

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Define the bounded review packet and verdict parser**
  - Files: `src/review-loop/review-packet.ts`.
  - Implementation: Represent exact head, clipped diff and linked public intent. Accept only one allowed first-line verdict, bound findings, and treat model claims as untrusted text. Include stale and invalid report fixtures.
  - Verification: `bun test __tests__/review-loop/review-packet.test.ts`
- [ ] **S2 – Build the packet from pinned checkout and diff inputs**
  - Files: `src/review-loop/branch-snapshot.ts`, `src/review-loop/review-packet.ts`.
  - Implementation: Verify the detached job commit, obtain the diff from verified base and head, and reject a moved or unidentified commit. Test a PR head changed while selecting input.
  - Verification: `bun test __tests__/review-loop/review-packet.test.ts`
- [ ] **S3 – Launch a qualified read-only OpenCode session**
  - Files: `src/review-loop/opencode-review.ts`.
  - Implementation: Use an isolated profile with allowlisted read-only capabilities and no repository configuration, extensions, shell, writes, GitHub capability or inherited credentials. Prove the session and descendants have ceased after success, failure and timeout. Require current free-model evidence or explicit opt-in for the exact paid model.
  - Verification: `bun test __tests__/review-loop/opencode-review.test.ts`
- [ ] **S4 – Integrate optional OpenCode as a recommendation backend**
  - Files: `src/mesh-jobs/start.ts`, `src/mesh-jobs/consumer.ts`.
  - Implementation: Invoke the backend only when opted in and the lease remains current. Accept one valid recommendation; retain final reviewer authority and verify invalid results cause no write.
  - Verification: `bun test __tests__/mesh-jobs/opencode-review.test.ts`
- [ ] **S5 – Bind trusted posting to the exact reviewed commit**
  - Files: `src/mesh-jobs/consumer.ts`, `src/review-loop/opencode-publish.ts`.
  - Implementation: Require the configured reviewer to authorize bounded verdict and file/line findings. Fetch current head, recheck lease, and bind the host request to the exact reviewed `commit_id`. Require a verified server-side current-head precondition for automated posting. If unavailable, keep posting disabled and retain the recommendation.
  - Verification: `bun test __tests__/review-loop/opencode-publish.test.ts`

## Acceptance and verification

| Criterion | Required behavior | Evidence |
| --- | --- | --- |
| SC-1 | The reviewer invokes OpenCode on the review job's given head SHA and posts under its own verified identity. | S2/S4/S5 focused tests, then a separately authorized live check records exact commit, review ID and author. Keep pending until the write precondition is proven and live evidence exists. |
| SC-2 | A moved head yields no review posted for the old SHA. | S2/S5 tests cover a move during the run and between final read and submission. Disable the posting path unless the latter case is fenced by the server. |
| SC-3 | No OpenCode session process remains after success, failure or timeout. | S3 tests use independent process and descendant exit observations. |
| SC-4 | No paid model is called without explicit opt-in for that model. | S3 tests unknown and paid eligibility, including an opt-in for a different model. |
| SC-5 | Review uses only read-only tools and invalid `VERDICT:` output posts nothing. | S1/S3/S4 negative fixtures exercise rejected output and denied tool capabilities. |
| SC-6 | Posted body starts from the parsed verdict and contains file/line findings. | S5 captures the rendered host request and tests untrusted findings, bounds and exact commit linkage. |

## Rollback

Disable the optional backend and host posting switch. Revoke the active lease, prove process cessation, and clean the disposable checkout and profile. Keep any already-filed external review for the authorized operator to handle.
