# Intent: progress-aware repeated-call protection

Issue: rfcclub/anima#702

## Problem

Repeated work calls can consume sessions without progress, but repetition alone also describes legitimate polling and successful incremental work.

## Desired Outcome

The work execution path classifies repeated calls using their outcomes and work state. It records prospective interventions before any enforcement and makes enforcement opt-in.

## Scope

- Distinguish unchanged repeated results and work state from changed results or state.
- Allow legitimate polling, including repeated unchanged observations that are expected to change.
- Record inspectable prospective interventions and false-positive cases in observe-only mode.
- Gate warning-then-stop enforcement behind an explicit setting that defaults off.

## Non-Goals

- A new runtime, session handoff implementation, deployment, or changing existing lease, generation, step marker, idempotency or reconciliation behavior.

## Success Criteria

- Unchanged repeated calls, changed results or state, legitimate polling, and stale or duplicate workers produce distinct inspectable telemetry.
- Observe-only mode records prospective interventions without warning or stopping the worker.
- Enforcement defaults off and, when explicitly enabled, warns before stopping; tests cover polling and other false-positive cases.
- Existing fencing and idempotency tests pass unchanged.

## Intent Approval

Status: APPROVED

Approval source: the issue's `orca:backlog` label describes its intent as approved; the issue remains unscheduled for the automated work loop.
