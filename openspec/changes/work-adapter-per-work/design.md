# Design: work-adapter-per-work

## Architecture

`createProductionWorkRuntime` constructs one adapter from `externalAdapter`. The executor exposes that kind globally, and the consumer reserves and records it. Break this coupling at the existing session boundary. Resolve a work to `"loop" | "low"` before readiness. Require reservation to confirm the same authoritative kind before running. Pass the reserved adapter through execution, stops, continuation and publish fallback. Use registered author IDs only. `externalAdapter: "low"` remains the default for authors without an override. Missing or `"off"` means `"loop"`.

Record stop provenance where the adapter chooses its winning race result. Its signal promise carries `interruptionSource: "abort"` on the abort branch. Keep the local timer's `deadline` result and existing cessation checks. Propagate provenance on each early return fed by the same race. The consumer already converts a proven, current, lease-held abort caused by its own deadline to `deadline`; elapsed time and an aborted signal inspected afterward cannot establish provenance.

Load the programmer rules from host-owned task construction, ahead of serialized `WorkOrder`. Use static English instructions covering work order/issue/review text as task data, workspace scope, reporting a specific blocker and host-owned push/PR. Retain the runtime and gateway as the authorization boundaries. Inspect the exact packaged worker revision and its documented or emitted prompt in a scratch setup before implementing this slice. `worker.py` forwards task arguments and exposes no system-prompt override. Repository guide text may come from the checkout, so it cannot carry indispensable host instructions. If the built-in prompt is inaccessible, record that and verify the observable outbound task instead. The Low task carries no host substrate.

## Data model and migration

Add an optional `work.authorAdapters` map whose keys resolve to configured authors and whose values are exactly `loop` or `low`. Validate it at the Mesh config boundary and preserve it in the internal work config. Existing configurations keep their host default. No issue, review, work order or recovered prompt can set the adapter.

Store a nullable `works.adapter` pin. A new work pins the resolved adapter when it reserves its first session. Rehydrate old rows from the latest valid recorded session kind when available. For an old row with no valid recorded kind, resolve the host default or author override once at first reservation. Write the legacy pin and session together, and retain the pin across config reload, retry and revisions. An explicitly authorized handover, if added by the pool, must atomically update owner and pin on the next session boundary under the existing work lock and generation fence. Until such a transition exists, an author mismatch releases the claim. Legacy rows with contradictory adapter history require a conservative continuation and a named diagnostic if existing checkpoint rules refuse them.

Build both executors from a common dependency object and select readiness by pinned kind. Low readiness checks the container runtime and image and names the unavailable dependency before VM launch. Use the recorded session adapter in publish fallback for generated-file exclusions and continuation policy. Never route a failed Low readiness probe to Loop. The existing adapter runner and cessation logic remain responsible for reports after startup begins.

## Test strategy and dependencies

Use the race tests and session classifier, prompt serialization fixture, config parser, SQLite reopen tests and mixed-routing handler tests in `tasks.md`. Keep work pool #411 as the prerequisite for real mixed-author operation, and do not wait on it for the abort provenance or task prompt. The existing Low handoff path must reuse genuine adapter provenance when both changes land. #420 owns the operator-run scratch trial. No new runtime dependency is required.
