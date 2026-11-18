# Security Status

::: danger No authentication yet
The ANIMA HTTP API has **no authentication**. Anyone who can reach the port can talk to your agents and trigger their tools.

Only run ANIMA on a machine you control, and keep it reachable from **localhost only**. Don't expose port `3700` (API) or `3000` (Web UI) to a LAN or the internet.
:::

## What this means in practice

- Neither the API server (`src/server.ts`, port `3700`, `PORT`) nor the Web UI server (`src/ui/app/server.ts`, port `3000`, `ANIMA_UI_PORT`) checks a token or session.
- Neither server sets a bind address, so Bun's default applies. Use a host firewall or run ANIMA on a machine that isn't reachable from other hosts.
- The path and pattern fields of the [tool policy](../tools/policy.md) (`allowedRoots`, `readOnlyRoots`, `deniedPatterns`) are checked before tools run, but by default only in `warn` mode (violations are logged, tools still run). Until a room is switched to `policy.enforce: block`, treat an agent with `bash`, `write` or `edit` as having the full file access of the user running ANIMA. `bash` checks are pattern matching, not a sandbox.

