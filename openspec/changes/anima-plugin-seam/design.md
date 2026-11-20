# Design — Add an operator-enabled work-tool plugin seam

Parent intent: #415.

## Architecture

Validate manifests without importing code. The owner selects exact executable identities from an enabled root and a host grant map. Bind invocation schema checks to the admitted manifest and require a separately qualified confinement profile before registration. The existing work sandbox does not prove arbitrary plugin grants. Run every admitted invocation as a supervised process, record standard steps, and require confirmed cessation on timeout or cancellation. Keep disabled work behavior byte-for-byte compatible.

## Integration points

`src/work/executor.ts` loads the operator-controlled enable list at startup and supplies the admitted registry to `src/work/tools.ts`. Existing LoopHost accounting records the invocation through the same path as built-in tools. Reuse `src/work/supervisor.ts` for process lifecycle and `src/work/sandbox.ts` only where its controls can be proven to enforce the admitted grants. Existing work-tool policies remain authoritative. The code-mode tool does not depend on the plugin seam.

The production file budget is five files: the manifest, loader (including grant admission), invocation module, work-tool registry and executor. Starting a tool does not import plugin code into the host. The existing generic work profile allows reads outside explicitly denied roots, so it cannot stand in for an arbitrary read-only tree grant. If the required grants are unsupported, log the stable reason and keep the plugin disabled. Qualification may use only benign synthetic controls.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Validate manifests with no host imports.** Validate version, tool id, bounded input schema and declared capabilities, rejecting built-in collisions and unknown capabilities. The parser performs no filesystem or process side effect.
- **S2. Resolve immutable operator-enabled executables.** Resolve entries from an operator-owned allowlist and canonical root, reject escaped names and duplicate tools, and pin an executable identity understood by the runner. Remove invalid entries without altering built-ins.
- **S3. Bind explicit host grants to admitted plugin capabilities.** Reject unknown, unsupported, or denied grants at admission. Require proven no-network process confinement before invocation can be enabled. Test deny-by-default mapping with controlled fixtures.
- **S4. Validate bounded invocation arguments before launch.** Check each call against the admitted schema and selected capability envelope. Return a typed refusal before opening a process for invalid inputs.
- **S5. Execute and stop an admitted plugin under supervision.** Use the existing supervised process port after confinement qualification. Preserve timeout, bounded output, and proven cessation, including failure rather than success when cessation is unknown.
- **S6. Register enabled tools with existing work accounting.** Route through standard policy and step accounting. Prove one audit event for one invocation, no caller-controlled paths or capability expansion, and identical built-ins when disabled.

## Rollback

Remove the plugin from the operator enable list and recreate the runtime through the normal lifecycle once active plugin calls have drained. Admission of new commands stops. If a call must be cancelled, require its existing cessation proof before continuing the affected work. The existing built-in definitions, tool audit and work records do not need migration.
