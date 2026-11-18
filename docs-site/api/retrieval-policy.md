# RetrievalPolicy

A cartridge's `retrieval:` frontmatter says which memory to query when the cartridge is active.

## Interface

```typescript
// src/cartridge/types.ts
interface RetrievalPolicy {
  scopes?: MemoryScope[];                       // memory scopes for the retrieval plan
  substrate_scopes?: CanonicalSubstrateScope[]; // used only through IdentityRuntime's ScopeMapper
  top_k?: number;                               // default 5
  max_tokens?: number;                          // default 2000
  require_evidence?: boolean;                   // default false
  allow_unverified_fallback?: boolean;          // default false
}
```

The registry keeps `retrieval` only if it has a `scopes` or `substrate_scopes` array. An invalid `substrate_scopes` value skips the whole cartridge file with a warning.

`substrate_scopes` values: `identity_core`, `values`, `self_model`, `relationship`, `episodic_memory`, `scars`, `project_history`, `skills`, `world_lore`, `style_memory`, `current_state`, `open_threads` (see `CANONICAL_SUBSTRATE_SCOPES` in `src/identity-runtime/contract/types.ts`).

## From policy to plan

`compileRetrievalPlan()` (`src/cartridge/activation.ts`) turns the active cartridges' policies into a `SubstrateRetrievalPlan`:

```typescript
interface SubstrateRetrievalPlan {
  requests: Array<{
    cartridgeName: string;
    scopes: MemoryScope[];
    top_k: number;           // top_k ?? 5
    max_tokens: number;      // max_tokens ?? 2000
    require_evidence: boolean;
    allow_unverified_fallback: boolean;
  }>;
  fallbackTopK?: number;     // set only if some active cartridge has no scopes
  globalBudget: number;      // the execution plan's budget limit
}
```

Only cartridges with a non-empty `scopes` list produce a request. How the requests are run is described in [Substrate Retrieval](../substrate/retrieval.md).

## Example

```yaml
retrieval:
  scopes: [project, episode]
  top_k: 8
  max_tokens: 2000
  require_evidence: true
  allow_unverified_fallback: true
```
