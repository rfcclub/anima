# Design: DR watchdog live probes

## Components

`collectLiveProbes` accepts `owned`, `ports`, `uid`, `timeoutMs`, and an injected command executor. It validates every input before making any call, then invokes only `/bin/launchctl` with `print` and `/usr/sbin/lsof` with fixed TCP LISTEN field options plus one configured port. The executor receives a deadline and byte limit; the system implementation uses `execFile` with `shell: false`, `timeout`, and `maxBuffer`. The collection also bounds its wait for an injected executor.

Parse launchd output as a balanced job block and use only its top-level, unique fields. Return a normalized set of root fields so existing multiline checks cannot mistake nested state, PID or counters for job fields. A failed or malformed launchd result has `output: null`. If a configured job's PID is unknown, do not infer that a listener belongs to some other job. Parse lsof field records as complete PID/file/name/protocol/state groups and verify the requested port. Map a listener PID to exactly one configured PID; retain a separate PID for a proven foreign listener. Repeated sockets from one PID retain that PID so `checkPorts` can deduplicate them.

A complete lsof no-match is exit 1 with both output streams empty, the lsof convention; any stderr, timeout, malformed fields, nonzero exit with content, or missing expected owner PID is unknown. Reasons are fixed, short strings and never include command output.

## Test Strategy

Synthetic sanitized launchd/lsof fixtures and an injected fake cover the three approved success criteria, including nested job blocks. Tests call the existing pure checks for complete results and assert that unknown results never supply a `PortProbe`. A hanging fake exercises the collection deadline; oversized fake output exercises the output cap. Automated tests use no real host commands or network access.

`orca/config.yaml` selects Bun, matching the repository's documented test runner, so Orca can execute the linked tests using its Bun reporter.
