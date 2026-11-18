---
type: skill
category: craft
name: qa-external-action
description: External action QA rules — reversibility, scope, dry run
triggers:
  mode: ["auto", "edit"]
  domain: ["external_action"]
---


# QA Cartridge: External Action

Rules for reviewing external actions (API calls, file system changes, Telegram sends).

## Rule: Reversibility check

**Type:** passive
**Severity:** error

Irreversible actions (deletes, destructive writes, external sends) must always be
flagged for human review. If an action cannot be rolled back, recommendation must be "hold".

## Rule: Scope match

**Type:** passive
**Severity:** warn

The action must match the requested domain. A Telegram send should not be triggered
during a memory-write operation. Check that the action type aligns with the original intent.

## Rule: Dry run if possible

**Type:** passive
**Severity:** warn

If the system supports dry-run mode for this action type, it should be preferred
before executing the real action. Actions that succeed in dry-run are more likely
to succeed in production.
