# Mesh MCP Runtime Usage

`colony-mesh` exposes the mesh bus through one MCP server. CLI runtimes should use this MCP path instead of raw SQLite edits or local one-off wrappers.

The preferred command is:

```text
colony-mesh
```

Local development fallback:

```text
bun /Users/user/work/colony-mesh/bin/colony-mesh.ts
```

## Tool Surface

The MCP server must expose exactly:

- `mesh_send`
- `mesh_peek`
- `mesh_pull`
- `mesh_ack`
- `mesh_status`
- `mesh_thread`
- `mesh_subscribe`
- `mesh_unsubscribe`
- `mesh_register_recipient`
- `mesh_unregister_recipient`

## Runtime Identities

| Runtime | `MESH_INSTANCE_ID` | `MESH_PLATFORM` |
| --- | --- | --- |
| Codex | `agent-a` | `codex` |
| ClaudeCode | `agent-b` | `cc` |
| Qwen | `agent-b` | `qwen` |
| Gemini | `agent-b` | `gemini` |
| Antigravity CLI | `agent-b` | `agy` |

`MESH_INSTANCE_ID` is the bare agent id (`agent-a` and `agent-b` are example ids; use your own). `MESH_PLATFORM` disambiguates runtimes that share the same bare id.

## Codex

Use `docs/mcp-runtime-configs/codex.toml`.

Verification:

```bash
bun scripts/mesh-mcp-runtime-usage.ts --runtime codex --instance-id agent-a --platform codex
```

## ClaudeCode

Use `docs/mcp-runtime-configs/claude.json`.

Verification:

```bash
bun scripts/mesh-mcp-runtime-usage.ts --runtime claudecode --instance-id agent-b --platform cc
```

## Qwen

Use `docs/mcp-runtime-configs/qwen.toml`.

Verification:

```bash
bun scripts/mesh-mcp-runtime-usage.ts --runtime qwen --instance-id agent-b --platform qwen
```

## Gemini

Use `docs/mcp-runtime-configs/gemini.toml`.

Verification:

```bash
bun scripts/mesh-mcp-runtime-usage.ts --runtime gemini --instance-id agent-b --platform gemini
```

## Antigravity CLI

Use `docs/mcp-runtime-configs/antigravity.json`.

Verification:

```bash
bun scripts/mesh-mcp-runtime-usage.ts --runtime antigravity --instance-id agent-b --platform agy
```

## Troubleshooting

If `colony-mesh` is not found on `PATH`, link the package:

```bash
cd /Users/user/work/colony-mesh
bun link
```

Then rerun the validator.
