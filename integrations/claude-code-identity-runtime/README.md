# Claude Code identity-runtime adapter

For an opted-in Claude Code turn, create the client with `createClaudeCodeIdentityRuntimeClient({ agentId })` and call `runClaudeCodeTurn(client, invoke)`; the hook joins before it calls `invoke`, injects the server projection as `system`, and passes the same remote capability for subsequent recall/remember/proposal calls. Local configuration must provide `IDENTITY_RUNTIME_ENDPOINT` and `IDENTITY_RUNTIME_BOOTSTRAP_TOKEN`; missing configuration throws a diagnostic and never falls back silently.

The adapter receives a server projection and lease metadata only. It does not receive SQLite, raw memory, or a promotion writer.
