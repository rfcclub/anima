# Intent: durable domain progress

Issue: rfcclub/anima#703

## Problem

Free-text checkpoints do not identify domain items, their current owners, or trustworthy results. A resumed or displaced worker cannot use them as a typed record of completed work.

## Desired Outcome

The existing work store exposes validated domain items whose claims are bound to the owning work session, lease claim and generation. Current checkpoint reads remain compatible.

## Scope

- Create, claim, update and query domain items with typed status, evidence and result.
- Reject writes by workers whose lease or generation no longer holds, and reject invalid values.
- Preserve committed progress across restart and make duplicate writes safe.

## Non-Goals

- A new runtime, external tracker, deployment, or change to existing checkpoint semantics.

## Constraints

- Keep existing lease and generation fences, step markers, idempotency and reconciliation in place.
- Treat untrusted values at the boundary as invalid rather than normalizing them to success.

## Success Criteria

- Items can be created, claimed, updated and queried through the typed interface while existing checkpoint reads keep working.
- A restart during an item preserves its progress and permits the next valid session to continue safely.
- A worker after losing its lease or generation cannot write item progress.
- Repeating an identical result does not duplicate or corrupt the item.
- An invalid status or result is rejected and never stored as success.

## Intent Approval

Status: APPROVED

Approval source: the issue's `orca:backlog` label describes its intent as approved; the issue remains unscheduled for the automated work loop.
