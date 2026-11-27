# Agent Client Protocol (ACP): adopt narrowly

> Decision for rfcclub/anima#672. ACP (the Zed project's editor-to-agent protocol, Apache-2.0)
> connects a client such as an editor to an agent that runs as a subprocess over stdio with
> JSON-RPC. It is not A2A: A2A connects agent to agent, ACP connects one client to one agent.
> This note records what the bounded prototype measured, the method-by-method mapping to an
> ANIMA room turn, and what could not be mapped.

## Decision

**Adopt narrowly, and only as a serving surface.**

- Keep A2A as the only agent-to-agent transport. ACP never carries inter-agent traffic.
- Treat ACP as a second *front door* to the same room turn that `anima talk` and the remote
  talk listener already use: one agent, chosen by configuration, one prompt per turn.
- The adapter stays off unless a flag names exactly one agent (`ANIMA_ACP_AGENT=<agent>`).
  There is no default-on path and no per-agent enablement without a separate approved intent.
- Identity and permissions are **not** re-decided for ACP. The session's agent comes from the
  flag and its room config; allowed tools come from the agent's existing `policy.allowedTools`.
  An ACP permission prompt is a *display* of the existing policy gate, never a replacement for it.

Consuming ACP (ANIMA as an ACP client driving other harnesses) is **not adopted**. See
[Consume](#consume-anima-as-an-acp-client) for the reasons.

## Prototype

`src/acp/stdio-adapter.ts` is a throwaway stdio adapter: JSON-RPC lines in, JSON-RPC lines out,
with all room behaviour behind an `AcpHost` seam. `__tests__/acp/stdio-adapter.test.ts` pins the
behaviour the mapping claims. Measured:

| Behaviour | Result |
| --- | --- |
| `initialize` | advertises protocol version `1`, `loadSession: false`, no `fs` capability |
| `session/new` | returns only a `sessionId`; the client's `cwd` is never echoed |
| `session/prompt` | streams `session/update` notifications, then one `stopReason` |
| `session/cancel` | aborts the in-flight prompt; the turn resolves with `stopReason: "cancelled"` |
| `session/request_permission` | sent to the client with no default; the client's answer is passed through |
| `fs/*`, `terminal/*`, `session/load` | answered `-32601` (method not found), params never echoed |
| `session/new` with a substrate/secrets segment in `cwd` | refused `-32602` |

The adapter does not load the agent, does not read the substrate, does not touch the file system
and does not run a provider call itself. That is deliberate: it is enough to test the mapping
against a real client, and small enough to throw away.

## Method mapping to an ANIMA turn

The unit on the ANIMA side is one room turn: `AgentSession.run`/`runStream` over a `SessionManager`
session for one agent, with the agent's `policy` applied by `executeTool`.

| ACP method | ANIMA turn step |
| --- | --- |
| `initialize` | capability handshake only. No turn state. Reports version, and asserts the client may not use this agent's file system or terminals. |
| `authenticate` | no-op. The agent identity is the flag plus its room config; the client never supplies or changes it. |
| `session/new` | open a `SessionManager` session for the configured agent (the `talk` channel equivalent). `mcpServers` from the client are ignored: ANIMA starts none of them. The returned handle is an opaque ANIMA session id, never a path. |
| `session/prompt` | one room turn: the text blocks become the user message, `AgentSession.runStream` runs the turn, and each provider text chunk becomes an `agent_message_chunk` update. The terminal `stopReason` is `end_turn`. |
| `session/update` (agent → client) | provider text chunks (`agent_message_chunk`) and tool activity (`tool_call`) from the existing turn event stream. No new event source. |
| `session/cancel` | abort the `AbortSignal` the turn already accepts (`RunAgentSessionOptions.signal`). The turn's `stopReason` becomes `cancelled`. |
| `session/request_permission` | the ACP view of the existing policy gate: `checkPolicy` / `createAutoGuard` decides, and the ACP options are the *decision request*. A deny at the policy gate is never upgraded to an allow because a client clicked Allow. |
| `fs/read_text_file`, `fs/write_text_file`, `terminal/*` | not implemented, and refused rather than advertised. ANIMA tool handlers reach the file system only through `executeTool` and the agent's policy; the client gets neither. |
| `session/load` | not implemented. Resuming an old session is a session-store concern, not a protocol concern. |

## Identity, permissions and paths

- **Identity.** A session's agent is fixed by `ANIMA_ACP_AGENT` and validated as an agent name
  (`/^[a-z0-9][a-z0-9_-]*$/`), so a client cannot address another room or pass a path where an
  agent belongs. The client's `cwd` is metadata only and is never used to locate anything.
- **Permissions.** Allowed tools come from the agent's configured `policy.allowedTools`. An ACP
  permission request is how a policy *deny* or an `auto`-mode *unknown tool* is surfaced to the
  human in the editor; it is not a second gate that can widen the policy. Where the policy says
  no, the turn says no.
- **Paths and substrate.** The adapter refuses a `session/new` whose `cwd` names a protected
  segment (`substrate`, `secrets`, `credentials`, `providers.d`, `.ssh`, `.anima`, `.config`),
  refuses `fs/*` and `terminal/*` outright, and never echoes client-supplied params in an error.
  An agent's room directory and its substrate therefore never appear on the wire.

## What could not be mapped

- **Session resume / `session/load`.** ANIMA's session store is richer than ACP's notion of
  loading a session (pushes, compaction, branches). Mapping it would either leak store structure
  or lose it. Left out; a client opening a new session each time is the honest behaviour.
- **Client-provided MCP servers.** ACP lets a client pass MCP server definitions into a session.
  Accepting them would let the client extend the agent's tool set, which is a permission change
  and out of scope by the issue's constraints. Ignored.
- **Client file-system and terminal methods.** These would move execution into the editor's
  process. ANIMA's tool boundary is `executeTool` plus policy; routing it through a client would
  make the policy gate unenforceable. Refused.
- **Image, audio and embedded context prompt blocks.** The prototype drops non-text blocks. The
  mapping for multimodal prompts is not established, so `promptCapabilities` advertises none.
- **`authenticate` semantics.** ACP has an auth-method negotiation; ANIMA has no per-session
  credential for a local subprocess. It is answered as a no-op rather than pretended.

## Consume: ANIMA as an ACP client

Not adopted now. ANIMA already drives harnesses through `anima talk`, the mesh job consumer and
A2A, each of which carries ANIMA's own room semantics (memory recall, cartridges, policy). Acting
as an ACP client would add a second, narrower way to spawn a harness whose identity, tool policy
and session store are not ANIMA's, for no capability ANIMA lacks. It also inverts the trust
direction: ANIMA would be accepting a subprocess's permission prompts. Revisit only if a specific
harness exposes a capability ANIMA cannot reach any other way.

## Cost of ownership

The protocol surface that carries real value here is four methods (`initialize`, `session/new`,
`session/prompt`, `session/cancel`) plus one reverse request (`session/request_permission`). The
adapter is ~300 lines and the mapping reuses the existing turn, policy and session code instead of
reimplementing them. The recurring cost is tracking ACP's version: it is young, its schema is
still moving, and every editor integration ships its own client quirks. That is affordable only
because the adapter is opt-in per agent and can be deleted without touching room turns.

If editors stop adopting ACP, the cost of removal is the adapter file and its tests.

## Follow-up intent (if adopted further)

Ship the adapter for one agent behind `ANIMA_ACP_AGENT`, add a stdio entry point that wires
`AcpHost` to `AgentSession`/`SessionManager`, and test: session creation, a streamed prompt,
cancellation, a policy-denied tool surfaced as a permission request, and that no absolute path or
substrate content appears in any frame. Nothing in that follow-up may change how identity or
permissions are decided.
