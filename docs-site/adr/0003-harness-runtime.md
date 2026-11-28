# ADR-0003: Pi as the harness runtime, qualified at 1.1.x

**Status:** Proposed (pending the qualification run on the Mac Mini, then Windows)

## Context

ANIMA drives an agent–harness pair: ANIMA owns identity, memory and tools, the harness owns the model loop,
the session, Code Mode and the tool policy inside the harness. The harness therefore has to be drivable
programmatically, keep one session across revisions, run Code Mode with state, reach a strong-model provider
through a custom provider config, and run on Windows as well as the Mac Mini.

The comparison of 2026-10-11 looked at Pi, Crush and Prime Agent:

| | Pi | Crush | Prime Agent |
|---|---|---|---|
| Language | TypeScript (Node ≥ 22.19) | Go, single binary | Rust + Python runtime |
| Programmatic control | `--mode rpc` (JSONL), `--session-id`, SDK | `crush run --session`, HTTP `/v1` | `--mode rpc/acp/daemon` |
| Code Mode | built-in `codemode` tool with `store`/`load` | none, MCP only | persistent IPython REPL |
| Tool policy | `--tools` / `--exclude-tools`, extensions | permissions allow-list | `--tools`, "not a security sandbox" |
| Windows | installer, CI matrix includes windows-x64/arm64 | first-class | beta channel only |

## Decision

**Pi**, qualified at 1.1.x in an isolated profile, is the harness runtime. **Crush** stays the fallback: it is the
strongest on Windows and has an HTTP API. **Prime Agent** is left for later evaluation — pre-1.0, beta-only
Windows builds, and it runs model-written Python with user permissions.

`scripts/harness-qualification.ts` holds the decision rule, so it is judged from recorded evidence rather than
from a summary. A run is a set of steps, each with the raw output and the exit code it left behind:

- `launch`, `prompt`, `settled-report`, `revision-1`, `revision-2`, `cancellation`, `resume`
- `codemode-store`, `codemode-load`, `codemode-load-after-resume`
- `tool-denial`, `strong-model`, `extension-compat`

A step passes only with a recorded exit code of 0 and non-empty output; the lifecycle steps must all name the
same session ID; the isolated profile must be absolute and outside the global install, whose digest must be
unchanged; output carrying a credential fails the step and is never repeated in the report.

`decideHarness` returns Pi only when every Mac Mini run qualifies and no Windows failure is unrecorded. A
Windows check that failed with its output kept is a recorded failure, as the issue's Windows criterion says,
not a blocker.

The runner writes its record as `{ "runs": [ ... ] }` and the same script judges it, so the decision is taken
from the evidence file and not from a retyped summary:

```sh
bun scripts/harness-qualification.ts evidence.json   # 0 pi, 1 not-pi, 2 unreadable evidence
```

Evidence that is not JSON, that has no `runs` array, or that carries a run without a platform or without
steps is refused with exit 2 — an unrecorded run is never counted as a pass.

## Consequences

- **Positive:** the harness choice is a judged artefact, not a preference; a pass cannot be claimed from a
  summary, and a platform-specific failure has to name its output.
- **Negative:** the runner that collects the evidence lives outside the repository (it uses the owner's
  provider config and a disposable repository), so only the judging half is versioned here.
- **Open:** whether the harness uses Fabric's `fabric_exec` or Pi's native `codemode`; where the kourier and
  opendesign provider configs live; whether pi-soffio's identity integration is loaded into the harness profile.
