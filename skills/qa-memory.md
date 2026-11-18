---
type: skill
category: craft
name: qa-memory
description: Memory write QA rules — validate substrate/ANIMA structure
triggers:
  mode: ["auto", "edit"]
  domain: ["memory", "memory_write"]
---


# QA Cartridge: Memory

Validation rules for memory writes to substrate/ANIMA.

## Rule: Valid substrate structure

**Type:** passive
**Severity:** error

Memory writes must respect the substrate directory structure
(0_SOUL, 1_EGO, 2_MIND, 3_BODY, 4_RELATIONS, 5_ENGINE).
Writes to 0_SOUL require explicit axiom-write flag.

## Rule: Axiom consistency

**Type:** passive
**Severity:** error

New memory entries must not contradict existing axioms in 0_SOUL/axioms.md.
If a contradiction is detected, flag for review.

## Rule: No direct 0_SOUL write without flag

**Type:** passive
**Severity:** error

Writing to 0_SOUL requires the `--axiom-write` flag. If the flag is absent
and the target path includes 0_SOUL, reject the output.

## Rule: Valid timestamp format

**Type:** passive
**Severity:** warn

Memory entries must use ISO 8601 timestamp format.
