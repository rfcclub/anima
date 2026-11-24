# Plan: close interrupted review sessions

- [x] Add RED integration tests in `__tests__/mesh-jobs/headless-review.test.ts` using a synthetic provider and isolated session databases: verify SIGTERM exits 143 and closes only the targeted review; a setup error after creation closes that session.
- [x] Assert an ordinary successful headless review still writes its output and ends its own session.
- [x] In `src/cli.ts`, install a headless-only SIGTERM handler bound to the newly created session and ensure post-creation setup runs inside the review cleanup boundary; keep the non-headless loop's existing guard behavior.
- [x] Run focused tests, typecheck, build, graphify update, Orca verify, gate-plan, and gate-code; preserve RED and gate results.
- [ ] Obtain an independent review before considering publication or live activation.

## Acceptance criteria mapping
- SC-1: The SIGTERM integration test uses a pending fake provider, checks exit 143, and queries the subprocess-owned review session.
- SC-2: The concurrent-review test verifies the other session is still open after the targeted subprocess exits.
- SC-3: The setup-failure integration test checks an auto-permission rejection and a closed session.
- SC-4: The existing success-path test verifies output and session closure.
