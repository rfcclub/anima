# Tasks — Add an operator-enabled work-tool plugin seam

Each unchecked item is a separate proposed work order. Require the preceding item to land before approving a dependent slice. Each code slice targets about 40 production lines and at most two production files. If the proposed behavior cannot fit safely, narrow the next slice before worker approval. For production slices capture a failing focused test before edits, run that test and `bun run build`, and preserve Orca gate results.

- [ ] **S1 – Validate manifests with no host imports**
  - Files: `src/plugins/manifest.ts`.
  - Implementation: Validate version, tool id, bounded input schema and declared capabilities, rejecting built-in collisions and unknown capabilities. The parser performs no filesystem or process side effect.
  - Verification: `bun test __tests__/plugins/manifest.test.ts`
- [ ] **S2 – Resolve immutable operator-enabled executables**
  - Files: `src/plugins/loader.ts`.
  - Implementation: Resolve entries from an operator-owned allowlist and canonical root, reject escaped names and duplicate tools, and pin an executable identity understood by the runner. Remove invalid entries without altering built-ins.
  - Verification: `bun test __tests__/plugins/loader.test.ts`
- [ ] **S3 – Bind explicit host grants to admitted plugin capabilities**
  - Files: `src/plugins/loader.ts`.
  - Implementation: Reject unknown, unsupported, or denied grants at admission. Report a stable reason and retain built-ins. Require proven no-network and read/write confinement for the admitted capabilities before enabling calls. Test deny-by-default with controlled fixtures.
  - Verification: `bun test __tests__/plugins/grants.test.ts`
- [ ] **S4 – Validate bounded invocation arguments before launch**
  - Files: `src/plugins/invoke.ts`.
  - Implementation: Check each call against the admitted schema and selected capability envelope. Return a typed refusal before opening a process for invalid inputs.
  - Verification: `bun test __tests__/plugins/invoke.test.ts`
- [ ] **S5 – Execute and stop an admitted plugin under supervision**
  - Files: `src/plugins/invoke.ts`.
  - Implementation: Use the existing supervised process port only after confinement qualification. Track the process in the existing work-tools lifecycle so cancellation and final cleanup can reuse cessation proof. Keep output bounded. Return distinct crash and timeout errors with proven cessation. Feed uncertain cessation into the existing blocked-stop path without allowing another session to start.
  - Verification: `bun test __tests__/plugins/process.test.ts`
- [ ] **S6 – Register enabled tools with existing work accounting**
  - Files: `src/work/tools.ts`, `src/work/executor.ts`.
  - Implementation: Load operator-controlled configuration once at executor startup from the existing host state-directory boundary. Pass the admitted registry into work tools. The existing LoopHost records the call. Prove one audit event, no caller-selected path or capability, and identical built-ins when disabled.
  - Verification: `bun test __tests__/work/plugin-tools.test.ts`

## Success Criteria

| Criterion | Tasks | Acceptance evidence |
| --- | --- | --- |
| SC-1 | S6 | With no plugin enabled, built-in tool definitions and behavior match the baseline. |
| SC-2 | S4, S5, S6 | A synthetic operator-enabled plugin adds one valid work tool. An admitted invocation produces one audit event through the built-in accounting path. |
| SC-3 | S2, S3 | An ungranted capability skips the plugin, logs a named refusal, and lets the host start with its built-in tool list. |
| SC-4 | S5, S6 | Crash and timeout are distinct error results to the caller. Assert child processes are gone. If cessation is uncertain, surface that refusal through the existing blocked-stop path. |
| SC-5 | S1–S6 | Check the combined change against the five-production-file ceiling before approval. |
