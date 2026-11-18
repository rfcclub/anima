# anima

Colony agent runtime — run persistent, identity-grounded AI agents with full tool access.

## What is anima?

Anima is a runtime for hosting AI agents ("rooms") that:

- Load their identity from files (`AGENTS.md`, `SOUL.md`) at boot
- Persist session memory across restarts via SQLite
- Connect to Telegram for real-time interaction
- Route across multiple LLM providers per mode (chatting, programming, philosophy, etc.)
- Support fine-grained tool policies (read/write/bash per root path)
- Run an inter-agent event bus (Agora) for colony coordination
- Provide a Web UI ("Agent Town") for visual monitoring

## Quickstart

### Prerequisites

- **Bun version in `.bun-version`** — install that release from [Bun](https://bun.sh/docs/installation)
- A room directory with a `config.yaml` (see [Room Config Reference](docs/ROOM_CONFIG.md) for every field)

### Install

```bash
git clone <repo> ~/work/anima
cd ~/work/anima
bun install
```

### Create your first room

```bash
mkdir -p ~/.anima/rooms/myagent/mount
# Create config.yaml (see docs/ROOM_CONFIG.md for a complete example):
# set identity.name, identity.label, provider.type, provider.model
$EDITOR ~/.anima/rooms/myagent/config.yaml
```

### Start the server

```bash
ANIMA_ROOMS_DIR=~/.anima/rooms bun start
```

The server listens on port `3700` by default (override with `PORT`).

### Talk to your agent via CLI

```bash
bun cli talk myagent "Hello, who are you?"
```

### Tool and endpoint notes

`anima_list_all` is an alias of `anima_memory_list`; both return `{entries, count}` and accept the same scope, limit and offset. The unimplemented `anima_sleep` and `context_expand` tools are omitted from discovery; existing calls return an explicit error.

Core `GET /cost` redirects local loopback requests to `/cost` at `ANIMA_UI_PORT` (default `3000`) only when `ANIMA_UI_ENABLED=true` and that port is valid. Disabled UI, invalid ports and public/proxy request URLs return an explicit `503 cost_ui_unavailable`; use the Web UI origin directly, including when it runs separately. The core cost JSON API remains available. This configuration check is not a live UI-health probe.

Unused-code candidates are reported by `bunx knip@6.43.0 --reporter json` using `knip.json`; a report is evidence for review, not permission to delete files.

### Start with the Web UI

```bash
ANIMA_UI_ENABLED=true bun start
```

## Development setup

Use Bun 1.4.4 (pinned in `.bun-version`). This version includes the upstream [extra-stdio descriptor ownership fix](https://github.com/oven-sh/bun/pull/33828); Bun 1.3.14 can close recycled descriptors during subprocess GC. `colony-mesh` is a private Git dependency pinned in `package.json` and the lockfile. Your SSH identity must have read access to `rfcclub/colony-mesh`; a sibling checkout is unnecessary. CI needs separately provisioned read-only access.

```bash
bun install --frozen-lockfile --ignore-scripts
bash .github/scripts/pin-bun-runtime.sh "$(command -v bun)"
bun run skills:sync
bun node_modules/playwright/cli.js install chromium
bun run typecheck
bun test
bun run --cwd packages/context-engine test
bun run --cwd packages/openclaw-anima-adapter test
bun run build
```

The local alias step keeps nested package scripts on the selected runtime: the locked Tailwind peer otherwise creates a Bun 1.3.14 shim. It verifies the selected executable against `.bun-version` and refuses an unexpected regular file. On Linux, install Chromium system dependencies with the same Playwright CLI and `install --with-deps chromium`.

The `CI` workflow runs on PRs and pushes to `master`. Its first job proves installation and typecheck in an empty Ubuntu 24.04 container with a reaping init; a dependent non-root hosted Ubuntu 22.04 VM job runs the full suite and builds, because the job container denies the user namespaces Chromium needs for its sandbox. It reads `.bun-version`, caches Bun's registry package directories while excluding Git dependency trees, installs the frozen lockfile without lifecycle scripts, verifies the generated local Bun alias against that runtime pin, then runs skills synchronization, typecheck, the full Bun suite and builds. Chromium and its system dependencies come from the locked local Playwright CLI; a sandboxed launch must succeed before tests run. Tests receive temporary HOME/state directories and no provider credentials.

Private dependency access in CI uses a dedicated **read-only** deploy key for the `colony-mesh` repository, stored as the repository Actions secret `COLONY_MESH_DEPLOY_KEY`. Fork pull requests do not receive this secret and cannot install the private dependency: the missing-key failure is explicit.

Context-engine's package script runs its Bun SQLite suites and its Vitest types suite separately. OpenClaw adapter's package script runs Node/Vitest tests; Bun's placeholder tests for Node-only files are not runtime coverage. Build context-engine before the Node adapters (`bun run --cwd packages/context-engine build`).
For a temporary local Mesh override in a disposable development checkout, run `bun link` from the Mesh checkout, then `bun link colony-mesh` from ANIMA. Keep the committed Git dependency and lockfile intact in PRs. All packages under `packages/*` are workspaces; source consumers use explicit `@anima/*` public exports. The hoisted linker preserves the shared tooling layout. Bun reads current library sources; Node adapters use built declarations and JavaScript.

`deploy.sh` stages a bundle manifest without source workspace dependencies. The prepared runtime manifest also omits the checkout-only `postinstall` and `skills:*` commands; skill copy generation runs when installing the source checkout. Its install step needs network access and an SSH identity with read access to the private `rfcclub/colony-mesh` repository.

## CLI Commands

| Command | Description |
|---------|-------------|
| `bun cli talk <agent> <message>` | Send a one-shot message to an agent |
| `bun cli meet <agent1> <agent2> [--turns=N]` | Start a meeting between two agents |
| `bun cli mode <agent> [mode]` | Get or set an agent's permission mode (`plan` / `edit` / `auto`) |
| `bun cli check-mail [agent]` | Check for unread meeting messages |
| `bun cli status` | List all agents and their current status |
| `bun cli session <agent>` | View or manage session state |

## Room Configuration

Each agent lives in a room directory containing a `config.yaml`. Key sections:

Path and shell-pattern checks default to `policy.enforce: warn`: a violating tool call is logged and still runs. `block` refuses the call; `off` skips these checks. The separate guard for GitHub App secret paths stays active even with `off`. Shell pattern matching is not a sandbox. See [Tool Policy](docs-site/tools/policy.md) for the exact rules and limits.

```yaml
identity:
  name: myagent            # unique agent identifier
  label: My Agent          # display name
  identityAnchor: "..."    # inline identity string injected at recency boundary

provider:
  type: wafer-ai           # matches a provider id in providers.d/
  model: GLM-5.1           # default model
  modeMap:                 # optional: per-task-mode model routing
    chatting:
      - wafer-ai@GLM-5.1
    programming:
      - anthropic@claude-sonnet-4-6

policy:
  enforce: warn           # off | warn | block; warn logs and still runs
  allowedRoots:            # directories the agent can access
    - /home/user/workspace
  readOnlyRoots: []        # roots where only read tools are allowed
  allowedTools:            # required when autoModeOptIn is true
    - read
    - grep
    - write
    - bash
  deniedPatterns: []       # shell patterns to block

session:
  defaultMode: auto        # plan | edit | auto
  autoModeOptIn: true      # enables autonomous tool use
  compactThreshold: 60000  # token count before compaction triggers
  idleTimeoutMs: 300000    # session idle timeout (ms)
  maxTokens: 4096          # max output tokens

boot:
  gene: AGENTS.md          # core directive file (system prompt header)
  soul: SOUL.md            # identity narrative (loaded every session)
  sessionContext:           # files loaded into context at boot
    - MEMORY.md
    - ~/substrate/myagent/IDENTITY.md
  extraActions:            # shell commands run at boot
    - label: vibeshift-boot
      run: bun -e '...'

memory:
  type: shared             # module | custom | shared
```

## Provider System

Providers are defined as YAML files in `providers.d/`:

```yaml
# providers.d/openai.yaml
id: openai
label: "OpenAI"
api: openai-completions     # openai-completions | anthropic-messages | openai-responses | generic
baseUrl: https://api.openai.com/v1
apiKey: ${OPENAI_API_KEY}   # env var syntax, also supports ${OAUTH:openai}
models:
  - id: gpt-5.2
  - id: gpt-4.1-mini
```

The `ModeRouter` resolves `type@model` references from room config `modeMap` entries and falls through a chain of providers on failure.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANIMA_ROOMS_DIR` | Path to the rooms directory (default: `./rooms`) |
| `ANIMA_STATE_DIR` | Path to state directory for sessions DB and boot ID (default: `./state`) |
| `ANIMA_SESSIONS_DB` | Override path to the sessions SQLite database |
| `ANIMA_UI_ENABLED` | Set to `"true"` to start the Agent Town Web UI alongside the server |
| `ANIMA_UI_HOST` | Address the Web UI binds to (default `127.0.0.1`; `0.0.0.0` exposes it to the network and trusts network clients, it is not authentication) |
| `ANIMA_UI_ALLOWED_ORIGINS` | Comma-separated origins (for example `http://host.example.com:3000`) that may call the Web UI API besides loopback; also the trusted `Host` names |
| `PORT` | HTTP server port (default: `3700`) |
| `ANIMA_TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `ANIMA_TELEGRAM_WEBHOOK_SECRET` | Secret token for webhook validation |
| `ANIMA_TELEGRAM_WEBHOOK_URL` | Public URL for Telegram webhook registration |
| `ANIMA_TELEGRAM_POLLING` | Set to `"true"` to use long-polling instead of webhooks |
| `OPENAI_API_KEY` | API key for OpenAI-compatible providers |
| `ANTHROPIC_API_KEY` | API key for Anthropic Claude provider |
| `GEMINI_API_KEY` | API key for Google Gemini provider |
| `WAFER_API_KEY` | API key for Wafer AI provider |

## Project Structure

```
src/
├── agents/          # Agent lifecycle: loader, prompter, session, loop mode
├── agora/           # Inter-agent event bus and colony coordination
├── cartridge/       # Cartridge registry and loader (modular agent extensions)
├── channels/        # Telegram gateway (webhook + polling), channel types
├── config/          # Room config types, YAML parser, validation
├── continuity/      # Staging, crossing, maturation, gate, vibe-shift
├── dream/           # Deep dream (daily cron) and lucid dream (on-demand reflection)
├── evaluation/      # Trust system, escalation, drift detection, evaluation pipeline
├── mcp/             # MCP server manager for external tool integration
├── meeting/         # Meeting room (A2A file-based), mail daemon
├── memory/          # Session store (SQLite), JSONL store, shared adapter, entity store
├── providers/       # Provider interface, registry, mode router, implementations
├── session/         # Session manager, compactor, boot-id detection
├── sovereignty/     # Agent sovereignty controls
├── tools/           # Tool definitions and executor
├── ui/              # Agent Town Web UI (React)
├── utils/           # Shared utilities
├── cli.ts           # CLI entry point
└── server.ts        # HTTP server entry point

rooms/               # Agent room directories (config.yaml + mount/)
providers.d/         # Provider YAML definitions
```

## Docs

| Doc | Contents |
|-----|----------|
| [Architecture](docs/ARCHITECTURE.md) | System overview, subsystems, data flow |
| [Room Config Reference](docs/ROOM_CONFIG.md) | Every `config.yaml` field with types and examples |
| [Provider Setup](docs/PROVIDER_SETUP.md) | `providers.d/*.yaml` format, built-ins, env vars |
| [Agent Boot Sequence](docs/AGENTS.md) | Boot order, identity files, extraActions, snapshots |
| [Telegram Channel](docs/channels/TELEGRAM.md) | Bot setup, env vars, webhook vs polling, routing |
| [CLI Reference](docs/CLI_REFERENCE.md) | All CLI commands and flags |
| [Memory & Sessions](docs/MEMORY.md) | SQLite schema, compaction, branching, MEMORY.md |
| [Server Operations](docs/SERVER_OPS.md) | Running in production, process management, logs |
| [Agent Town UI](docs/AGENT_TOWN_UI.md) | Web UI setup and features |

## Testing

```bash
bun test
```

## License

MIT. See `LICENSE`.

### Core HTTP access (port 3700)

The core server binds to `127.0.0.1` by default. Local CLI, deploy-health and
identity-runtime callers continue to work without an Origin header. Every route,
including `/ai/v1/*`, continuity and Telegram webhooks, rejects untrusted Host
headers and cross-origin browser mutations before dispatch.

Set `ANIMA_CORE_HOST` to opt into another bind address and list trusted public
origins in `ANIMA_CORE_ALLOWED_ORIGINS` (comma-separated, full scheme/host/port).
These settings are independent of `ANIMA_UI_HOST` and `ANIMA_UI_ALLOWED_ORIGINS`.
An exposed core server trusts that network: the Host/Origin check is **not bearer
authentication** and cannot stop a non-browser caller that supplies trusted
headers. Restrict remote access with a firewall or authenticated reverse proxy; keep the default loopback bind when
remote access is unnecessary.

Telegram polling needs no inbound exposure. Webhooks require a trusted proxy
Host (configured above) and the existing Telegram secret token; neither guard
is exempted.


### Repository-local OpenSpec skills

`skills/openspec-*` is the canonical source for the four OpenSpec skills. `bun install`
runs `bun run skills:sync`, creating ordinary `SKILL.md` copies under the repository's
`.agent`, `.claude`, `.codex`, `.factory`, `.gemini`, and `.qwen` skill directories.
Generated copies and their ownership manifests are ignored; other skills are preserved.
Use `bun run skills:check` for a read-only drift check, or `bun run skills:sync` after
editing a canonical source. If install used `--ignore-scripts`, run sync explicitly.

Sync refuses locally edited or unknown conflicting copies and symlink paths before
writing any target. Reconcile the named file with its canonical source manually and
rerun; do not discard an edit to make install pass. A stale owned copy is safe to update.
A regular `.DS_Store` Finder metadata file in a canonical skill directory is ignored
and never copied; symlinks, directories and other extra assets are refused.
This maintenance command assumes one local operator and is not a concurrent filesystem
sandbox. Agent skill discovery also depends on the agent's project trust and skill
settings; copied files alone are not evidence of a live session loading them.

Generated graphs, runtime `state/`, build metadata, backup files, package tarballs,
review output and `_archive/` copies are ignored. Regenerate local code graphs with
`graphify extract . --code-only --no-cluster`, then refresh using `graphify update .`.
Only the optional graph report remains tracked. Package installation uses Bun lockfiles.

The identity-client recall hook has [bounded per-session recall deduplication](docs/recall-session-dedup.md), including its privacy limits and decision budget.

### Native identity watcher integration tests

`bun test` always runs the watcher subscription, debounce and shutdown contracts
in isolated child processes with synthetic events and a controlled clock.
These contracts do not prove native filesystem event delivery or native timer accuracy.
On macOS with Bun 1.3.14 or 1.4.4, the two OS integration cases are opt-in; other
platforms and Bun versions run them by default:

```sh
ANIMA_TEST_OS_WATCH=1 bun test ./src/identity-runtime/core-identity-watcher.test.ts
```

Quarantined by default only on macOS/Bun 1.3.14 and 1.4.4: `SC-019/020: a burst of changes across watched files triggers exactly one rebuild`
and `SC-021: a change inside cacheDir never triggers a rebuild`.
Native event delivery has not been verified on those runtimes, so the skips are not passes. Keep this command separate and bounded
when investigating native watcher behavior.

CI supported-host exclusions: 28 Seatbelt integration cases in work/workspace, work/host-git-boundary and web-chat/{tool-boundary,session,startup,tool,host} run on Darwin with `/usr/bin/sandbox-exec`; other hosts print a reason and skip those cases. Unsupported web-chat activation is tested separately and must refuse before spawning. Skipped tests are not passes.
