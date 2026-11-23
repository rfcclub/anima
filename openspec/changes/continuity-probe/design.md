# Design — Measure identity continuity outside the reply path

Parent intent: #49.

## Architecture

Collect continuity scores only after successful transport finalization using a bounded opt-in observer. Model generation alone does not prove delivery. Keep any raw input in a bounded in-memory queue until scoring finishes or drops it. Never serialize or log reply text, including on scoring errors. Persist only aggregates by agent, model, measure version and run, with an opaque deduplication token when needed. Add deterministic scores first, then separately authorized different-family judged sampling using retention-approved policy and hard budgets. Track applicability and unknown denominators. Any future ledger integration needs an approved aggregate-only contract.

## Integration points

Observe legacy A2A finalization in `src/mesh-a2a/inbox-delivery.ts` first and brokered finalization in `src/continuity/mesh-session-handlers.ts` in a separate slice. Keep scoring and aggregates under `src/identity-*/`. Coverage for any other transport needs a verified post-delivery hook of its own. Wait for #422 review where a proposed dependency would use the continuity ledger. Keep write capability separate from the identity substrate.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Define deterministic continuity scoring.** Score versioned agreement openings and identity-contract addressing with explicit unknown results. Use synthetic multilingual fixtures and ensure replies never appear in the result.
- **S2. Define deterministic grounding and cross-session measures.** Score substrate recall only when a trusted fact key can be compared. Group consistency by the same agent and scoring version across distinct existing sessions in a baseline cohort. Return unknown when the evidence is absent and retain no reply text.
- **S3. Persist aggregate counters in a separate score store.** Deduplicate finalized delivery events and store only per-measure aggregates. Verify repeat delivery, different measure versions, and no transcript persistence or memory writes.
- **S4. Observe finalized replies without delaying delivery.** Observe only the legacy Mesh branch where `finish` returns `replied` with a genuine, nonempty model response. Ignore `already`, `fenced`, failure and synthetic notices. Enqueue after delivery with a bounded transient queue and count drops. Leave brokered Mesh and other transports unmeasured until separately wired.
- **S5. Measure grounded disagreement in an authorized judged sample.** Judge only comparable eligible samples with an owner-authorized zero-data-retention provider from a different model family. Blind the scorer to agent and source identity. Enforce the budget before dispatch and report exhaustion and unknown outcomes. Keep judging disabled by default.
- **S6. Render baseline and recent-run comparisons.** Report metric version, denominator, previous and baseline deltas. Compare only equal versions and report unmeasured cells. Use anonymous fixture labels.
- **S7. Observe replies finalized by the brokered Mesh path.** Pass a genuine nonempty model reply to the existing observer only if `finish` returns `replied`. Preserve `markReplied` and lease ordering. Exclude replay, failures, fences and notices.
- **S8. Qualify coverage and reply latency on existing sessions.** Define the pre-agreed added-latency threshold and coverage matrix. Record aggregate coverage for the approved roster on existing normal traffic, measured latency with the observer off and on, and remaining missing transport hooks. Any authorized run retains aggregate evidence only.
