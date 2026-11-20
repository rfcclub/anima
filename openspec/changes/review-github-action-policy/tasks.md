# Implementation plan for GitHub tool action policy for review jobs

Follow the slices in order. Each slice needs its own approval. Capture assertion failures before editing production code, then run the same focused test and the project build on the resulting head. Preserve Orca plan and code gate verdicts.

## Slice 1 — Enforce bounded GitHub action permissions in the handler

- [ ] RED. In `__tests__/tools/github-app.test.ts`, add the assertions below and run `bun test __tests__/tools/github-app.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/tools/github-app.ts`. Add a typed trusted context to `GithubCtx`. Refuse disallowed actions and cross-item requests before App key or transport access. Add a bounded audit reason.
- [ ] Run `bun test __tests__/tools/github-app.test.ts` again, then `bun run typecheck && bun run build`.

- Restricted profiles permit only their declared action set and denied or mismatched requests touch neither credentials nor transport.

## Slice 2 — Pin the PR review request to the authorized head

- [ ] RED. In `__tests__/tools/github-app.test.ts`, add the assertions below and run `bun test __tests__/tools/github-app.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/tools/github-app.ts`. When the handler receives a bound PR head, verify the current head, pin the review payload to that commit and preserve the existing independent-review check.
- [ ] Run `bun test __tests__/tools/github-app.test.ts` again, then `bun run typecheck && bun run build`.

- A stale head prevents submission and an allowed review POST carries the authorized commit id.

## Slice 3 — Forward trusted action policy through tool execution

- [ ] RED. In a new `__tests__/tools/github-executor-policy.test.ts`, add the assertions below and run `bun test __tests__/tools/github-executor-policy.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/tools/executor.ts`. Add typed host-only execution metadata and forward it to the GitHub handler. Keep policy and tool-name authorization and ordinary callers intact.
- [ ] Run `bun test __tests__/tools/github-executor-policy.test.ts` again, then `bun run typecheck && bun run build`.

- Execution metadata is bound by the host and cannot be replaced by model-supplied arguments.

## Slice 4 — Pass target bounds from review claims

- [ ] RED. In `__tests__/mesh-jobs/consumer.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/consumer.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/consumer.ts`. Extend `TurnRunner` review input to carry the validated current PR number and head from the consumer, and preserve target revision for intent jobs.
- [ ] Run `bun test __tests__/mesh-jobs/consumer.test.ts` again, then `bun run typecheck && bun run build`.

- The runner receives the claimed repository and target bounds independently of untrusted review text.

## Slice 5 — Propagate bounded review job metadata to the child

- [ ] RED. In `__tests__/mesh-jobs/turn-runner.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/turn-runner.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/start.ts`. Construct validated child arguments or a fixed-schema environment payload in the existing turn runner. Clear inherited profile metadata when it does not apply.
- [ ] Run `bun test __tests__/mesh-jobs/turn-runner.test.ts` again, then `bun run typecheck && bun run build`.

- A review child receives only its own job target and an ordinary child receives no inherited review profile.

## Slice 6 — Bind restricted CLI tool execution

- [ ] RED. In `__tests__/mesh-jobs/headless-review.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/headless-review.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/cli.ts`. Bind the validated CLI job envelope into tool execution for all review rounds. Refuse a malformed restricted envelope and emit normalized job profile/action metadata.
- [ ] Run `bun test __tests__/mesh-jobs/headless-review.test.ts` again, then `bun run typecheck && bun run build`.

- Headless review uses the bound policy on every round; missing or malformed restricted context makes no model or GitHub call.

## Slice 7 — Reserve one review verdict per bound turn

- [ ] RED. In `__tests__/tools/github-app.test.ts`, add the assertions below and run `bun test __tests__/tools/github-app.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/tools/github-app.ts`. Reuse the intent verdict lifecycle pattern for one PR review per bound turn. Distinguish proved failure and uncertain outcome so a retry is allowed only after read-only reconciliation.
- [ ] Run `bun test __tests__/tools/github-app.test.ts` again, then `bun run typecheck && bun run build`.

- A successful review posts once; an uncertain prior submission provides no second mutating call without confirmed absence.

## Approved issue criteria

- **SC-1** — Slices 1 and 6 test a review session requesting an action outside its allowlist. Assert the tool refuses it, emits a profile-bound refusal record and makes zero key or transport calls.
- **SC-2** — Slices 2 and 7 assert one permitted `action=review` submits exactly one review to the authorized PR and head via the existing app receipt path.
- **SC-3** — Slice 1 exercises `approve_intent` against a stubbed authorized intent-review job and asserts a permitted receipt. The same action from a PR review session receives an audited refusal with no write. Assert the existing issue scope and verdict budget in both runs.
- **SC-4** — Test every review profile with an allowed and forbidden action. The work session never receives `anima_github`, and its write capability is the existing `publish` tool. Verify work can call that tool without acquiring GitHub App access.

## Rollback

If the profile envelope and handler versions disagree, pause automated review processing and keep the handler enforcement in place until matching builds are restored. Review job retries remain subject to existing lease and receipt checks; reconcile an uncertain submission before retrying. Operators can review manually through their established authority. Do not widen the tool grant to resume an automated job.
