## ADDED Requirements

### Requirement: Progress-aware observation

The host MUST classify repeated host-executed tool calls from their result and observable work state, retaining fingerprints rather than raw arguments or results. Comparisons MUST survive work-session boundaries.

#### Scenario: Unchanged repeat
- **WHEN** the same call returns the same result with the same complete observable workspace fingerprint
- **THEN** telemetry classifies it as `unchanged` and increments its unchanged streak.

#### Scenario: Changed result or state
- **WHEN** a repeated call produces a different result or a different observable workspace fingerprint
- **THEN** telemetry classifies it as `changed` and resets its unchanged streak.

#### Scenario: Across sessions
- **WHEN** a later current session repeats a call previously observed for the same work
- **THEN** the stored prior fingerprints are compared with the new result and state.

#### Scenario: Unavailable observation
- **WHEN** the result is uncertain or the workspace fingerprint cannot be computed completely within its bounds
- **THEN** telemetry classifies the result as `unknown` and no prospective enforcement is asserted.

### Requirement: Allowed polling and ownership telemetry

The host MUST recognize operator-designated polling without allowing it to trigger enforcement, and MUST distinguish stale and duplicate-worker observations from normal repetitions.

#### Scenario: Polling false positive
- **WHEN** an operator-designated polling call repeats with an unchanged result past the warning threshold
- **THEN** telemetry classifies it as `polling`, records the prospective intervention as a false positive and takes no enforcement action.

#### Scenario: Stale and duplicate worker
- **WHEN** an observation comes from a superseded generation or from a mismatched session claim
- **THEN** telemetry labels it `stale` or `duplicate_worker` respectively and does not update the valid owner's repeat history.

### Requirement: Phased intervention

Observe-only MUST be the default. An explicitly enabled enforcement setting MAY warn and subsequently stop only after the warning has been delivered to a later model turn.

#### Scenario: Observe only
- **WHEN** unchanged non-polling calls pass the prospective intervention threshold and enforcement is omitted or false
- **THEN** telemetry records each prospective warning or stop and the worker receives neither warning nor stop.

#### Scenario: Explicit enforcement
- **WHEN** enforcement is true and a current owner repeats the same non-polling call after receiving a warning on a later model turn
- **THEN** the loop ends as blocked after the completed tool marker, preserving the existing checkpoint path.

#### Scenario: Same-turn repeats
- **WHEN** several repeats occur in the same model turn before the warning can be delivered
- **THEN** no stop occurs in that turn.

#### Scenario: Policy ordering
- **WHEN** enforcement is enabled and unchanged calls recur on successive turns
- **THEN** the guard first chooses a warning and only then chooses a stop.

#### Scenario: Same-turn policy
- **WHEN** an enabled guard sees repeated calls in one turn after choosing a warning
- **THEN** it defers the stop until a subsequent turn.

### Requirement: Existing work safety

The guard MUST leave existing lease and generation fences, step markers, idempotency and reconciliation behavior intact.

#### Scenario: Regression suite
- **WHEN** the existing fencing, idempotency and step-marker suites run
- **THEN** all their assertions pass unchanged.
