## Why

An unchanged repeated tool call can waste work sessions, but repetition also includes polling and incremental work. A counter alone cannot tell those cases apart.

## What Changes

- Observe host-run tool calls by comparing their result and a bounded fingerprint of the work's observable workspace state, including across sessions.
- Record classifications and prospective warnings or stops without retaining raw tool arguments or results.
- Allow explicitly identified polling and treat an unavailable state snapshot as unknown, not unchanged.
- Provide opt-in warning-then-stop enforcement. It is off by default and does not replace existing lease, generation, step, idempotency or reconciliation fences.

## Impact

The default in-process work adapter gains an additive local telemetry record. External adapters execute their tools in another runtime and do not currently expose an authoritative per-tool result; the host reports that observation as unavailable rather than claiming coverage. No deployment is part of this change.
