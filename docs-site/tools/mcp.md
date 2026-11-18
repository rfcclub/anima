# MCP (Model Context Protocol)

ANIMA can start MCP servers for an agent and offer their tools to the model. The code is in `src/mcp/client.ts` (one stdio client per server) and `src/mcp/manager.ts` (routes tool calls to the right server).

## Configure MCP servers

MCP servers are set per room, under `mcp.servers` in `config.yaml`. There's no global MCP config.

```yaml
mcp:
  servers:
    - name: files                 # required, used in logs
      command: npx                # required, the executable to spawn
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/shared"]  # required (may be [])
      env:                        # optional, merged over the ANIMA process env
        LOG_LEVEL: warn
```

`loadRoomConfig()` checks the shape: `mcp.servers` must be an array, and each entry needs a non-empty `name`, a non-empty `command`, an `args` string array, and (if present) an `env` map of strings.

## How it runs

1. When an `AgentSession` turn starts and `mcp.servers` isn't empty, ANIMA creates an `McpManager` and starts each server.
2. Each server is spawned with `Bun.spawn([command, ...args])` and spoken to over stdio JSON-RPC. The client sends `initialize` (protocol version `2024-11-05`) and `notifications/initialized`.
3. The manager calls `tools/list` on each server. The tools are added to the model's tool list next to the built-in tools from `policy.allowedTools`.
4. When the model calls one of those tools, the manager sends `tools/call` to the server that listed it.
5. The servers are stopped when the turn ends.

A server that fails to start is logged (`MCP server failed to start: <name>`) and skipped. The turn continues without it.

## Things to know

- **No name prefixing.** MCP tools keep the names their server gives them. If two servers list the same name, the one started last handles the calls.
- **`allowedTools` doesn't filter MCP tools.** Every tool an MCP server lists is offered to the model.
- **CLI `talk` doesn't start MCP servers.** Only `AgentSession` does, which means the Web UI, Telegram and mesh channels.
- **Servers are per turn.** They're started and stopped for each turn, not kept running.

## Related

- The mesh and memory tools (`mesh_*`, `anima_*`) are built into ANIMA. You don't need an MCP server for them. See [Tool Policy](./policy.md#built-in-tools).
- `hermes_plugin/` in the repo exposes the same mesh and memory tools to the Hermes runtime. See [Plugins](./plugins.md).
