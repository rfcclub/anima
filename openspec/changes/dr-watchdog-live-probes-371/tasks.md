# Plan: DR watchdog live probes

Issue: rfcclub/anima#371

## SC-001: Complete observations and compatibility

- [x] RED: create `scripts/dr/live-probes.test.ts`; inject launchd outputs with unique PIDs and lsof field records for owner, foreign, owner plus foreign, duplicate IPv4/IPv6 PID, and exit-1 empty no-match. Assert complete results through `checkPorts`; run `bun test scripts/dr/live-probes.test.ts` and capture the failing output.
- [x] GREEN: create `scripts/dr/live-probes.ts`; define `collectLiveProbes`, the discriminated port result and an injected executor. Validate all labels/ports before calls. Parse the top-level launchd PID and complete `p/f/P/n/T` lsof fields; map only exact unique PIDs, retaining PID in every listener description. Treat exit 1 with empty stdout and stderr as no match.
- [x] RED: exercise a running job with nested state and counter fields and a waiting job with a nested PID; assert only root fields affect checks.
- [x] GREEN: normalize validated launchd output to unique root fields before passing it to existing checks.

## SC-002: Unknown on incomplete evidence

- [x] RED: add fake command cases for missing/duplicate expected PID, duplicate PID across labels, malformed or truncated lsof fields, permission failure, timed-out executor, over-limit output, and a failed unrelated launchd probe. Assert unknown cannot be passed as a complete port probe.
- [x] GREEN: return fixed sanitized reasons for each unknown class, preserve `LaunchdProbe` with null for failed or malformed output, and reject attribution whenever any configured job PID needed to establish uniqueness is unavailable.

## SC-003: Read-only and bounded execution

- [x] RED: capture fake executor arguments and assert only configured labels/ports, `/bin/launchctl print` and `/usr/sbin/lsof` TCP LISTEN field selection, `shell: false`, a finite deadline and a fixed byte cap. Assert invalid input invokes nothing and a hanging fake finishes as unknown within its deadline.
- [x] GREEN: implement the system executor with `execFile`, explicit `shell: false`, timeout and maxBuffer, and race injected execution against the same deadline. Never include command output in an error reason.
- [x] Configure Orca to use this repository's Bun test framework in `orca/config.yaml`.
- [x] Run `bun test scripts/dr`, `bun run typecheck`, and `bun run build`. Run `orca verify`, `orca gate-plan`, and `orca gate-code`; preserve their actual verdicts. Run `graphify update .` after editing code, then review the complete diff.
