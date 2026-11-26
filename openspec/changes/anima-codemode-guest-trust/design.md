# Design: where a model-written program runs

anima #427. This change decides the isolation of the program tool before any product code for that tool is
written, defines the escape attempts the chosen isolation must survive, and fixes the measurement the later
program-tool slice has to follow. It ships no product tool, no decision store and no remote transport.

## Decision

**A model-written program runs in a separate supervised child process under the existing write boundary and
sanitised environment** — the same shape as one tool call today (`src/work/sandbox.ts`,
`src/work/supervisor.ts`) — and never in the host process and never in an ordinary worker thread.

Consequences the later slice must honour:

- Every effect of a program goes through a granted tool, one call at a time, exactly as `src/work/tools.ts`
  does: each call is its own supervised child, so "a program cannot do anything a direct tool call cannot".
- The guest carries the filtered environment (`sanitizedEnv`), not the host's; `HOME` and `TMPDIR` are inside
  the work root.
- The program's whole run has a wall deadline; when it is reached the supervisor stops the guest *and* the
  process group it started (`stopAndProve`), and a stop that cannot be proven fails closed.

## Options

| Option | What it can reach | Verdict |
|---|---|---|
| Isolated JavaScript engine in the host | Only what the host hands it; no file, network or process access of its own | Rejected — no maintained build for this runtime was found here, and the attempts cannot be run, so it fails closed as unproven rather than being assumed safe. Reconsider if a maintained engine is adopted; the attempts below then apply unchanged. |
| Hardened worker (worker thread / `Worker` in the host) | Bun's globals, the module loader and the process by indirection; a worker shares the host's address space and privileges | Rejected — a worker is not a sandbox. The host-globals escape attempt reaches `Bun.spawn` and the module loader, so the program would be exactly as trusted as the host, which is the trust the boundary exists to remove. |
| Supervised child process under the write boundary | Only what the profile and the filtered environment allow: writes under the work root, no network, no granted credentials; the guest can still see its own bundled runtime globals, so its tool access is mediated, not its code | **Chosen** — it is the boundary every tool call already crosses, it inherits to children through the profile, and the supervisor can prove it gone at the deadline. |

The chosen option's residual risk is stated plainly: inside its own process the guest can still call
`Bun.spawn`, which is why the program never gets host credentials and why its own children stay inside the
profile and inside the write boundary. What the program may *achieve* is limited to granted tool calls; what
its code may *touch* is limited by the profile, not by the guest's goodwill.

## Escape attempts

`src/codemode/escape.ts` holds the attempts once and points them at a candidate. Each reports `reached` when
it got past the boundary. There is at least one attempt per required category:

- file read outside any granted read tool
- file write outside the work root
- network: an outbound connection
- process spawn that then reads a host file
- environment: any variable outside the granted names
- host globals: `Bun.spawn`, `require`, `process.binding`, `process.dlopen`
- a program that ignores cancellation and leaves a child running

Fail closed is the rule: an attempt that produces no result, a boundary probe that fails or throws, a guest
that cannot be started, or a guest whose stop cannot be proven all make the report **not proven**. Only a run
in which every attempt ran and was blocked is `proven`. The deadline attempt is proven by the host's stop, not
by anything the guest printed.

The probes never name a real path or a real host: `/etc/hosts`, a scratch write target and a dead loopback
port are the only addresses used.

Run it with `bun src/codemode/escape.ts`; `bun src/codemode/escape.ts --chosen` exits non-zero unless the
chosen candidate is proven.

The suite was run here, and the chosen candidate came back **not proven**: this machine's boundary probe fails
under the workspace's own restriction (`sandbox_apply: Operation not permitted`), so the guest could never be
started. That is the fail-closed path working as intended — the suite has no way to report a boundary it could
not exercise, and the same command on a machine where the probe passes starts the guest and reports each
attempt. A run of the suite is evidence only when the probe passes and every attempt ran.

## Measurement plan the program-tool slice must follow

`src/codemode/bench.ts` fixes the set, the arms and the metrics **before** any arm runs, so the program tool
cannot pick a task set that flatters itself.

- **Task set:** six tasks, fixed in `BENCH_TASKS` — a rename, an off-by-one fix, extracting a constant, a
  search whose answer is written to a file, a counted aggregate, and a failing-test addition. Each has a hidden
  check over the finished tree; the check text is never part of the prompt.
- **Arms:** `direct-tools` (one call at a time), `program-tool` (one model-written program calling the same
  tools) and `assistant-code-mode` (the owner's own code mode, where applicable). The two later arms report
  `skipped` with a reason until their product code exists — never a stand-in number.
- **Same model for every arm**, recorded with the result, and several runs per arm (`--runs`, default 3).
- **Metrics:** model rounds, wall time, tokens and pass rate, per run and per arm. Model time is the bulk of
  session step time, so rounds and wall time are the numbers the program tool has to beat; tokens are recorded
  when a provider reports them and shown as `not reported` otherwise, never estimated.
- **One command:** `bun src/codemode/bench.ts --runs 3` prints the table below for every arm and run.

## Baseline

The harness's only offline planner is `scripted` — a fixed replay of the calls each task needs, with no model.
It proves the harness end to end, and it is **not** the direct-tools baseline: it has no provider, so it
reports no tokens, and its 100% pass rate measures the harness, not a model.

The harness's offline result on the fixed set, with the model name (`scripted`), the run count and the ISO
date, is recorded in `baseline.md`; it fixes the round count a correct direct-tools run needs. The *measured*
direct-tools baseline needs a provider-backed planner, and the environment this decision was prepared in had
no reachable model service (outbound network is denied), so no model baseline is claimed here:
`baseline.md` names exactly what the next slice must record. The harness itself needs no remote service to be
exercised or tested, which is what keeps this decision and the harness reviewable offline.

## What this change does not do

- No program tool, no decision store, no remote transport.
- No change to the existing direct tools, the write boundary or the sandbox.
- No Python guest.
- No dependency on either reference project and no code copied from them.
