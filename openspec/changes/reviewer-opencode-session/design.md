# Design — Add a head-bound read-only OpenCode review session

Parent intent: #96.

## Architecture

Keep a host-owned exact-head review packet and give the optional standalone OpenCode session only read tools and a dedicated clean profile. Never permit subprocess GitHub writes or repository-controlled plugins and config. Review the detached job commit and generate its diff from pinned inputs. The session produces an untrusted recommendation; the configured reviewer makes the final decision. Recheck lease, reviewer authority and current head before creating a review bound to that exact commit. Missing free models, stale head, timeout or malformed output result in no review. A literal `commit_id` pins attribution but does not prove race-free freshness after the last read. Leave the external write disabled until the head precondition is verified.

## Integration points

Use `src/mesh-jobs/start.ts` and `src/mesh-jobs/consumer.ts` as integration points. Reuse `src/review-loop/` snapshot and eligibility checks. Wait for the #74 review runner integration and applicable #73 adapter contract. Use qualified #72 runtime evidence where applicable. Keep #45 approval and merge authorities unchanged. The existing discussion client reads only, the approval client sends only `APPROVE`, and the generic App posting path currently omits `commit_id`. A separate host-only client must enforce reviewer identity, lease and subject constraints.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Define the bounded review packet and verdict parser.** Represent exact head, clipped diff and linked public intent. Accept only one allowed first-line verdict, bound findings, and treat model claims as untrusted text. Include stale and invalid report fixtures.
- **S2. Build the packet from pinned checkout and diff inputs.** Verify the detached job commit, obtain the diff from verified base and head, and reject a moved or unidentified commit. Test a PR head changed while selecting input.
- **S3. Launch a qualified read-only OpenCode session.** Use an isolated profile with allowlisted read-only capabilities and no repository configuration, extensions, shell, writes, GitHub capability or inherited credentials. Prove the session and descendants have ceased after success, failure and timeout. Require current free-model evidence or explicit opt-in for the exact paid model.
- **S4. Integrate optional OpenCode as a recommendation backend.** Invoke the backend only when opted in and the lease remains current. Accept one valid recommendation; retain final reviewer authority and verify invalid results cause no write.
- **S5. Bind trusted posting to the exact reviewed commit.** Require the configured reviewer to authorize bounded verdict and file/line findings. Fetch current head, recheck lease, and bind the host request to the exact reviewed `commit_id`. Require a verified server-side current-head precondition for automated posting. If unavailable, keep posting disabled and retain the recommendation.
