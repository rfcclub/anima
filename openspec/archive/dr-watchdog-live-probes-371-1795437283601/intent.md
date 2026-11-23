# Intent: DR watchdog read-only live probes

Issue: rfcclub/anima#371

## Problem

The existing watchdog evaluates supplied launchd and TCP listener observations but cannot collect them. Unobserved ports, failed probes, and guessed owners must not become healthy observations.

## Desired Outcome

Collect bounded, read-only observations for configured launchd jobs and listening TCP ports. Attribute a listener to a configured owner only when its PID exactly matches that job's PID from the same collection.

## Scope

Add `scripts/dr/live-probes.ts` and `scripts/dr/live-probes.test.ts` using injected command execution, UID, and timeout. Return existing `LaunchdProbe` values and a discriminated complete-or-unknown port result. Do not invoke a shell. Probe configured labels and ports only.

## Non-Goals

Runner integration, scheduling, restarts, network health probes, deployment, changes to existing checks, and service or configuration changes.

## Constraints

Validate labels and ports before invoking commands; bound execution time and output. Do not include raw command output or secrets in errors. Permission failure, malformed or incomplete output, missing owner PID and ambiguous attribution are unknown. Tests use injected fakes only; no live commands, network or production writes.

## Success Criteria

- Fake launchctl and lsof results show exact-PID owner, foreign PID, owner plus foreign PID, same PID over IPv4 and IPv6, and confirmed no listeners; complete observations work with existing pure checks.
- Missing or ambiguous owner PID, malformed lsof output, permission error, timeout, and failed launchctl yield unknown for the affected port; one failed probe does not misreport another as healthy.
- Tests assert read-only commands, no shell, configured labels and ports only, and deadline and output limits. `bun test scripts/dr` and typecheck pass without touching a service.

## Intent Approval

Status: APPROVED

Approved by: `orca:approved` label on issue #371; reviewer identity not verified locally.
Date: 2026-11-22
