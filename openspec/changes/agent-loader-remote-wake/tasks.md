# Tasks — Assign one Garden Hub wake owner per actor

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Resolve proposed wake ownership without starting a harness**
  - Files: `scripts/identity-*/agent-loader.sh`.
  - Implementation: Use an owner-approved actor and harness mapping. Explicit `GHUB_WAKE=0` disables wake. `GHUB_WAKE=1` overrides the default only for a known eligible actor with a valid launcher contract and the shared lease. Unknown or ambiguous inputs stay disabled. Preserve identity refusals.
  - Verification: `bun test scripts/identity-*/agent-loader-dispatch.test.ts`
  - Blocked on owner selection of an exclusive wake owner and confirmation of the external launcher contract.
- [ ] **S2 – Fence wake ownership for the harness lifetime**
  - Files: `scripts/identity-*/agent-loader.sh`, `scripts/identity-*/wake-lease.sh`.
  - Implementation: Claim one atomic per-actor lease before enabling wake, including explicit enable, and hold it for the actual harness lifetime. Release only after proven cessation. Reject unsupported locks, ambiguous ownership, pre-existing wake consumers outside the fence, and PID-only stale-owner proof.
  - Verification: `bun test scripts/identity-*/wake-lease.test.ts`
  - Blocked on owner selection of an exclusive wake owner and confirmation of the external launcher contract.
- [ ] **S3 – Qualify the external launcher wake handoff**
  - Files: `docs/identity-*/remote-wake.md`.
  - Implementation: Record the Claude dev-channel and OMP extension enable/disable contract with fake eligible and ineligible actors. Preserve existing Codex launch arguments and prove non-owner wake is disabled. If a launcher cannot opt out, keep activation blocked unless that launcher is the sole approved owner. External extension or launcher changes require their own work order.
  - Verification: Record the inspected interface, observed commands and exit status for this slice. Keep unrun checks explicit.
  - Blocked on owner selection of an exclusive wake owner and confirmation of the external launcher contract.

## Acceptance and verification

| Criterion | Required behavior | Evidence |
| --- | --- | --- |
| SC-1 | The designated Claude actor receives the Garden Hub dev-channel flag and the other actor does not. | S1/S3 fake dispatch assertions capture exact arguments and effective off behavior for both roles. |
| SC-2 | The designated OMP actor gets the wake extension flag and the other actor does not. | S3 fixture asserts exact flag/extension arguments and effective off behavior. Keep blocked until the external launcher supports both paths. |
| SC-3 | The Codex launch arguments stay unchanged. | S1/S3 compare the synthetic Codex argument vector and verify an ineligible launch cannot consume wake. Keep blocked if that combination cannot be demonstrated. |
| SC-4 | Explicit `GHUB_WAKE=0` or `1` wins over the ownership default without bypassing the lease. | S1/S2 check both flags, unset, invalid input, concurrent launches and an uncertain existing owner. |

## Rollback

Disable wake through the confirmed launcher interfaces. Wait for or prove the old owner has ceased before restoring the prior policy. Preserve identity settings and leave any uncertain live lease untouched.
