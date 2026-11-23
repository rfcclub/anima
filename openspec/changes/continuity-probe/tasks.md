# Tasks — Measure identity continuity outside the reply path

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Define deterministic continuity scoring**
  - Files: `src/identity-*/continuity-metrics.ts`.
  - Implementation: Score versioned agreement openings and identity-contract addressing with explicit unknown results. Use synthetic multilingual fixtures and ensure replies never appear in the result.
  - Verification: `bun test test/continuity-metrics.test.ts`
- [ ] **S2 – Define deterministic grounding and cross-session measures**
  - Files: `src/identity-*/continuity-metrics.ts`.
  - Implementation: Score substrate recall only when a trusted fact key can be compared. Group consistency by the same agent and scoring version across distinct existing sessions in a baseline cohort. Return unknown when the evidence is absent and retain no reply text.
  - Verification: `bun test __tests__/identity-*/continuity-grounding.test.ts`
- [ ] **S3 – Persist aggregate counters in a separate score store**
  - Files: `src/identity-*/continuity-score-store.ts`.
  - Implementation: Deduplicate finalized delivery events and store only per-measure aggregates. Verify repeat delivery, different measure versions, and no transcript persistence or memory writes.
  - Verification: `bun test __tests__/identity-*/continuity-score-store.test.ts`
- [ ] **S4 – Observe finalized replies without delaying delivery**
  - Files: `src/mesh-a2a/inbox-delivery.ts`, `src/identity-*/continuity-observer.ts`.
  - Implementation: Observe only the legacy Mesh branch where `finish` returns `replied` with a genuine, nonempty model response. Ignore `already`, `fenced`, failure and synthetic notices. Enqueue after delivery with a bounded transient queue and count drops. Leave brokered Mesh and other transports unmeasured until separately wired.
  - Verification: `bun test __tests__/identity-*/continuity-observer.test.ts`
- [ ] **S5 – Measure grounded disagreement in an authorized judged sample**
  - Files: `src/identity-*/continuity-judged-sample.ts`.
  - Implementation: Judge only comparable eligible samples with an owner-authorized zero-data-retention provider from a different model family. Blind the scorer to agent and source identity. Enforce the budget before dispatch and report exhaustion and unknown outcomes. Keep judging disabled by default.
  - Verification: `bun test __tests__/identity-*/continuity-judged-sample.test.ts`
- [ ] **S6 – Render baseline and recent-run comparisons**
  - Files: `src/identity-*/continuity-score-report.ts`.
  - Implementation: Report metric version, denominator, previous and baseline deltas. Compare only equal versions and report unmeasured cells. Use anonymous fixture labels.
  - Verification: `bun test test/continuity-score-report.test.ts`

- [ ] **S7 – Observe replies finalized by the brokered Mesh path**
  - Files: `src/continuity/mesh-session-handlers.ts`.
  - Implementation: Pass a genuine nonempty model reply to the existing observer only if `finish` returns `replied`. Preserve `markReplied` and lease ordering. Exclude replay, failures, fences and notices.
  - Verification: `bun test __tests__/continuity/mesh-session-observer.test.ts`

- [ ] **S8 – Qualify coverage and reply latency on existing sessions**
  - Files: `docs/identity-*/continuity-probe.md`.
  - Implementation: Define the pre-agreed added-latency threshold and coverage matrix. Record aggregate coverage for the approved roster on existing normal traffic, measured latency with the observer off and on, and remaining missing transport hooks. Any authorized run retains aggregate evidence only.
  - Verification: Use synthetic fixture evidence for the report shape. Record authorized roster coverage, unchanged session counts and measured latency or explicitly report them pending.

## Acceptance and verification

| Criterion | Required behavior | Evidence |
| --- | --- | --- |
| SC-1 | Every roster agent has stored scores after normal use with no extra sessions. | S4/S7 exercise both Mesh paths. S8 verifies existing session counts and aggregate coverage across the approved roster and records unmeasured channels as pending. |
| SC-2 | Each agent's memory and substrate stay byte-identical and the observer stores no reply text. | S3/S4/S7 compare fixture snapshots and scan the probe store and logs for a synthetic sentinel on success, failure and queue overflow. |
| SC-3 | The report shows pronoun misses, agreement openings, false-claim disagreement, substrate recall and between-session consistency against a baseline for each agent. | S1/S2/S5/S6 fixtures verify all five measures, same-version deltas and explicit unknown denominators. |
| SC-4 | Observing a reply adds no noticeable delay to reply delivery. | S4/S7 prove delivery precedes scoring and enforce a bounded enqueue. S8 compares delivery latency with the observer off and on against a pre-agreed threshold. |
| SC-5 | A model-judged sample stops at budget and reports the stop. | S5 tests exhaustion before the next provider call, and S6 reports the reason and counts. |

## Rollback

Disable observer and judged sampling. Stop the scoring queue and discard raw pending input. Retain or remove the aggregate database under the approved retention policy. Existing sessions and identity state continue on their current paths.
