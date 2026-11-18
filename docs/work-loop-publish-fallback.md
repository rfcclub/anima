# Work loop publish fallback

A work session is supposed to call the `publish` tool itself. A session may commit the change without calling it.
After the session ends, the host checks the work tree and, when the checks below all pass, performs the publish
the model skipped. The source of this behaviour is `src/work/publish-fallback.ts`, wired up in
`src/work/consumer.ts` and assembled in `src/work/production.ts`.

## When it runs

The consumer invokes the fallback only when the session ended with stop cause `done` or `max_reached`, the
fallback is configured, the lease was not lost during the session, and the session's processes were proven
stopped.

The fallback then publishes only if every one of these holds:

- the working tree is clean (`git status --porcelain --untracked-files=all` is empty);
- `HEAD` is on the work branch (`refs/heads/<branch>`), not detached;
- the branch head is a commit SHA;
- for a **start-work**: no pull request already exists for the branch, and the branch has at least one commit
  ahead of the base ref;
- for a **revise**: the branch has a head different from the reviewed head (`work.prHead`).

If any check fails, nothing is published and the skip reason is logged. An existing pull request is left to the
normal flow, which collects the evidence, instead of a second one being created.

## What it does

It pushes the work branch, and for a start-work it also opens the pull request, titled from the issue and with a
body containing `Closes #<issue>`. It does not approve or merge anything: it only performs the mechanical publish
the model skipped, and the reviewer gate is unchanged.

## Safety limits

- The git reads on the author's tree run in the same sandbox as the author's own tools (`readTreeGit`).
- Every write waits for the pending lease heartbeat to be answered and then re-checks the lease and the work's
  current generation (`settledGuard`); a guard failure stops the publish.
- A lease lost after that last check and before the write lands cannot be seen from the client: the check and
  the remote write are not atomic.
