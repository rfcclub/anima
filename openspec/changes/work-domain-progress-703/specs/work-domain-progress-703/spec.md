## ADDED Requirements

### Requirement: Validated domain items

The work store MUST create, claim, update and query domain items with validated status, evidence and result values.

#### Scenario: Item lifecycle
- **WHEN** a current session creates, claims and completes an item with valid evidence and a typed result
- **THEN** a read returns its id, claim, status, evidence and result.

#### Scenario: Invalid values
- **WHEN** an update supplies an unknown status, malformed evidence, malformed result, or a completed status without a result
- **THEN** the update is rejected and the stored item remains unchanged.

### Requirement: Durable, fenced writes

The work store MUST bind every item write to a live session lease signal, the recorded lease claim and the current generation.

#### Scenario: Restart mid-item
- **WHEN** a store is reopened after a session stops midway through an item and a later session claims it
- **THEN** the prior item data remains readable and the later session can continue it.

#### Scenario: Stale generation
- **WHEN** a superseded session tries to update an item after another generation has claimed it
- **THEN** the write is rejected and the current item is unchanged.

#### Scenario: Lost lease
- **WHEN** the consumer aborts a session after a lease heartbeat reports loss and that session attempts a write, including with a replacement non-aborted signal
- **THEN** the write is rejected and the item remains unchanged.

#### Scenario: Duplicate update
- **WHEN** a current owner repeats the same typed update
- **THEN** it returns the same item without adding a duplicate or changing its revision.

### Requirement: Existing checkpoint compatibility

The store MUST leave existing checkpoint and session behavior unchanged.

#### Scenario: Existing records remain readable
- **WHEN** domain items are written beside existing work and session records
- **THEN** the existing session and event reads return their prior values.
