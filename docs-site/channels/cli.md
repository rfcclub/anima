# CLI Channel

`src/cli.ts` is the command-line way into ANIMA. It runs in its own process and doesn't need the server, because it loads rooms and calls providers directly.

## When to use it

- Quick one-off messages: `anima talk <agent> "<message>"`
- Scripting: the output is plain text (`talk`) or JSON (`status`, `session`, `send-mail`)
- Checking rooms: `anima status` shows which rooms load and which fail
- Meetings and mesh mail between agents: `meet`, `send-mail`, `check-mail`

## Examples

```bash
bun src/cli.ts talk myagent "summarize MEMORY.md"
bun src/cli.ts talk -a myagent -m "fix the typo" --permission edit
bun src/cli.ts status
bun src/cli.ts cartridge list
```

## How it differs from the server channels

| | CLI `talk` | Server channels (Web UI, Telegram, mesh) |
|--|-----------|------------------------------------------|
| Session engine | Inline loop in `src/cli.ts` | `AgentSession` (`src/agents/session.ts`) |
| Cartridges | Not resolved | Resolved per turn |
| MCP servers | Not started | Started from `mcp.servers` |
| Session key | `talk` session in `~/.anima/sessions.db` | Per channel (for example `ui` for the Web UI) |
| Rooms directory | `ANIMA_ROOMS_DIR` or `~/.anima/rooms` | `ANIMA_ROOMS_DIR`, otherwise a per-component default (`./rooms` for the server and Web UI). Set `ANIMA_ROOMS_DIR` so they all agree |

See the [CLI Reference](../cli/reference.md) for every command and flag.
