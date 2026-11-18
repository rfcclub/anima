---
type: skill
category: craft
name: qa-architecture
description: Architecture QA rules — YAGNI, consistency, bounded modules
triggers:
  mode: ["auto", "plan"]
  domain: ["architecture"]
---


# QA Cartridge: Architecture

Rules for reviewing architectural decisions and designs.

## Rule: YAGNI principle

**Type:** passive
**Severity:** warn

Do not add abstractions, interfaces, or configuration until there is a concrete
need for them. Prefer concrete implementations over generic frameworks.
If a module has only one implementation, no interface is needed.

## Rule: Internal consistency with existing code

**Type:** passive
**Severity:** error

New code must be consistent with existing patterns and conventions
in the codebase. Follow established naming, module structure, and
dependency injection patterns.

## Rule: No circular dependencies

**Type:** passive
**Severity:** error

Modules must not import from modules that transitively import them.
Utility modules should live at the leaf of the dependency graph.

## Rule: Bounded modules

**Type:** passive
**Severity:** warn

Each module should have a single responsibility. Modules should not
cross architectural boundaries (e.g., an agent module should not
directly access provider internals or UI state).
