# Plugins

::: info Planned
ANIMA has **no plugin system of its own**. The runtime doesn't load plugins, hooks or extension packages, and no `plugins` config key exists. To give an agent more tools today, use the [built-in tools](./policy.md#built-in-tools) or an [MCP server](./mcp.md).
:::

## What exists today

The repo has adapters that let **other** agent runtimes use ANIMA's tools and memory. They aren't loaded by ANIMA.

| Path | What it is |
|------|-----------|
| `hermes_plugin/anima_memory/` | Hermes plugin (`plugin.yaml`, Python) that provides the `anima_*` memory tools, backed by SQLite |
| `hermes_plugin/anima_mesh/` | Hermes plugin that provides the `mesh_*` colony-mesh tools |
| `integrations/claude-code-identity-runtime/` | Adapter that joins a Claude Code turn to the identity runtime. See its `README.md` |
| `integrations/codex-identity-runtime/` | The same adapter for Codex |
| `packages/openclaw-anima-adapter/`, `packages/openclaw-adapter-bruno/` | Adapters for the OpenClaw runtime |

## Ways to extend an ANIMA agent

- **Boot extra actions.** `boot.extraActions` runs shell commands when the agent loads and puts their output in the prompt. Each action has a 15-second timeout and its output is capped at 40,000 characters. See [Agent Config](../agents/config.md#boot).
- **MCP servers.** `mcp.servers` adds external tools per room. See [MCP](./mcp.md).
- **Cartridges.** Cartridges add context and retrieval rules, not tools. See [Cartridge System](../cartridge/overview.md).
