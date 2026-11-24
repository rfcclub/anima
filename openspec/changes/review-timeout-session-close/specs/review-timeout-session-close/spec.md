## ADDED Requirements

### Requirement: Close the owned headless review session
A headless review SHALL close its own recorded session on ordinary completion, setup failure after session creation, or SIGTERM while its event loop can run the handler.

#### Scenario: SIGTERM while the provider is pending
- **WHEN** A headless review with an open session is terminated by SIGTERM during a pending provider request
- **THEN** The subprocess exits with code 143 and its session has an end timestamp

#### Scenario: Concurrent reviews
- **WHEN** One of two independent pending headless reviews is terminated by SIGTERM
- **THEN** Its session is ended and the other review's session remains open

#### Scenario: Setup failure
- **WHEN** A headless review creates a session and then rejects its auto-permission configuration
- **THEN** The process fails and its own session has an end timestamp

#### Scenario: Normal completion
- **WHEN** A headless review finishes successfully
- **THEN** Its session has an end timestamp and its review output remains available
