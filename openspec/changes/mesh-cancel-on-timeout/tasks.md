# Plan: stop mesh turns after timeout

- [x] Add failing mesh-handler tests in `src/continuity/mesh-session-handlers.test.ts` for forwarding the timeout signal and avoiding a turn after cancellation during conversation lookup.
- [x] Add a failing integration test in `__tests__/channels/agent-session-channel.test.ts` with an isolated room and delayed synthetic provider: abort before returning a write tool call; assert no marker file and no second provider call.
- [x] Add failing turn-runner tests for cancellation during the tool event and permission check; recheck the signal after each suspension before starting a tool.
- [x] Add isolated failing router tests for cancellation before a call, after an abort-induced provider error, and after a late success in both fallback modes; stop retries and breaker changes on abort. Check cancellation concurrent with an authorization error and preserve the existing non-cancelled handling of HTTP 401 and 403.
- [x] Pass the signal through `src/continuity/mesh-session-handlers.ts`, the gate-mode `runTurn` adapter in `src/server.ts`, `src/channels/types.ts`, and `src/channels/agent-session-channel.ts`. Check abort before starting the turn and retain the reply fence.
- [x] Run the relevant handler, channel, and turn-runner tests, typecheck and build; record the RED and GREEN results.
- [x] Run graphify update, Orca verify, gate-plan and gate-code, and preserve their warnings and receipts.
- [ ] Obtain independent review of the exact head before any merge or live rollout.

## Acceptance criteria mapping
- SC-1: handler forwards the same signal and fences the late result.
- SC-2: abort during conversation lookup prevents turn start.
- SC-3: the delayed synthetic provider cannot start its write tool or another provider call after cancellation.
- SC-4: the existing ordinary mesh reply test continues to pass.
- SC-5: cancellation during the tool event prevents execution.
- SC-6: cancellation during an asynchronous permission check prevents execution.
- SC-7: cancellation stops retries and breaker changes in the fallback chain.
- SC-8: cancellation stops fallbacks and breaker changes in the mode map.
