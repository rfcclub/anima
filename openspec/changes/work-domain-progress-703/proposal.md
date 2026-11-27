## Why

A work session needs structured, durable records of its domain items so that a replacement session can distinguish unfinished work from trusted results.

## What Changes

- Add an additive, typed domain-item interface to the work store.
- Fence every mutation using the current session's lease signal, recorded lease claim and work generation, and revoke its domain write authority on observed lease loss.
- Validate stored status, evidence and result values and make repeated identical updates idempotent.

## Capabilities

### New Capabilities

- `work-domain-progress-703`: durable, claimed domain items in the work store.

### Modified Capabilities

None.

## Impact

The work-store SQLite schema gains additive item and revocation tables. Existing session, event and checkpoint APIs remain unchanged. No dependency or deployment is added.
