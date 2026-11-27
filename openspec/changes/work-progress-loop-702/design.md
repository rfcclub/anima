# Design: progress-aware work-loop observation

## Boundary

Observe the in-process work adapter where the host has both the actual tool call and its result. A separate external adapter runs its own tools and cannot provide authoritative per-tool results through the current seam; record that its per-tool observation is unavailable rather than making up results. Do not change the external adapter or its gateway.

## State and classification

Store a per-work, per-call fingerprint and the last result fingerprint, observable state fingerprint and unchanged streak in an additive table. A matching current session updates this history in one transaction. An aborted or superseded generation is `stale`; a different recorded session claim is `duplicate_worker`; these produce telemetry but cannot alter the valid owner's history. Emit a distinct bounded event for each observation with classification, streak, polling, prospective intervention and actual action. Never store raw arguments, result text or file contents.

The work-state fingerprint covers the current work branch and bounded tracked or nonignored workspace files. Compute it inside the existing work sandbox and do not follow symlinks. If inspection is unsafe, incomplete, exceeds bounds, fails or times out, classify it as unknown and never enforce from that sample. This is observable local state, not proof about external effects or ignored files. A call/result fingerprint uses a deterministic digest; no provider text is copied into telemetry.

Each guard has a one-second total snapshot budget per session, including observe-only mode. Expiry aborts the current sandboxed child; later observations skip the snapshot, report unknown and mark the budget limit in telemetry. This bounds observation cost, but even bounded overhead can affect a tight deadline. Compare elapsed time and deadline outcomes against observation off before broad rollout, and collect a real false-positive baseline before enabling enforcement.

An unknown sample clears the fingerprints and streak for only that work and call, while retaining the advisory cache row. This durable invalidation prevents an old known sample from becoming an apparent match after a restart.

The operator can designate exact relative read paths or exact shell command strings for polling; a strictly recognized read-only Git status command is also polling. Commands are compared literally and are never executed by the guard. A polling call can record that an unqualified counter would have intervened, but cannot be warned or stopped. Changed results or states reset the streak.

## Rollout

An optional work setting enables enforcement and defaults to false. Operators must first assess the observe-only events and designate legitimate polling calls before enabling it. Unconfigured polling and progress outside the bounded observable worktree can otherwise be mistaken for an unchanged loop. At two consecutive unchanged repeats, a non-polling call is a prospective warning; subsequent repeats are prospective stops. In observe-only mode these appear only in telemetry. When explicitly enabled, the loop supplies a warning with the next tool-results message and stops only after the model has had a later turn to receive it; several calls in one turn cannot cause a stop before that delivery. A changed or unknown observation clears the prior warning state for that call, including a warning still pending within the same tool batch. A stop uses the existing blocked/checkpoint exit after the tool marker is closed. Telemetry errors never change execution.

## Tests

Unit tests exercise classification, persistence between sessions, stale/duplicate isolation, polling false positives, unknown snapshots, and observe-only behavior. Loop tests use a fake provider and host to prove real warning delivery and a later stop, and same-turn safety. Integration tests exercise the default setting, operator polling configuration, sandboxed snapshot changes, and the host execution seam. Existing lease, idempotency, recovery and marker tests run unchanged.
