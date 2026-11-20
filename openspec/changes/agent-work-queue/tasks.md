# Implementation plan for Review and development lanes

Follow the slices in order. Each slice needs its own approval. Capture assertion failures before editing production code, then run the same focused test and the project build on the resulting head. Preserve Orca plan and code gate verdicts.

## Queue-side prerequisites

The queue-side work belongs to the Mesh repository. Sanity-check its lane filter and subscription contracts before creating or claiming dependent ANIMA work.

1. Land the shared store claimability filter, then forward it through service and HTTP. Keep existing unfiltered clients working.
2. Land the transactional review and creator-subscription primitive, then its authenticated request boundary.
3. Land recipient event outbox persistence, then connect the verified GitHub poller and lane notification producer to it. Keep the scheduler backstop.
4. Land the canonical development admission fence, then the evidence-bound completion API.

## Slice 1 — Classify legacy and new queue jobs by lane

- [ ] RED. In `__tests__/mesh-jobs/client.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/client.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/client.ts`. In the ANIMA Mesh client expose a pure mapping from existing review/intent and development/revise job types to named lanes. Unknown and non-work types remain unclassified, preserving the old wire shape.
- [ ] Run `bun test __tests__/mesh-jobs/client.test.ts` again, then `bun run typecheck && bun run build`.

- Current and legacy types map deterministically. Merge notices and unknown types cannot enter an actionable lane.

## Slice 2 — Request lane-compatible pending counts and claims

- [ ] RED. In `__tests__/mesh-jobs/client.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/client.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/client.ts`. Once the Mesh supports caller lane filters, validate and pass a typed optional lane to pending and claim calls. Keep omitted-filter clients on their existing contract.
- [ ] Run `bun test __tests__/mesh-jobs/client.test.ts` again, then `bun run typecheck && bun run build`.

- A filtered request sends the same allowed lane to pending and claim, and omitted filters preserve current compatibility.

## Slice 3 — Pull only for a worker’s assigned lane

- [ ] RED. In `__tests__/mesh-jobs/consumer.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/consumer.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/consumer.ts`. After Mesh filter support lands, bind each worker action to a configured lane, skipping model work on an empty answer and using identical lane and worker identity when claiming.
- [ ] Run `bun test __tests__/mesh-jobs/consumer.test.ts` again, then `bun run typecheck && bun run build`.

- An empty compatible queue makes zero model requests and a nonempty queue leads to one matching claim.

## Slice 4 — Unify canonical review request keys

- [ ] RED. In `__tests__/mesh-jobs/pipeline.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/pipeline.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/pipeline.ts`. At the discovery dispatch boundary use canonical repository, kind, number and revision when making review requests. Route via the idempotent server contract before activating this path.
- [ ] Run `bun test __tests__/mesh-jobs/pipeline.test.ts` again, then `bun run typecheck && bun run build`.

- Repeated polling enqueues one revision request and a changed head or approved intent revision gets a different key.

## Slice 5 — Use the canonical request for reconciliation reviews

- [ ] RED. In `__tests__/work/reconciler.test.ts`, add the assertions below and run `bun test __tests__/work/reconciler.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/work/reconciler.ts`. Update review requests from the work outbox to use the same canonical wire key as discovery, relying on the shared queue contract for creator subscription and deduplication.
- [ ] Run `bun test __tests__/work/reconciler.test.ts` again, then `bun run typecheck && bun run build`.

- Discovery and an outbox retry of the same PR head identify the same review job and do not recreate its subscription.

## Slice 6 — Avoid duplicate active development jobs

- [ ] RED. In `__tests__/mesh-jobs/pipeline.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/pipeline.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/pipeline.ts`. Once the queue accepts an issue-wide concurrency key, pass it and the verified body digest when dispatching approved issues. Do not enqueue when current GitHub evidence supersedes the selected issue version.
- [ ] Run `bun test __tests__/mesh-jobs/pipeline.test.ts` again, then `bun run typecheck && bun run build`.

- Approval polling and a body revision cannot create two active jobs for one issue.

## Slice 7 — Count independent exact-head review receipts

- [ ] RED. In `__tests__/mesh-jobs/consumer.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/consumer.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/consumer.ts`. After approval thresholds are approved in the spec, use them in the consumer’s evidence calculation. Deduplicate reviewer identities and ignore old-head approvals. Preserve the existing merge authorization policy.
- [ ] Run `bun test __tests__/mesh-jobs/consumer.test.ts` again, then `bun run typecheck && bun run build`.

- At least two reviewers are offered a PR; only the required count of independent exact-head receipts satisfies the review job.

## Slice 8 — Read durable lane wakeups as scheduler hints

- [ ] RED. In `__tests__/mesh-jobs/turn-runner.test.ts`, add the assertions below and run `bun test __tests__/mesh-jobs/turn-runner.test.ts`. Confirm the new assertion fails for the intended reason.
- [ ] GREEN. Modify `src/mesh-jobs/start.ts`. After the Mesh wake interface lands, have the runtime nudge the same filtered worker tick on a validated event, coalescing hints while leaving the periodic poll active.
- [ ] Run `bun test __tests__/mesh-jobs/turn-runner.test.ts` again, then `bun run typecheck && bun run build`.

- A wake hint causes an early pending check and a dropped hint leaves periodic claims working.

## Approved issue criteria

- **SC-1** — Exercise the Mesh transaction with two equivalent requests. Assert one review job and one creator subscription for the first request, with no new records on replay.
- **SC-2** — Replay a GitHub exact-head review receipt. The claimed job completes once after its required verified receipts and each subscriber receives one logical change event with the same stable delivery ID on retry.
- **SC-3** — Offer at least two eligible reviewer slots. Test one through three approvals against the approved size policy and reject stale-head receipts and duplicate reviewer identities.
- **SC-4** — Register an authorized second subscriber and assert it receives the same sequence of item change events as the creator. Verify there is no delivery to an unrelated actor.
- **SC-5** — A new review job notifies every subscribed review worker before the next cron tick. Suppress notifications in a fake-clock test and advance the five-minute fallback interval. Assert a compatible worker still claims the job.
- **SC-6** — Change the PR head or issue revision. A new request creates its own review job and retains the existing item subscription.
- **SC-7** — Repeat polling after `orca:approved` is added. The approved issue enters the development lane exactly once. A revised digest cannot create a concurrent active job.
- **SC-8** — Run two independent developers racing for one single-slot development job. Assert exactly one claim succeeds through the Mesh lease transaction.
- **SC-9** — Feed verified GitHub merge evidence for the linked PR. The pending development job completes, the worker admission slot is available, and that developer can claim the next job. A closed but unmerged PR, stale approval or unrelated PR must not produce this result.
- **SC-10** — An empty compatible lane makes zero model calls; a queued compatible item produces one claim across a scheduled poll and duplicate wake hints.
- **SC-11** — Run the full issue, review, revise, approval, claim, PR, review and merge evidence sequence in the deterministic fixture first. Record one controlled live round only after separate authorization for the live repository actions. Preserve authenticated event receipts and the exact reviewed head.

The agent–harness pair in #74 supplies creator and developer identity context. No inbound webhook or new automatic merge behavior is in scope.

## Rollback

Disable lane hints and new worker filters while retaining compatible queue reads. Keep the scheduler fallback, subscribers, active leases and idempotency keys. Drain or reconcile in-flight jobs before reverting the queue contract. Leave GitHub and the verified event history untouched. Retain approval-threshold checks once activated, and pause ambiguous claims for operator review rather than accepting duplicate starts.
