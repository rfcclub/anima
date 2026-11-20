# Design — Add a bounded read-only code map

Parent intent: #278.

## Architecture

Use a configured, pinned standalone Fovea executable only if its runner can prove checkout-only reads, scratch-only writes, no network, and hard resource budgeting. The current supervisor limits wall time and output; the existing work sandbox alone does not establish read confinement or a memory cap. Keep the tool unavailable on unqualified platforms. Map structured sketch, focus, and impact arguments to the CLI, with untrusted bounded results. Reviewer and prewalk wiring are separate from work exposure and consume pinned inputs.

## Integration points

`src/work/supervisor.ts`, `src/work/sandbox.ts`, `src/work/tools.ts`, and the [standalone Fovea CLI](https://github.com/fabric-runtime/pi-fovea). Fail closed on unsupported platform limits.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Qualify a confined code-map process boundary.** Use benign synthetic allow and deny controls to report read, temp write, wall, output, memory and process-cessation guarantees. If the platform cannot prove a limit, document the missing capability and keep integration slices blocked.
- **S2. Bind sketch and focus commands to a qualified runner.** Require a qualified runner, immutable executable and structured inputs. Unit tests verify argument validation and bounded output; qualification remains separate from these fakes.
- **S3. Expose bounded sketch and focus in work.** Register the tool only when explicitly configured and qualified. Preserve the original tool list otherwise, and ensure output is marked as untrusted text.
- **S4. Compute impact using a verified immutable base and head.** Accept only host-pinned base and head plus an authorized checkout. Return affected files and bounded co-change suggestions; stale or missing input declines only the map.
- **S5. Attach impact hints to the exact-head review packet.** Add bounded optional impact after exact-head inputs are available, including when the diff is clipped. Prove the hints do not change review authority or verdict.
- **S6. Attach opt-in map hints to prewalk.** Wait for accepted #276 prewalk wiring. Request a budgeted read-only location hint for the pinned checkout, with absence treated as unavailable context.
- **S7. Measure map use with a fixed corpus.** Compare enabled and disabled arms on the same commits, models and held-out checks. Capture iterations, tokens, wall time and pass rate. Keep the corpus synthetic and retain raw measurements locally.

## Rollback

Remove the trusted, host-supplied runner from work, review and prewalk surfaces. They retain normal read/search, diff and planner context. Keep the map unavailable if the process boundary or resource bounds cannot be proved. Record runtime evidence separately and clean only synthetic trial artifacts created by the test.
