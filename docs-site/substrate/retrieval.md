# Per-Cartridge Retrieval

When the [execution plan](../cartridge/activation.md#execution-plan) has a `substrateRetrievalPlan`, `AgentSession` runs it with `executeRetrievalPlan()` (`src/cartridge/retrieval.ts`). The results go into the prompt's **Trusted Memory** and **Unverified Candidates** sections.

## How it works

```
For each request in the plan (one per cartridge with retrieval.scopes):
  → adapter.recall(message, { scopes, topK: top_k })
  → tag each result: requested_by = [cartridge], policy_id = cartridge
  → trusted = confidence >= 0.5
Merge all results
  → dedupe by id
  → rank by score, then confidence
  → apply the evidence rule
```

`adapter` is the agent's recall adapter (see [Memory](./memory.md#recall-adapters)). A result's `score` is the adapter's score, or its confidence if there is none.

## Merge and dedupe

`mergeAndDedupe()`:

1. When the same `id` comes from several requests, the `requested_by` lists are merged.
2. The higher confidence (and its score) is kept.
3. The merged list is sorted by `score` descending, then `confidence` descending.

The requests' `max_tokens` and the plan's `globalBudget` aren't applied at this step.

## Evidence rule

`splitTrustedUnverified()` uses the strictest setting among all requests:

| Any request has `require_evidence: true`? | Trusted results? | Any request has `allow_unverified_fallback: true`? | Result |
|----|----|----|----|
| No | — | — | Every result is trusted |
| Yes | Yes | — | Only trusted results are used |
| Yes | No | Yes | The untrusted results are shown as Unverified Candidates |
| Yes | No | No | Nothing is used, and a `substrate_context_starved` event is logged |

"Trusted" means only `confidence >= 0.5`. There's no provenance check, even though results can carry a `provenance` field.

## No plan

If there's no plan or it has no requests, the adapter is called once with `topK` set to the fallback (`memory.topK`, default 5). Results get `policy_id: "legacy"`. If nothing comes back, `substrate_context_starved` is logged.

## Errors

If retrieval throws, the session logs `substrate retrieval failed — continuing without cartridge retrieval` and builds the prompt without these sections.

## Separate from per-turn recall

This is in addition to the agent's normal per-turn recall, which calls the same adapter with `topK`, `recallMode` and `recentDays` from the `memory:` config and adds a `[Memory Context]` block to the prompt.
