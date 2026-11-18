# ADR-0002: Substrate View Layer

**Status:** Accepted

## Context

ANIMA's memory recall was flat and static per agent:
- `adapter.recall(message, { topK: 5 })` — same for every turn
- SOUL.md was injected raw, uncapped (unbounded for large SOUL files)
- No cartridge-driven retrieval — a coding turn and a greeting turn queried substrate identically

## Decision

Cartridges declare **retrieval policies** instead of carrying substrate inline. The system:

1. **Compiles** a retrieval plan from resolved cartridges
2. **Executes** per-cartridge `adapter.recall()` calls (not union query)
3. **Merges/dedupes** results with attribution (`requested_by`)
4. **Splits** into Trusted Memory vs Unverified Candidates
5. **Replaces** raw SOUL injection with Identity Engine summary

### Key Design Decisions

1. **Per-cartridge retrieval** — Each cartridge gets its own recall call. Attribution preserved.
2. **Strictest-winner rule** — If any cartridge sets `require_evidence: true`, all memories held to strict standard.
3. **Two-tier filtering** — Trusted Memory (confidence >= threshold + provenance) vs Unverified Candidates (separate section, opt-in).
4. **Identity Engine** — SOUL.md tiered into Identity Core / Stable Preferences / Current State. Bounded summary replaces raw injection.
5. **Fallback** — No retrieval policy = flat topK (legacy behavior).

## Consequences

- **Positive:** Retrieval is cartridge-aware. Identity is bounded. Substrate can grow without changing architecture.
- **Negative:** N synchronous recall calls per turn (N = cartridges with retrieval policy).
- **Mitigation:** Batching/caching is a valid future optimization.
