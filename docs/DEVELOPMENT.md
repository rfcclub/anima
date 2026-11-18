# ANIMA Development Guide

## Prerequisites

- [Bun](https://bun.com) >= 1.3.11
- A Claude API key (for Claude provider) or Gemini API key

## Setup

```bash
# Clone and install
cd anima
bun install

# Seed agent rooms
bun run scripts/seed-room.ts

# Verify
bun cli status
```

## Running

```bash
# Server only (no UI)
bun start

# Server with Agent Town UI
ANIMA_UI_ENABLED=true bun start

# Development with hot reload
bun dev

# CLI one-shot (no server needed)
bun cli talk bruno "Hello"
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3700` | HTTP server port |
| `ANIMA_ROOMS_DIR` | `./rooms` | Path to rooms directory |
| `ANIMA_UI_ENABLED` | `false` | Enable Agent Town Web UI |
| `ANIMA_UI_PORT` | `3000` | Web UI port |
| `ANIMA_UI_STATE_DIR` | `./.anima-ui-state` | UI state directory |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `GEMINI_API_KEY` | — | Gemini API key |

## Project Structure

```
anima/
├── src/
│   ├── agents/          # Agent lifecycle
│   │   ├── loader.ts    # Room loading, mount validation
│   │   ├── prompter.ts  # System prompt builder
│   │   └── session.ts   # Agent session execution
│   ├── cli.ts           # CLI entry point
│   ├── config/
│   │   └── types.ts     # Config types + YAML validation
│   ├── meeting/
│   │   ├── types.ts     # A2A message schema + parser
│   │   ├── room.ts      # Meeting room writer
│   │   └── daemon.ts    # Mail checker (polling)
│   ├── memory/
│   │   └── jsonl-store.ts  # JSONL event storage
│   ├── providers/
│   │   ├── interface.ts # Provider contract
│   │   ├── anthropic.ts # Claude via agent SDK
│   │   ├── gemini.ts    # Gemini via generative-ai
│   │   ├── openai-compat.ts  # OpenAI-compatible API
│   │   ├── registry.ts  # External provider registry
│   │   └── router.ts    # Mode-based provider routing
│   ├── server.ts        # HTTP server
│   ├── session/
│   │   ├── types.ts     # Session types
│   │   ├── manager.ts   # Session lifecycle
│   │   └── compactor.ts # Session compaction
│   └── ui/
│       ├── server.ts    # UI HTTP server
│       ├── index.html   # SPA entry point
│       ├── components/  # React components
│       └── styles/      # CSS
├── test/                # Test files (mirrors src/)
├── scripts/
│   └── seed-room.ts     # Room seeding script
├── rooms/               # Agent rooms (runtime data)
├── docs/                # Documentation
└── openspec/            # Spec registry + change archive
```

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/jsonl-store.test.ts

# Watch mode
bun test --watch
```

### Testing Patterns

**Temp directory integration tests** — Most common pattern. Create a temp directory, run operations, verify file contents, clean up.

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
```

**Provider mocking** — Providers are mocked inline by implementing the `Provider` interface or using `mock.module` for SDK imports.

**Environment sandbox** — For server/UI tests, set `Bun.env` variables to point at temp directories, then dynamically `import()` the module under test.

## Adding a New Agent

1. Create the room directory:
   ```bash
   mkdir -p rooms/<name>/mount
   mkdir -p rooms/<name>/sessions
   ```

2. Create a `config.yaml`:
   ```yaml
   identity:
     name: nova
     label: Nova
   provider:
     type: claude
   policy:
     allowedRoots:
       - /home/user/work/nova
   session:
     defaultMode: plan
     autoModeOptIn: false
     compactThreshold: 60000
   boot:
     soul: SOUL.md
   ```

3. Create the SOUL.md in the room directory (or symlink from an existing substrate).

4. Use `bun run scripts/seed-room.ts --boot SOUL.md` to seed with defaults.

5. Verify: `bun cli status`

## Adding a New Provider

1. Implement the `Provider` interface in `src/providers/`:
   ```ts
   import type { Provider, ProviderRequest, ProviderResponse } from "./interface";

   export class MyProvider implements Provider {
     readonly name = "my-provider" as const;

     async query(req: ProviderRequest): Promise<ProviderResponse> {
       // implementation
     }
   }
   ```

2. Register in `src/cli.ts` or the provider registry.

3. Add tests following the existing provider test patterns in `test/`.

## Git Workflow

- Main branch: `master`
- Feature branches: `<feature-name>`
- Specs live in `openspec/specs/` (current truth) and `openspec/changes/` (in-progress)
- Archived changes in `openspec/changes/archive/`
- Commit messages: conventional, Co-Authored-By line included
