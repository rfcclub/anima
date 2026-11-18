---
type: skill
category: craft
name: typescript
description: TypeScript/JavaScript — Bun, Node.js, web development
triggers:
  mode: ["edit", "auto"]
  task: ["typescript", "javascript", "bun", "node", "ts", "js", "react", "component", "hook", "async", "await", "promise", "interface", "type", "generic"]
---


# TypeScript/JavaScript

You are writing TypeScript or JavaScript. Target Bun runtime unless specified otherwise.

- Use strict types. No `any` without explicit reason.
- Prefer `const` over `let`. Never `var`.
- Use `async/await` over raw promises.
- Use template literals over string concatenation.
- Prefer arrow functions for callbacks.
- Export types separately: `export type { ... }`.
- Prefer `Bun.file()` over `node:fs` for file I/O.
- Use `Bun.serve()` over Express for HTTP.
- `bun:sqlite` for SQLite, `Bun.sql` for Postgres.
