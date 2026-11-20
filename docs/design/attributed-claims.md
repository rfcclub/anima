# Attributed Claims

> Substrate is written by more than one Bruno instance. A claim records who says
> it, on what evidence, how sure they are, and whether anyone disagrees.

The implementation lives in `src/substrate/attributed-claims.ts`; the pinned
contract is asserted by `__tests__/substrate/attributed-claims.test.ts`.

## Layers

The plain files stay the substrate. Attribution adds an append-only claim layer
next to the existing files; the projected self-model is derived, not
authoritative.

| Path | Purpose |
|------|---------|
| `_claims/claims.jsonl` | Append-only claim log, one JSON record per line |
| `_claims/resolutions.jsonl` | Append-only log of resolution acts |
| `_claims/manifest.json` | Freeze hash manifest written before any attribution |

## Claim record

```json
{
  "id": "clm_0123456789abcdef",
  "version": 1,
  "kind": "observation",
  "topic": "substrate-writes",
  "statement": "…",
  "author": "claude-code-bruno",
  "subject": "claude-code-bruno",
  "evidence": ["episode:2026-10-23-exchange"],
  "uncertainty": "likely",
  "status": "open",
  "supersedes": "clm_…",
  "recordedAt": "2026-10-27T00:00:00.000Z"
}
```

- **id scheme**: `clm_` + the first 16 hex characters of a sha256 over the
  record's identifying fields. Resolutions use the `res_` prefix.
- **kind** (closed): `observation`, `commitment`. A third kind does not exist.
- **status** (closed): `open`, `contested`, `resolved`, `retracted`.
- **uncertainty** (closed, ordered): `speculative`, `possible`, `likely`,
  `certain`.
- `evidence` holds at least one reference; `supersedes` links the previous claim
  by the same author on the same topic, which is never rewritten.
- `subject` names the instance whose self-model the claim is about. It defaults
  to `author`: a claim is about the writer unless it says otherwise. It survives
  projection exactly like `author`.

## Rules

1. **Append-only.** Conflicting claims are both kept with attribution.
   `detectDisagreements` reports topics held by more than one author.
2. **Resolution is a separate, recorded act.** `recordResolution` appends to
   `resolutions.jsonl`; it never edits the claim log.
3. **Projection cannot raise authority.** `projectClaims` may shorten evidence
   (summarised as `episode:+N more`), but kind, author and uncertainty survive
   verbatim. `projectionAuthorityViolations` reports any projected claim whose
   kind outranks the stored one.
4. **Promotion is explicit and governed.** No observation acquires normative
   authority by passing through memory ingestion, reflection or identity
   compilation; only the governed revision step (reflection and approval record,
   #156) may raise a claim's level.
5. **Migration freezes before it attributes.** `writeAttributionManifest` hashes
   the current files; `verifyAttributionManifest` recomputes them and reports
   `missing` and `changed`, so content loss is visible.
6. **Detection feed.** `attributionFlags` reports two shapes, each with no
   recorded resolution: a commitment rewrite whose writer differs from the
   previous holder, and a rewrite of another instance's self-model (`subject`
   differs from `author`). Each flag names the writer as claimed and the absent
   revision record; a revision to your own self-model is not flagged.
   Detection, reporting and refusal of the write belong to #156's write gate.

## Residual: attribution is a claim, not authentication

`author` is a string a writer types into a plain file, so any instance can write
any author string. Until #156's boundary separates actors, a claim's author is
recorded evidence of who says they wrote it — not proof. Tests assert that the
attribution is recorded and preserved, never that it is authenticated.
