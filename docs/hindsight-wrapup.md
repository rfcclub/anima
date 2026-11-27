# Hindsight session wrap-up

A coding session already ends with a wrap-up, and its raw transcript is also retained into the
project's Hindsight bank (`retainSessions`, on by default) and extracted in `concise` mode. The
wrap-up is then only the tail of a long transcript, so the decisions it states compete with
everything else in the session and what survives extraction depends on compression rather than on
what the agent chose to keep.

`src/memory/hindsight-wrapup.ts` and `scripts/hindsight-wrapup.ts` write the wrap-up as **one**
document instead, so the project bank gets what the agent decided was worth keeping.

## The document

Written by the agent at the end of a session, in English, with these fixed sections (in this
order):

```markdown
## Decisions made and why
## What shipped
## Open work
## Owner corrections
## Claims needing verification
```

- `Decisions made and why` states the decision and its reason, not just the change.
- `What shipped` names the issue and pull request numbers.
- `Open work` is what the session leaves undone.
- `Owner corrections` records where the owner corrected the agent.
- `Claims needing verification` marks what the session asserted but did not check.

A section that is present but empty, or missing, refuses the whole write. A partial record reads as
"the agent checked and found nothing" when in fact the section was never written, which is worse
than not writing the wrap-up at all.

## Ingest

```sh
bun scripts/hindsight-wrapup.ts --bank <bank> --session <session-id> --file wrapup.md
# or pipe it on stdin
```

This is the same write the plugin's `hindsight_ingest_document` performs: `POST
/v1/default/banks/<bank>/memories` with `context: "ingested document"`, `strategy: "document"` and
the `wrapup` tag. The client config is `~/.hindsight/coding-agent.json` (`apiUrl`, `apiToken`).

The **document id is `wrapup-<session-id>`**, keeping the session id verbatim. Writing the wrap-up
again for the same session replaces the earlier document instead of adding a second one. The id is
not folded or lowercased: `sess-a_b` and `sess-a-b` are different sessions, and folding them would
make one session's wrap-up silently replace the other's. An empty or traversal-shaped session id is
refused rather than sanitised.

The write never throws for a session-ending agent: a missing config or a failed request returns
`{ outcome: "error", reason }` and the CLI exits 1. Log lines carry bank, outcome and reason only:
never the token.

## The experiment before anything is turned off

Transcript retention stays **on for 14 days**. For a sample of **20 sessions**, read the retained
transcript and its wrap-up side by side and record, per session:

| Field | Meaning |
|-------|---------|
| `ownerCorrectionsInTranscript` | corrections the owner gave in the session |
| `ownerCorrectionsInWrapup` | how many of those the wrap-up states |
| `decisionsInTranscript` | decisions the session reached |
| `decisionsInWrapup` | how many of those the wrap-up states |
| `retainCost` | what the turn's transcript retain cost for that session |

Record the **counts**, not a summary: the point is to be able to recount them from the table. The
share of owner corrections and of decisions that reach the wrap-up is what decides the next step.

## The agent decides

After the experiment, the agent that wrote the wrap-ups reads its own comparison and decides
whether to keep or turn off transcript retention for the banks it works in. `retainSessions: false`
is a per-bank setting: git ingest, pages and the memory tools keep working. The owner is not a
gate.

The decision is reversible, and the agent records it, the numbers behind it and the date in its
next wrap-up under `Decisions made and why`.

## What turning transcripts off loses

State this in the decision:

- dialogue-only decisions and owner corrections that the agent did not write down;
- sessions that end abruptly and never reach a wrap-up.

If the second matters, evaluate a hook that retains only the owner's own messages (small, and the
most valuable part) instead of the whole transcript.

## Not in scope

Changing how the plugin extracts memory on the server, and per-agent identity memory: the project
bank is project knowledge.
