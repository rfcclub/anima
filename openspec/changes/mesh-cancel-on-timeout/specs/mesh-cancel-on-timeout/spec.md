## ADDED Requirements

### Requirement: Cooperative cancellation for timed-out mesh turns
A mesh request MUST propagate its abort signal to the agent session. An abort MUST prevent a turn from starting after the conversation check and prevent new provider calls and tools after the turn loop observes it. Late replies MUST remain fenced.

#### Scenario: SC-1 Signal reaches the running mesh turn
- **WHEN** a mesh session starts a turn and its abort signal fires
- **THEN** the turn receives the same aborted signal and the late reply count = 0.

#### Scenario: SC-2 Abort during conversation check
- **WHEN** the signal fires before the asynchronous conversation check returns
- **THEN** the number of turns started = 0.

#### Scenario: SC-3 Delayed provider response after cancellation
- **WHEN** a synthetic provider returns a file-write tool call after the session signal fires
- **THEN** the marker file exists = false and the provider query count = 1.

#### Scenario: SC-4 Ordinary request
- **WHEN** an un-aborted mesh request returns an answer
- **THEN** the conversation reply count = 1 and the reply contains the answer.

#### Scenario: SC-5 Cancellation while a tool event is observed
- **WHEN** cancellation occurs while a tool event is being observed
- **THEN** the number of tool executions = 0.

#### Scenario: SC-6 Cancellation during a permission decision
- **WHEN** cancellation occurs while an asynchronous permission decision is pending
- **THEN** the number of tool executions = 0.

#### Scenario: SC-7 Cancellation in a fallback chain
- **WHEN** a backend reports an error caused by request cancellation in the configured retry chain
- **THEN** subsequent backend calls = 0 and failure records caused by cancellation = 0.

#### Scenario: SC-8 Cancellation in a mode map
- **WHEN** a backend reports an error caused by request cancellation in mode-map routing
- **THEN** subsequent backend calls = 0 and failure records caused by cancellation = 0.
