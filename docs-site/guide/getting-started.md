# Getting Started

This page takes you from a fresh clone to a first message with one agent. Everything below matches the code on `master`. If a step fails, check the file named next to it.

::: warning Run it on localhost only
The API has no authentication yet. Read [Security Status](./security.md) before you start the server.
:::

## Prerequisites

- **Bun.** `package.json` uses Bun for every script, and the server and CLI rely on Bun APIs (`Bun.serve`, `Bun.spawn`, `bun:sqlite`).
- **The `colony-mesh` package, checked out next to this repo.** `package.json` declares `"colony-mesh": "link:../colony-mesh"`, and both `src/cli.ts` and `src/server.ts` import it. Without `../colony-mesh`, `bun install` reports a failed package and every CLI command exits with `Cannot find package 'colony-mesh'`.
- An API key for at least one LLM provider (see [Providers](../providers/overview.md)).

## Install

```bash
git clone https://github.com/GotakoVN/anima.git
cd anima
bun install
```

## Pick one home directory

The CLI and the server look for rooms in different places by default:

| Component | Rooms directory | Provider files |
|-----------|-----------------|----------------|
| CLI (`src/cli.ts`, `AgentLoader`) | `$ANIMA_ROOMS_DIR`, else `~/.anima/rooms` | `$ANIMA_HOME/providers.d`, else `~/.anima/providers.d` |
| Server (`src/server.ts`) | `$ANIMA_ROOMS_DIR`, else `./rooms` (relative to the working directory) | `<rooms dir>/../providers.d` |

The simplest setup is to set `ANIMA_ROOMS_DIR=~/.anima/rooms` for both. Then the server and the CLI share `~/.anima/rooms` and `~/.anima/providers.d`.

```bash
export ANIMA_ROOMS_DIR="$HOME/.anima/rooms"
mkdir -p ~/.anima/rooms ~/.anima/providers.d
```

## Add a provider

Provider files are YAML documents in `providers.d/`. The repo ships examples in `providers.d/`. Here is a minimal OpenAI-compatible one:

```yaml
# ~/.anima/providers.d/openai.yaml
id: openai
label: "OpenAI"
api: openai-completions
baseUrl: https://api.openai.com/v1
apiKey: ${OPENAI_API_KEY}
models:
  - id: gpt-4.1-mini
```

`apiKey` supports `${VAR}`, `${VAR:-default}` and `${OAUTH:<source>}`. A file that references an unset variable is skipped with a warning. See [Providers](../providers/overview.md) for the full format.

::: tip
The CLI can only build `openai-completions` and `openai-responses` providers itself (`createProviderFromDef` in `src/cli.ts`), plus the built-in `claude` type. A provider with `api: anthropic-messages` works in the server but not from `anima talk` yet.
:::

## Create a room

A room is a directory named after the agent, with a `config.yaml` and the boot files it references.

```bash
mkdir -p ~/.anima/rooms/myagent
cd ~/.anima/rooms/myagent
printf '# Instructions\nYou are a helpful assistant.\n' > AGENTS.md
printf '## Identity Core\nI am My Agent.\n' > SOUL.md
```

```yaml
# ~/.anima/rooms/myagent/config.yaml
identity:
  name: myagent
  label: My Agent

provider:
  type: openai          # a provider id from providers.d/, or "claude"
  model: gpt-4.1-mini   # a model id listed in that provider file

policy:
  allowedRoots:         # required (not enforced yet, see Security Status)
    - ~/.anima/rooms/myagent
  allowedTools:         # tools offered to the model
    - read
    - grep
    - glob

session:
  defaultMode: plan     # plan | edit | auto

boot:
  gene: AGENTS.md       # required, becomes "## Instructions"
  soul: SOUL.md         # optional, becomes "## Soul"
  sessionContext:       # required, at least one entry
    - MEMORY.md         # created empty if it doesn't exist
```

The required fields are `identity.name`, `identity.label`, `provider.type`, `policy.allowedRoots`, `session.defaultMode`, `boot.gene` and a non-empty `boot.sessionContext`. See [Agent Config](../agents/config.md) for every key.

## Talk to the agent from the CLI

```bash
cd /path/to/anima
bun src/cli.ts talk myagent "Hello, who are you?"
# same thing through the package script:
bun run cli talk myagent "Hello, who are you?"
```

`talk` keeps a session in `~/.anima/sessions.db` (override with `ANIMA_SESSIONS_DB`). Run it again and the agent sees the earlier turns. `bun src/cli.ts status` lists every room it can load. See the [CLI Reference](../cli/reference.md) for all commands.

## Start the server

```bash
bun run start            # bun src/server.ts, port 3700 (PORT to override)
bun run dev              # same, with --watch
bun run start:ui         # also starts the Web UI on port 3000 (ANIMA_UI_PORT)
```

Check that it's up:

```bash
curl http://localhost:3700/health
curl http://localhost:3700/status
```

The server doesn't have a chat endpoint of its own. You chat through the [Web UI](../channels/web-ui.md), [Telegram](../channels/telegram.md), the [mesh](../channels/mesh.md) or the CLI. See [HTTP Channel](../channels/http.md) for the routes it does serve.

## Build these docs

```bash
bun run docs:dev       # vitepress dev docs-site (hot reload)
bun run docs:build     # vitepress build docs-site
bun run docs:preview   # preview the built site
```

The server serves the built site from `docs-site/.vitepress/dist` (or `ANIMA_DOCS_DIR`) under `/docs/`, so after a build it's at `http://localhost:3700/docs/` while the server runs.

## Next steps

- [Architecture](./architecture.md): how the pieces fit together
- [Agent Config](../agents/config.md): every `config.yaml` key
- [Tool Policy](../tools/policy.md): what the policy does and doesn't enforce today
