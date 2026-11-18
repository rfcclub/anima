---
type: skill
category: craft
name: qa-code
description: Code review QA rules — active tests and passive checks
triggers:
  mode: ["auto", "edit"]
  domain: ["code", "code_review"]
---


# QA Cartridge: Code

Active tests and passive checks for code review.

## Rule: Run test suite

**Type:** active
**Severity:** error

Run the project test suite to verify no regressions.
**Run:** `bun test`

## Rule: Type check

**Type:** active
**Severity:** error

Run TypeScript compiler check for type errors.
**Run:** `tsc --noEmit`

## Rule: No debug logs

**Type:** passive
**Severity:** warn

Output must not contain console.log or console.debug statements outside of test files.

## Rule: YAGNI — no premature abstraction

**Type:** passive
**Severity:** warn

Avoid abstract base classes, generic factories, and manager/provider patterns unless there is more than one concrete use case. Code should be concrete and minimal.

## Rule: No dead code

**Type:** passive
**Severity:** warn

No large commented-out code blocks. Remove unused functions, parameters, and imports. No TODO, FIXME, HACK, or XXX markers in production code.

## Rule: Error handling at boundaries

**Type:** passive
**Severity:** warn

try-catch blocks should only appear at module boundaries (entry points, event handlers, API routes). Internal functions should let errors propagate.

## Rule: Check file read access

**Type:** active
**Severity:** warn

Verify that referenced files exist and are readable.
**Run:** `cat`
