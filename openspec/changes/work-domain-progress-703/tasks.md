# Tasks: durable domain progress

## SC-1: Typed item lifecycle and existing checkpoint reads

- [x] In `__tests__/work/domain-progress.test.ts`, assert that the store creates an item for a reserved session, claims it, updates its status/evidence/result, and returns the same values through get/list. Capture a real assertion-failure RED before implementing the interface.
- [x] In `src/work/store.ts`, define `DomainProgressOwner`, `DomainProgressItem`, status/evidence/result types and `createDomainItem`, `claimDomainItem`, `updateDomainItem`, `getDomainItem`, and `listDomainItems`. Add `work_domain_items` keyed by `(work_id, item_id)` with session, lease claim, generation, status, evidence, result and revision columns.
- [x] In a separate test, record a work session and event, write a domain item, and assert that existing session and event reads are unchanged.

## SC-2: Restart during an item

- [x] Test a file-backed store: create an `in_progress` item, close and reopen the database, recover the old open session, reserve a new generation, claim the existing item and assert its evidence survives before finishing it.
- [x] In `claimDomainItem`, transfer the claim only after verifying the new session's work, open status, lease claim and current generation; preserve the existing status, evidence and result.

## SC-3: Worker loses lease or generation

- [x] Run each create, claim and update in an immediate SQLite transaction. Check the host-supplied abort signal, the running work's current generation, the matching open session and lease claim, and a durable revoked-session marker; require the stored owner claim to match for updates.
- [x] Add `work_domain_revoked_leases` and a host-side store operation that validates the session claim, marks the session revoked in memory, and persists the revocation. When a heartbeat reports lease loss or is unanswered, invoke it before aborting the session; keep the in-memory fence if persistence fails and still abort.
- [x] Test an old generation after a replacement session claims the item. Test a heartbeat `LeaseLostError` through the existing consumer, then attempt updates using both its aborted session signal and a fresh replacement signal and assert the item is unchanged. Do not claim a synchronous remote lease check: the fence follows the existing heartbeat.
- [x] Test a current but unauthorized session: updating another session's item before claiming it is forbidden and leaves the item unchanged; claiming it first permits the update.

## SC-4: Duplicate result

- [x] Test the same typed result and evidence written twice by the same current owner; assert one item, unchanged contents and unchanged revision on the second write.
- [x] Canonicalize validated JSON values before comparison; update the row and increment revision only when the status, evidence or result differs.

## SC-5: Invalid status or result

- [x] Reject untrusted values at the boundary rather than normalizing them to success: validate the four status literals, evidence entry types, discriminated result values and finite, acyclic JSON. Require a result for `completed`; reject an invalid status or result and never store it as success.
- [x] Test malformed values, an unknown status, a non-finite number, a cyclic value and completion without a result; assert the prior row and revision remain intact.

## Verification

- [x] Run the focused domain, store, consumer, step and fencing tests, typecheck and build. Run `orca verify`, `orca gate-plan`, and `orca gate-code`; retain their actual outputs and do not equate coverage bookkeeping with execution.

## Review regressions

- [x] Capture a failing sparse-evidence test; reject sparse and malformed indexed entries without mutating the row.
- [x] Capture a failing delayed-retry test; require an expected revision, allow an immediate identical retry, reject stale writes and allow deliberate reopening at the current revision.
- [x] Capture a failing mismatched-revocation test; validate the tuple before marking it revoked, while preserving the local fence if the database write fails.
