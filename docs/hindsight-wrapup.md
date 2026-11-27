# Hindsight session wrap-up

A coding session already ends with a wrap-up, and its raw transcript is also retained into the
project's Hindsight bank (`retainSessions`, on by default) and extracted in `concise` mode. The
wrap-up is then only the tail of a long transcript, so the decisions it states compete with
everything else in the session and what survives extraction depends on compression rather than on
what the agent chose to keep.

`src/memory/hindsight-wrapup.ts` and `scripts/hindsight-wrapup.ts` write the wrap-up as **one**
document instead, so the project bank gets what the agent decided was worth keeping.

## Status: the writer only

This change is the **manual writer**. It formats and sends the document; it does not yet call
itself at session end, and it does not decide anything about transcript retention. Nothing is
turned off here: `retainSessions` stays as it is.

Still to gather, and **not** evidenced by this change:

- a real wrap-up ingested into a live bank and read back;
- that the server replaces a document written twice with the same `document_id` (the client sends
  the same id; what the server does with it is the server's behaviour, which no mock can show);
- that a decision stated only in a wrap-up is cited by the `Key decisions` page after the next
  scheduled refresh;
- the 20-session comparison and the retain cost per session.

#674 stays open until those exist. The table below is the shape of the evidence, not the evidence.

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

A section that is missing, present but empty, or out of the fixed order refuses the whole write. A
partial record reads as "the agent checked and found nothing" when in fact the section was never
written, which is worse than not writing the wrap-up at all; out-of-order sections make two
sessions' wrap-ups hard to diff.

## Ingest

```sh
bun scripts/hindsight-wrapup.ts --bank <bank> --session <session-id> --file wrapup.md
# or pipe it on stdin
```

This is the same write the plugin's `hindsight_ingest_document` performs: `POST
/v1/default/banks/<bank>/memories` with `context: "ingested document"`, `strategy: "document"` and
the `wrapup` tag. The client config is `~/.hindsight/coding-agent.json` (`apiUrl`, `apiToken`).

The **document id is `wrapup-<session-id>`**, keeping the session id verbatim. Writing the wrap-up
again for the same session addresses the same document instead of adding a second one; whether the
server replaces it is the behaviour still to verify (see *Status*). The id is not folded or
lowercased: `sess-a_b` and `sess-a-b` are different sessions, and folding them would make one
session's wrap-up silently replace the other's. The runtime's own ids
(`channel-<channelId>-<agentId>-<uuid>`, with `work:`/`remote:`/`ambient:` channels) carry `.` and
`:`, so those are allowed; path separators and `..` are refused rather than sanitised.

### Queued is not retained

The retain requests completion (`async: false`) and the call is bounded by a finite deadline
(`DEFAULT_RETAIN_TIMEOUT_MS`, overridable per call). There are three outcomes:

| Outcome | Meaning |
|---------|---------|
| `ok` | the server answered the retain itself: the document was processed |
| `queued` | the server accepted the write and returned an operation id: the document is **not** yet known to exist, so it must not be counted until that operation reports success |
| `error` | an incomplete wrap-up, a missing config, a non-2xx status, an absent or unreadable body (`reason: "unreadable-body"`), a 200 whose body states no status (`reason: "unconfirmed"`), a stalled request (`reason: "timeout"`) or a connection failure |

A 202, or any response carrying `operation_id`, is `queued` with that id — never `ok`. A body that
cannot be read (empty, non-JSON, or stalled past the deadline) and a body that carries no `status`
are **not** evidence that the document was stored, so they are `error`, never `ok`: a count of
retained wrap-ups must not include a document that may not exist. The CLI exits 0 only on `ok`,
and prints the reason otherwise.

Piped stdin is read to its end under a deadline too (`--stdin-timeout-ms`, default
`DEFAULT_STDIN_TIMEOUT_MS`). A stdin that is opened and never written or closed cannot hold the CLI
open: it reports `stdin-timeout` and exits 1.

### The session-end contract

`retainWrapup` never throws. An incomplete wrap-up, an unusable session id, a missing config, a
failed request and a stalled service all come back as `outcome: "error"` with a `reason`, so the
caller can end a session without a try/catch and without hanging on a host that never answers. Log
lines carry bank, outcome, document id, operation id and reason only: never the token.

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
| `wrapupOutcome` | `ok`, `queued` (with operation id) or `error`, so a wrap-up that never landed is not counted as one |

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
