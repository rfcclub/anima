# Tool Policy

Every room's `config.yaml` has a `policy:` block. This page describes what the runtime does with each field **today**.

::: tip Enforcement rolls out in modes
`allowedTools` is enforced by the auto guard. `allowedRoots`, `readOnlyRoots` and `deniedPatterns` are checked by `PolicyEnforcer` (`src/tools/policy-enforcer.ts`) before a tool runs, controlled by `policy.enforce`: `warn` (default) logs a `policy_violation` JSON line and still runs the tool, `block` refuses the call, `off` skips these root and pattern checks. The separate guard for GitHub App secret paths stays active even with `off`. See also [Security Status](../guide/security.md).
:::

## Fields

```yaml
policy:
  allowedRoots:          # required: list of paths
    - ~/.anima/rooms/myagent
  readOnlyRoots: []      # optional: list of paths
  allowedTools:          # optional, but required when session.autoModeOptIn is true
    - read
    - grep
    - glob
    - write
    - bash
  deniedPatterns: []     # optional: list of regexes matched against bash commands
  enforce: warn          # optional: off | warn | block (default warn)
```

The type is `ToolPolicy` in `src/config/types.ts`:

```typescript
interface ToolPolicy {
  allowedRoots: string[];
  readOnlyRoots?: string[];
  allowedTools?: string[];
  deniedPatterns?: string[];
  enforce?: "off" | "warn" | "block";
}
```

| Field | Validated at load | What the runtime does with it |
|-------|-------------------|-------------------------------|
| `allowedRoots` | Required, must be a string array | Listed in the prompt. Path tools (`read`, `grep`, `glob`, `write`, `edit`, `task`) must resolve (symlinks followed) inside it or `readOnlyRoots`; writes must be inside it. `bash` must run with a working directory inside it |
| `readOnlyRoots` | Optional string array, defaults to `[]` | Listed in the prompt. Readable, but `write`/`edit` under it are violations |
| `allowedTools` | Optional string array. Loading fails with `allowedTools required when autoModeOptIn is true` if it's missing and auto mode is opted in | Decides which tool definitions the model is offered. In `auto` mode, also blocks calls to tools that aren't listed (see below) |
| `enforce` | Optional `off`, `warn` or `block`; anything else fails loading | `warn` (default): tool runs, one `policy_violation` line per violation. `block`: returns `Error: policy violation (<rule>)` and skips the tool. Roll out `warn` first, read the log, fix roots, then switch rooms to `block` |
| `deniedPatterns` | Optional string array | Listed in the prompt. A `bash` command matching any regex is a violation (an invalid regex falls back to substring match). **Pattern matching is not a sandbox**: a shell can reach the same file in ways no pattern foresees. Treat it as a tripwire |

## What `allowedTools` does

**1. It picks the tools the model sees.** `buildToolDefinitions(allowedTools)` in `src/tools/definitions.ts` returns a definition for each listed name it knows and skips unknown names. Both the CLI `talk` command and `AgentSession` build the tool list this way. MCP tools from `mcp.servers` are added on top in `AgentSession` (see [MCP](./mcp.md)).

**2. It gates calls in `auto` mode.** When the effective mode is `auto`, a guard (`createAutoGuard` in `src/cli.ts` and `AgentSession`) checks each tool call. If the tool isn't in `allowedTools`, the call is refused with `tool '<name>' not in allowedTools for this agent` and a `tool_blocked` event is logged. When the run ends, an `auto_execution_complete` log line records the tools used and the call count.

The auto guard only checks the tool **name**. It doesn't look at arguments, paths or commands.

## Built-in tools

These are the names `buildToolDefinitions` knows (`TOOL_DEFS` in `src/tools/definitions.ts`). Calls run in `executeTool()` in `src/tools/executor.ts`, with the room directory as the working directory.

| Group | Tools |
|-------|-------|
| Files and shell | `bash`, `read`, `grep`, `glob`, `write`, `edit` |
| Mesh | `mesh_send`, `mesh_pull`, `mesh_peek`, `mesh_ack`, `mesh_status`, `mesh_thread`, `mesh_subscribe`, `mesh_unsubscribe`, `mesh_register_recipient`, `mesh_unregister_recipient` |
| Memory | `anima_remember`, `anima_recall`, `anima_forget`, `anima_bootstrap`, `anima_update`, `anima_list_all`, `anima_memory_list`, `anima_stats`, `anima_diagnose`, `anima_export`, `anima_import`, `anima_invalidate`, `anima_triple_add`, `anima_triple_query`, `anima_scratchpad_write`, `anima_scratchpad_read`, `anima_scratchpad_clear`, `anima_agent_status`, `anima_sleep`, `anima_tool_list` |
| Conversation context | `anima_context_search`, `anima_context_describe`, `anima_context_expand`, `lcm_grep`, `lcm_describe`, `lcm_expand` |
| Work | `task`, `agent` (sends a mesh message to another agent) |
| Web | `web_search` (Brave Search API), `web_fetch` |

## Permission modes and the policy

The permission mode (`plan`, `edit`, `auto`) doesn't add or remove tools. See [Permissions](./permissions.md) for what each mode changes.

## Recommendations

- Give each agent the smallest `allowedTools` list it needs.
- Leave out `bash`, `write` and `edit` unless the agent really needs them. In default `warn` mode, violations are logged and the tool still runs; shell pattern checks are not a sandbox even in `block` mode.
- Keep `allowedRoots` accurate. With `policy.enforce: block`, path tools enforce those roots (and readable `readOnlyRoots`); writes under `readOnlyRoots` are refused.
- Run ANIMA as a user that can only reach what your agents should reach.
