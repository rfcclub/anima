# Baseline: direct tools on the fixed task set

anima #427. This records the number later slices have to beat. The task set, the arms and the metrics are
fixed in `src/codemode/bench.ts` before any arm ran; nothing here changes them.

## What was run

- **Command:** `bun src/codemode/bench.ts --runs 3`
- **Task set:** the six tasks in `BENCH_TASKS` (rename, off-by-one fix, extract a constant, a search written to
  a file, a counted aggregate, a failing-test addition), each with a hidden check over the finished tree.
- **Arm:** `direct-tools`.
- **Planner:** `scripted` — the harness's offline replay of the calls each task needs.
- **Runs:** 3.
- **Date:** 2026-11-26.

## Result (offline planner)

```
arm direct-tools
  run 1: rounds 12, wall 0 ms, tokens not reported, pass rate 100%
  run 2: rounds 12, wall 0 ms, tokens not reported, pass rate 100%
  run 3: rounds 12, wall 2 ms, tokens not reported, pass rate 100%
  total: rounds 36, wall 2 ms, tokens not reported, pass rate 100%
arm program-tool: skipped (no product code for this arm in this slice)
arm assistant-code-mode: skipped (no product code for this arm in this slice)
```

Two rounds per task (read, then edit or write), so twelve rounds per run of six tasks; the wall time is the
harness's own file work with no model in the loop.

## Why this is not the measured model baseline

The `scripted` planner has no provider. It reports no tokens, and its pass rate measures the harness, not a
model. It proves the harness end to end and it fixes the round count a correct direct-tools run needs — it is
**not** a number to beat.

The measured direct-tools baseline needs a provider and a model, and this run had neither: the environment
this change was prepared in has no reachable model service (outbound network is denied). Recording a number
anyway would mean inventing it, which the harness refuses to do and this report refuses to do.

## What the next slice must record

Run the same command with a planner backed by the session's pinned provider and model, then append here:

- the model name, verbatim, and the ISO date of the run;
- runs per arm (at least three);
- rounds, wall time, tokens and pass rate per run and per arm, exactly as `formatReport` prints them;
- the two other arms as `skipped` with a reason until their product code exists.

A baseline without a model name and a date is not a baseline, and must not be quoted as one.
