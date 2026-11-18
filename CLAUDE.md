# ANIMA - Project Guide

ANIMA is a multi-agent colony runtime: a Bun/TypeScript backend (agents, memory, narrative, garden) serving a React SPA UI.

## Runtime

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Project Structure

```
src/
  server.ts            # backend entry (bun src/server.ts)
  cli.ts                # CLI entry (bun src/cli.ts)
  ui/                   # React SPA
    app/                # SPA shell: App.tsx, main.tsx, routes.tsx, router.ts, server.ts
    features/           # one folder per UI feature (castle, cost, logs, status, town, vn-assets, work)
    components/         # shared React components
    services/           # shared UI services (session-store, etc.)
    styles/             # global CSS
    assets/             # static UI assets
  api/                  # backend API handlers
  agents/               # agent substrate + prompter
  continuity/           # agent state + reflection engine
  garden/               # tick engine, briefs, projection (colony autonomy)
  narrative/            # shared narrative store (places, presence)
  memory/               # memory subsystem
  channels/             # chat channels
  session/              # session management
  config/               # config + themes
packages/
  context-engine/       # context ingestion
  cache-layer/          # caching
scripts/                # deploy, install and maintenance scripts
data/colony.json        # colony roster
__tests__/              # bun:test suites, mirrors src/ layout
```

## Commands

```sh
bun run dev          # backend watch (port 3700)
bun run dev:ui       # backend + UI server (port 3000 + 3700)
bun run start:ui     # UI-enabled server
bun run test         # full test suite
bun run typecheck    # tsc --noEmit
bun run deploy       # build + sync to the runtime directory (scripts/deploy.sh)
bun run build        # build server.js + cli.js only
```

## React UI Conventions

- **SPA entry:** `src/ui/app/main.tsx` -> `App.tsx` -> `routes.tsx` (react-router-dom). Server is `src/ui/app/server.ts` (Bun.serve, port 3000).
- **Feature folders** (`src/ui/features/<name>/`): React pages and components only. Server route handlers belong in `src/ui/app/` or a dedicated routes module; API client functions belong in `src/ui/services/` or `src/api/`.
- **Styling:** Tailwind + CSS, no CSS-in-JS. No hard-coded hex colors: repeated colors are Tailwind v4 `@theme` tokens in `src/ui/styles/tailwind.css`.
- **Data fetching:** fetch from `/api/*` in service modules or hooks, not inline in render.

## Security and publication rules

This repository is public. Everything committed, and every issue, pull request and comment, is public and permanent.

- English only. No personal data: names, emails, chat identifiers, hostnames, absolute paths of a real user, provider endpoints or account names, keys or tokens.
- Commit with a GitHub noreply address only.
- Evidence logs, receipts, handoffs, run state and transcripts stay on the machine and are gitignored.
- Before pushing, run `bun scripts/publish-guard.ts . --public --history` and fix every error.
- If you are unsure whether something may be published, ask before publishing it.
