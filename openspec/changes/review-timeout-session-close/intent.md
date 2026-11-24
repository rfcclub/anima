# Intent: close interrupted review sessions

## Raw Request
A terminated headless review should not leave its session open.

## Problem
A review timeout aborts its child with SIGTERM. The headless CLI closes its review session only in a JavaScript `finally`, which is skipped on default process termination. An isolated reproduction using the actual turn runner and session store exited 143 with the review session still open.

## Desired Outcome
A headless review process closes its own session when it receives SIGTERM or fails during setup after creating that session. The timeout remains a failure, and other sessions are untouched.

## Scope
The headless review CLI's session lifecycle and isolated subprocess tests. The general interactive talk and work paths retain their existing behavior.

## Non-Goals
Diagnosing why reviews exceed the timeout, changing the timeout or lane capacity, closing existing sessions, restart or deployment, or guaranteeing cleanup after SIGKILL, process crash, or database failure.

## Success Criteria
- A headless review whose synthetic provider is pending exits with code 143 after SIGTERM and its own session has an end timestamp.
- A separate running review session stays open when another is terminated.
- A normal review closes, and a headless setup error after session creation closes its session.
- No live services, sessions, providers, or real credentials are used in tests.

## Intent Approval
Status: APPROVED

Approved by: owner-delegated workflow debugging and repair; local, independently reviewable fix only.
Date: 2026-11-23
