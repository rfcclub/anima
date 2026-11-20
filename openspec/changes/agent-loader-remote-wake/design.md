# Design — Assign one Garden Hub wake owner per actor

Parent intent: #90.

## Architecture

Resolve wake policy from an operator-selected actor and harness mapping. An atomic per-actor lease spans the actual harness lifetime; an explicit enable request must use the same fence. Establish how every relevant launcher honors both enable and disable before changing ownership, including a verified no-wake path for any otherwise-default consumer. Keep identity checks and unrelated launcher arguments. Missing external prerequisites or an already-running consumer outside the lease block activation. Reject uncertain ownership and require an owner decision before runtime wiring.

## Integration points

`scripts/identity-*/agent-loader.sh` and `scripts/identity-*/agent-loader-dispatch.test.ts` already define and exercise dispatch. The external launcher and wake extension are separate integration prerequisites.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Resolve proposed wake ownership without starting a harness.** Use an owner-approved actor and harness mapping. Explicit `GHUB_WAKE=0` disables wake. `GHUB_WAKE=1` overrides the default only for a known eligible actor with a valid launcher contract and the shared lease. Unknown or ambiguous inputs stay disabled. Preserve identity refusals.
- **S2. Fence wake ownership for the harness lifetime.** Claim one atomic per-actor lease before enabling wake, including explicit enable, and hold it for the actual harness lifetime. Release only after proven cessation. Reject unsupported locks, ambiguous ownership, pre-existing wake consumers outside the fence, and PID-only stale-owner proof.
- **S3. Qualify the external launcher wake handoff.** Record the Claude dev-channel and OMP extension enable/disable contract with fake eligible and ineligible actors. Preserve existing Codex launch arguments and prove non-owner wake is disabled. If a launcher cannot opt out, keep activation blocked unless that launcher is the sole approved owner. External extension or launcher changes require their own work order.
