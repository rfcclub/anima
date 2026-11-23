# DR watchdog live probes Specification

Issue: rfcclub/anima#371

## Purpose

Supply read-only, bounded process and listening-port observations to the watchdog without inventing ownership.

## ADDED Requirements

### Requirement: Collect configured observations

The module SHALL validate inputs and use bounded shell-free commands for configured jobs and ports only.

#### Scenario: Configured command arguments
- **WHEN** valid labels and ports are collected
- **THEN** only the configured launchd targets and TCP ports are passed through bounded read-only argument arrays.

#### Scenario: Invalid input
- **WHEN** a label, port, owner, UID, timeout or collection size is invalid
- **THEN** the request fails before any command executes.

#### Scenario: Deadline
- **WHEN** an injected command hangs
- **THEN** the result becomes unknown within the deadline.

### Requirement: Attribute listeners

The module SHALL attribute a listener only through an exact, uniquely known PID match and SHALL preserve process identity for the existing checks.

#### Scenario: Complete listener cases
- **WHEN** fake results show an owner, foreign process, mixed processes, dual-stack sockets or no matches
- **THEN** complete results are compatible with the existing port checks.

#### Scenario: Nested launchd state
- **WHEN** a running job contains nested state or counter fields
- **THEN** the checks use only the job's root fields and can still identify its listener.

### Requirement: Fail closed

The module SHALL keep missing, malformed, failed or ambiguous observations unknown, without exposing command diagnostics in reasons.

#### Scenario: Missing and ambiguous job PIDs
- **WHEN** the expected PID is missing, duplicated, ambiguous or unavailable
- **THEN** the affected port is unknown.

#### Scenario: Unmatched listener PID
- **WHEN** a listener PID cannot be matched uniquely, alone or alongside the expected owner
- **THEN** the affected port is unknown.

#### Scenario: Incomplete port results
- **WHEN** lsof fails, returns malformed fields, exceeds the output cap or cannot verify a numeric listener address
- **THEN** the affected port is unknown and raw diagnostics are omitted.

#### Scenario: Nested job PID
- **WHEN** a nested launchd block contains a PID rather than the job itself
- **THEN** that PID is ignored, the launchd result uses only root fields and the port observation remains unknown.

#### Scenario: Unrelated failed job
- **WHEN** another configured job cannot be observed
- **THEN** no listener is incorrectly classified as healthy or foreign.
