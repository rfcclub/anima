# Design: stop mesh turns after timeout

The mesh runtime already creates an AbortSignal and uses it to fence late replies. Pass that same signal through the mesh handler's `runTurn` port, the server's channel invocation, `ChannelMessage`, and `AgentSessionChannel` into the existing `AgentSession.run` cancellation path. After the asynchronous answered-conversation check, recheck the signal before invoking the turn. Keep the post-turn reply fence.

`TurnRunner` forwards the signal to the provider and checks it before later provider calls or tool starts. It must recheck after yielding a tool event and after an asynchronous permission decision, since either suspension can span the abort. This change does not promise to interrupt an already-running tool or undo a remote side effect. Non-mesh callers can omit the optional channel signal.

The model router must treat request cancellation as cancellation, not a provider failure. Check before every backend attempt and after it settles, and give an aborted request precedence over retryable provider errors. Do not retry or change breaker state because of an abort.

## Test Strategy
- SC-1: A mesh handler passes the exact signal to a pending cooperative turn; abort fences its late result.
- SC-2: Aborting during the asynchronous conversation lookup prevents a new turn.
- SC-3: A real AgentSessionChannel with a synthetic delayed provider receives the signal; a tool call returned after abort does not write an isolated marker or trigger another provider request.
- SC-4: The existing successful request and reply test remains green.
- SC-5: Aborting after the tool event is yielded does not start that tool.
- SC-6: Aborting during an asynchronous permission check does not start that tool.
- SC-7: A cancelled fallback-chain request does not retry, use a fallback, or mark a provider failed.
- SC-8: A cancelled mode-map request does not use a fallback or mark a provider failed.
- Router regressions: a cancelled request does not fall through on an authorization error; non-cancelled HTTP 401 and 403 responses retain the existing fallback behavior in both routing modes.

## Rollback
Rollback plan: revert the change and rebuild the previous version. There is no data migration or state conversion to reverse. Reverting cannot undo an already-started external operation.
