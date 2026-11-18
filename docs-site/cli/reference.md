# CLI Reference

The CLI lives in `src/cli.ts`. Every command on this page comes from the `switch` in `main()` there. If a command isn't listed here, the CLI doesn't have it.

## Running the CLI

`package.json` has no `bin` entry, so there is no global `anima` command after `bun install`. From the repo, run:

```bash
bun src/cli.ts <command> [args]
bun run cli <command> [args]      # same, via the "cli" script
```

`scripts/install.sh` writes a wrapper at `~/.local/bin/anima` that runs `bun run dist/cli.js` from `$ANIMA_HOME` (default `~/.anima`). The examples below use `anima` as shorthand for either form.

Running with no command, or an unknown command, prints the usage text and exits with code `1`.

## Flag syntax

`parseArgs()` accepts:

- `--flag value` and `--flag=value`
- `-f value` (single letter)
- `--flag` alone, which sets the flag to `true`

A value that starts with `-` is not taken as a flag value.

## Commands

| Command | Purpose |
|---------|---------|
| [`talk`](#talk) | Send one message to an agent, or run a loop |
| [`session`](#session) | Show, reset or compact an agent's CLI session |
| [`status`](#status) | List rooms and whether they load |
| [`mode`](#mode) | Show or set the global task mode |
| [`meet`](#meet) | Run a round-robin meeting between agents |
| [`send-mail`](#send-mail) | Send a mesh message from one agent to another |
| [`check-mail`](#check-mail) | Show unread mesh and meeting mail |
| [`beam`](#beam) | Write a beam into an agent's dream staging |
| [`cartridge`](#cartridge) | List, validate or expand cartridges |
| [`/cartridge`](#cartridge-slash) | Show one cartridge, or list them |
| [`seed`](#seed) | Seed a room from a substrate directory |
| [`rotate-abel-token`](#rotate-abel-token) | Generate a new 2B bearer token |
| [`restart`](#restart) | Stop the dev server and restart the production service |

### talk

```bash
anima talk <agent> "<message>"
anima talk -a <agent> -m "<message>" [options]
```

| Flag | Meaning |
|------|---------|
| `--agent`, `-a` | Agent name (or first positional argument) |
| `--message`, `-m` | Message (or second positional argument) |
| `--permission plan\|edit\|auto` | Permission mode for this call. Default: `session.defaultMode` |
| `--mode <value>` | A task mode (`chatting`, `programming`, `image`, `private`, `philosophy`, `creative`). `plan`, `edit` or `auto` here is treated as `--permission` |
| `--provider <id>` | Override `provider.type` (`claude`, `router`, or a provider id from `providers.d/`) |
| `--model <id>` | Override `provider.model` |
| `--loop` | Loop mode: keep calling the agent until it emits `<DONE ...>` |
| `--max <n>` | Loop iterations (default `10`, capped at `50`) |

What `talk` does:

1. Loads the room with `AgentLoader` (rooms from `ANIMA_ROOMS_DIR` or `~/.anima/rooms`).
2. Opens the agent's `talk` session in `~/.anima/sessions.db` (or `ANIMA_SESSIONS_DB`) and replays its turns.
3. Adds unread meeting mail to the context.
4. Refuses `auto` mode unless the room sets `session.autoModeOptIn: true`.
5. Recalls memory, builds the system prompt, and calls the provider with the tools listed in `policy.allowedTools`.
6. Runs the returned tool calls, up to 4 follow-up rounds, then prints the final text.
7. Runs compaction when the session crosses its threshold.

In `auto` mode, a tool call whose name isn't in `policy.allowedTools` is blocked and logged as a `tool_blocked` event.

Loop-mode exit codes: `0` when the agent signals done or you interrupt it, `1` when it hits `--max`, `2` on error.

::: info Provider support
`talk` builds providers itself. It supports `claude` (Claude Agent SDK), `router` (task-mode routing through `~/.anima/mode-map.yaml`), and `providers.d` entries with `api: openai-completions` or `api: openai-responses`. Other `api` values fail with `provider not implemented`.
:::

`talk` also writes default files when they're missing: `~/.anima/providers.d/gemini.yaml` and `~/.anima/mode-map.yaml`.

### session

```bash
anima session [status] <agent>
anima session <agent> --reset
anima session <agent> --compact [--provider <id>] [--model <id>]
```

Uses the agent's `cli` session (not the `talk` session).

- With no flag, prints JSON: `agent`, `sessionId`, `turnCount`, `unreadMail`, `estimatedTokens`.
- `--reset` clears the session.
- `--compact` summarizes the session's turns with the agent's provider.

### status

```bash
anima status
```

Prints JSON with one row per room: `name`, `label`, `provider`, `mount` (`ok` or `fail`) and `lastSession`. Directories that start with `_` and rooms without a valid `config.yaml` are skipped.

### mode

```bash
anima mode            # print the current task mode
anima mode <mode>     # chatting | programming | image | private | philosophy | creative
```

Stores the task mode in `~/.anima/state.yaml` (under `ANIMA_HOME`). This is the **task** mode used by the `router` provider. It is not the plan/edit/auto permission mode. The default is `chatting`.

### meet

```bash
anima meet <agent> [agent...] --topic <topic> [--turns N] [--resume] [--inject "<text>"] [--provider <id>]
anima meet --list
anima meet --show <topic>
```

Runs a round-robin meeting (`src/meeting/room.ts`) and prints the transcript.

| Flag | Meaning |
|------|---------|
| `--topic` | Required. Names the meeting directory |
| `--turns` | Turns per agent (default `3`) |
| `--resume` | Continue today's transcript for this topic |
| `--inject` | Text added to every agent's prompt each turn |
| `--provider` | Provider override |
| `--list` | List meeting topics |
| `--show <topic>` | Print today's transcript for a topic |

Meetings are stored under `~/.anima/rooms/_meeting/`. The meeting room uses `~/.anima/rooms` and ignores `ANIMA_ROOMS_DIR`.

### send-mail

```bash
anima send-mail --from <agent> --to <mesh ID> --body "<body>" [--subject "<subject>"]
```

Sends a mesh message addressed by mesh ID, as the sending agent, through that agent's mesh socket (the ANIMA server must be running), and prints the result. A `--subject` is prepended to the body as `[subject]`.

### check-mail

```bash
anima check-mail [--agent <agent>] [--mark-read] [--thread <id>]
```

For each agent (or just `--agent`), prints how many unread meeting messages it has; `--mark-read` marks them as read. Mesh requests do not use a mailbox: they arrive in the agent's session through its A2A inbox.

### beam

```bash
anima beam <agent> --content "<text>" [--source <source>] [--keywords a,b] [--session <id>]
```

Appends one beam entry to the agent's `staging/beams/` without loading the full agent. `--source` defaults to `cli`, `--keywords` defaults to the source, and `--session` defaults to `cli:<source>`. See [Dream System](../sessions/dream.md).

### cartridge {#cartridge}

```bash
anima cartridge list
anima cartridge validate
anima cartridge expand <name>
```

Implemented in `src/cartridge/cli.ts`. It scans the colony (`~/agora`), global (`~/.anima`) and project (current directory) tiers.

- `list` prints `<scope>/<category>/<name>` and the file path for each cartridge.
- `validate` reports files with missing frontmatter, locked memory write scopes and over-budget cartridges, then prints a count per scope. It exits with `1` if anything failed.
- `expand <name>` prints the cartridge with its guides, rules and persona inlined.

### /cartridge {#cartridge-slash}

```bash
anima /cartridge list [--agent <agent>]
anima /cartridge <name> [--agent <agent>]
anima /cartridge off
```

The older single-cartridge viewer. `list` prints `[scope] category/name`. `<name>` prints the cartridge's metadata and content. `off` and `none` only print a message.

### seed

```bash
anima seed <agent> <substrate-path> [--force] [--boot <files>] [--no-auto-mode]
```

Runs `bun scripts/seed-room.ts`. It only knows the agents listed in that script: `bruno`, `cleo`, `eli`, `sam`, `milo`, `lena`, `ivan`, `abel`, `finn`, `gus`, `hana`, `nora`, `pia`, `rhea`. Run it from the repo root, because the script path is relative.

### rotate-abel-token

```bash
anima rotate-abel-token
```

Prints a new `BEARER_2B_TOKEN` to add to your `.env`. You need to restart ANIMA afterwards.

### restart

```bash
anima restart [--dev-only]
```

Runs `pkill -f "bun src/server.ts"` to stop a dev server, then `launchctl kickstart -k gui/$(id -u)/com.example.anima` to restart the production service. `--dev-only` skips the second step. The `launchctl` step is macOS-only and hard-codes one user and service label.

## Environment variables

| Variable | Used by | Default |
|----------|---------|---------|
| `ANIMA_ROOMS_DIR` | `AgentLoader` (talk, session, status, check-mail) | `~/.anima/rooms` |
| `ANIMA_HOME` | Provider files, `mode-map.yaml`, `state.yaml`, `beam` | `~/.anima` |
| `ANIMA_SESSIONS_DB` | Session store | `~/.anima/sessions.db` |
