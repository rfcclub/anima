# Implementation Plan: work-adapter-per-work

Parent intent #419. Approve each slice separately and execute its named RED/GREEN check before combining slices.

### Task 1 — Preserve Low abort provenance

- Scope. `src/work/adapter-low.ts` and `__tests__/work/adapter-low.test.ts`.
- Behavior. Carry `interruptionSource: "abort"` from the winning signal race result to each affected adapter result. A timer stays `deadline`; an abort alone stays `interrupted`.
- RED. Use fake VM startup and deterministic timer order for an abort winner and timer winner. Assert source, cause and proven or unproven cessation; run the existing consumer deadline tests.
- Run `bun test __tests__/work/adapter-low.test.ts __tests__/work/consumer.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 2 — Build the trusted programmer task

- Scope. `src/work/production.ts` and `__tests__/work/production-task.test.ts`.
- Behavior. Build the host programmer rule block before the JSON work order. Apply the verified worker prompt behavior from the design without mutating the workspace guide.
- RED. Assert the four host rules and parse the work order suffix; include fake delimiters and conflicting instructions in the issue fixture and assert the host prefix is identical.
- Run `bun test __tests__/work/production-task.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 3 — Validate optional adapter overrides

- Scope. `src/mesh-jobs/config.ts` and `__tests__/mesh-jobs/config.test.ts`.
- Behavior. Accept `work.authorAdapters: Record<string, "loop" | "low">` only for configured author IDs. Omission preserves the existing `externalAdapter` default. Keep this configuration inactive until the routing slices land.
- RED. Assert two valid overrides, omission, invalid enum, unknown author, and reviewer-only ID.
- Run `bun test __tests__/mesh-jobs/config.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 4 — Persist the adapter pin at work reservation

- Scope. `src/work/store.ts` and `__tests__/work/store.test.ts`.
- Behavior. Add a nullable work adapter pin and bind it transactionally to the session kind. A previously recorded kind supplies the legacy pin; an already pinned kind wins over later defaults.
- RED. Open a pre-migration fixture, reserve a legacy work, reopen and reserve again with a changed candidate; assert identical work and session kinds. Cover an existing explicit pin.
- Run `bun test __tests__/work/store.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 5 — Expose an adapter-specific executor port

- Scope. `src/work/executor.ts` and `__tests__/work/executor.test.ts`. This slice can precede dispatch.
- Behavior. Expose an optional `forAdapter(kind)` selection port; retain the existing executor shape used by current callers. A selected executor keeps its own adapter and readiness.
- RED. Assert a fake Low execution and a Loop execution use the same workspace preparation but distinct adapter invocations; assert unknown selection fails.
- Run `bun test __tests__/work/executor.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 6 — Route an admitted work to its pinned adapter

- Scope. `src/work/consumer.ts` and `__tests__/work/consumer.test.ts`, after the executor exposes a host-owned per-kind resolver.
- Behavior. Call the selected adapter for readiness and execution and use that kind for reservation and trusted continuation. Keep the existing in-process default for legacy session ports.
- RED. Drive one Loop and one Low work through the handler, assert different reserved kinds, and prove a Low readiness refusal never touches Loop.
- Run `bun test __tests__/work/consumer.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 7 — Return a named Low readiness failure

- Scope. `src/work/container-runner.ts` and `__tests__/work/container-runner.test.ts`. Use the existing container control wrapper.
- Behavior. Expose an injectable read-only preflight for runtime and worker image. Report the unavailable dependency without launching a container. Expose the probe without activating it until the production wiring slice.
- RED. Stub a missing executable and unavailable image and assert the distinct refusal results and absence of run/kill calls.
- Run `bun test __tests__/work/container-runner.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


### Task 8 — Wire both adapters and preserve fallback policy

- Scope. `src/work/production.ts` and a focused production test. Integrate the store/config/dispatch slices before activating overrides.
- Behavior. Resolve the configured candidate only for unpinned works and wire both executor choices to the handler. Derive Low fallback exclusions from the reserved session kind.
- RED. Assert a running work keeps its adapter across a config change and two pinned works use different fallback settings in the same runtime.
- Run `bun test __tests__/work/production-adapters.test.ts`. Capture the asserted failure on the parent revision. Implement the smallest scoped change and repeat the same command for GREEN. Keep the proposed change near 40 production lines and two files, or split it again before work begins.


## Verification

Run the focused commands in the stated dependency order, then run `bun run typecheck` and `bun run build` for production changes. Keep the reviewed design separate from executable acceptance. Preserve Orca plan and code gate verdicts.
