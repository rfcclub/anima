# Review and development lanes

Source issue #77. Design and plan for review.

## Architecture

Keep the single Mesh queue and existing generic lease and claim behavior. Mesh is authoritative for subscription registration, lane topics and durable job/event deduplication. ANIMA adapts `src/mesh-jobs/client.ts` and existing dispatch/consumer paths. Map `review` and `review-intent` to `review`, `start-work` and `revise` to `development`; keep merge notice as a distinct event. Make lane classification server-owned and derive it from job type when reading existing rows. Use canonical lowercase repo plus item kind and number to key subscriptions, and add head SHA for PR reviews or policy-approved issue revision hash for intent reviews. On a first request atomically subscribe the authenticated creator and enqueue one review job. A replay or later head reuses that subscription. Opt-in subscriptions for additional actors require authorization to see the item. Persist delivery dedup keys per event and recipient; deliver after committed queue state and retry with the same id. Topic wakeups carry lane and event id only, while creator events carry a bounded item reference. Events tell recipients to recheck GitHub. A scheduler remains the polling backstop and returns without a model call when that worker has no pending compatible lane.

The approval handoff creates at most one active development job per canonical issue. Preserve issue body digest as provenance and validate it against GitHub before claim or continuation. If approval content changes, do not launch another development job beside it. Retire or reconcile the prior attempt before reconsidering. The claim lease remains the contention authority. Review routing excludes the author and uses at least two eligible reviewer offers; approval requirements are 1–3 and are bound to the exact head. Size thresholds require the owner's spec decision. Keep active-profile merge authority as configured; the lanes change only observes verified GitHub merges to close the linked work and queue job. When no valid current-head independent receipts exist, hold or report reconciliation evidence, with no automatic merge behavior added here. Mesh contract slices are an external prerequisite, so keep them distinct from ANIMA compatibility and feature slices. Work tickets for Mesh must target that repository only after the owner authorizes that destination.

## Mesh queue contract prerequisites

The queue and event service must supply the following before the gated ANIMA paths activate. The existing client paths remain usable while this contract is absent.

1. Derive the lane for old rows and enforce filter and worker identity on both pending count and atomic claim. A legacy unfiltered request preserves old behavior.
2. Accept an authenticated canonical review request with explicit author evidence from the polling or work source. Resolve the owner through trusted actor mapping. In one transaction deduplicate the job and upsert its creator subscription. Keep review revision independent from the item subscription key.
3. Persist an authorization-checked per-item subscription and an event outbox. Retry at-least-once delivery with a stable `(event id, subscriber id)` key. Publish a separate bounded lane-available hint on a new job, and preserve scheduler fallback.
4. Fence one active development job per issue using its canonical item key while its immutable revision digest is still checked. One lease holder may report. Only verified linked GitHub merge evidence closes the development workflow, and replay is idempotent.

These prerequisites are drafted as local companion tickets with their repository boundary stated in each.

## Test strategy

Use stubbed GitHub snapshots and an isolated queue fixture. Exercise duplicate requests and event deliveries, two competing claims, old-head approval rejection, issue revision and approval races, subscriber isolation, wake signal plus scheduler fallback and verified merge evidence. A live end-to-end acceptance run requires separate approval, a controlled issue and PR, and an independently authorized merge.

## Non-goals

Creating a second queue, adding automatic merge authority, enabling live services, inbound webhooks and new wake transport adapters are outside this work.
