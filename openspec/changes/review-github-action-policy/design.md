# GitHub tool action policy for review jobs

Source issue #280. Design and plan for review.

## Architecture

Define a narrow, immutable host-side profile context with a discriminated PR-review, intent-review and work variant. Its binder owns repository, item number and an expected PR head or intent revision. Review permits only `review` and the read-only `review_threads`, scoped to its PR. Intent review permits only `approve_intent` and `issue_comment` on its bound issue via the existing budget and revision checks. Work has no `anima_github` grant and keeps the existing publish tool. Ordinary sessions keep the existing tool policy only when the trusted launcher did not request a restricted profile. Any requested but invalid or incomplete session context fails closed. Do not read profile or target from tool arguments; compare canonical normalized arguments against the trusted context.

The worker runner in `src/mesh-jobs/start.ts` propagates bounded job metadata to the subprocess with unrelated inherited metadata cleared. `src/cli.ts` validates it before sending the model a tool catalog, binds it in `ExecuteToolOptions`, and forwards it to `handleGithubTool` via `src/tools/executor.ts`. The handler refuses invalid actions or targets before App key or transport access, logs a bounded refusal reason, and preserves existing identity/intent-review budget checks. Use the known PR head as the authenticated review submission commit id. Verify the current head matches and rely on normal current-head receipt processing if it moves during submission. The worker reports completion only after the existing verified receipt chain. Bind a per-session verdict reservation: release on verified failure, settle on verified success, and reconcile uncertain submission with read-only GitHub evidence before a repeat. Forward a fixed normalized profile identifier and action set in the current job observability channel, excluding model input and credentials.

## Test strategy

All tests use injected credentials, stubbed GitHub calls and synthetic fixtures. Cover each allowed action and all forbidden action families, a scope mismatch, invalid metadata and stale head. Assert denied calls make zero credential, fetch and Git calls. Cover ordinary-tool compatibility, intent budget compatibility and absence of the tool on the work surface.

## Non-goals

Model selection, moderation of verdict text, human access rules, changes to ordinary-author identity and new credentials are outside this work.
