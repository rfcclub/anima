# Design — Qualify stock Pi in isolated profiles

Parent intent: #72.

## Architecture

Use an exact operator-selected 1.1.x release in a disposable install and profile. Run lifecycle probes with a deterministic local provider, then run the explicitly authorized real-provider check separately. Record platform, package and extension versions, exit status and evidence hashes. Preserve the current global installation and configuration. Do not change ANIMA harness selection.

## Integration points

Use an isolated test repository. The existing loader handoff in `scripts/identity-*/agent-loader.sh` stays outside the qualification. Evaluate native and extension code surfaces independently. Keep alternative harness construction outside this design. A blocking Pi result can inform the fallback decision.

## Test strategy

Use synthetic inputs, explicit negative cases, and existing process and permission boundaries. No live rollout is part of this design.

- **S1. Build a disposable lifecycle probe for the pinned release.** Exercise RPC launch, prompt, a settled response, and two revisions under one session identifier against a deterministic provider. Assert isolated prefix, profile and package version.
- **S2. Verify RPC cancellation and process cessation separately.** Record a cancellation acknowledgement and an independent termination observation, then resume the same session in a new process. Reject missing cessation proof.
- **S3. Check retained values, restrictions and extension compatibility.** Exercise `codemode store` and `load` in a later call and after proven exit and resume. Record the refusal of a harmless denied operation inside Pi and the extension compatibility result. Use only a deterministic local provider in this slice.
- **S4. Qualify the candidate on macOS and Windows.** Run the same qualification on macOS and Windows. Compare the existing global Pi 1.0.1 binary and settings byte-for-byte without exposing their content. Record every Windows failure and its sanitized output. Track the strong-model/custom-provider run and owner decision separately, each pending its own authorization.
