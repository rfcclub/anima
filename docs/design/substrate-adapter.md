# Substrate Adapter / Substrate View Layer

> Cartridges declare canonical memory scopes, not substrate paths.  
> Each agent provides a `substrate.map.yaml` that maps canonical scopes to concrete substrate sources.  
> ANIMA core talks only to `SubstrateAdapter`.

## Core Principle

Do not standardize the substrate. Standardize the view interface.

Each agent has a unique native substrate layout. ANIMA must not force every agent into the same directory structure. Instead, ANIMA reads a per-agent map that localizes each agent's anatomy into a shared set of **canonical memory scopes**.

## Flow

```
Agent-specific substrate
  (any native layout)
        ↓
  SubstrateAdapter (MappedFilesystemAdapter v1)
        ↓
  Canonical Memory Scopes
        ↓
  Substrate View Layer
        ↓
  Prompt Assembler
```

## Canonical Memory Scopes

| Scope | Description |
|-------|-------------|
| `identity_core` | Stable identity, axioms, self-definition |
| `values` | Core values and moral/behavioral commitments |
| `self_model` | Self-understanding, heuristics, reflective notes |
| `relationship` | Relationship memory with the owner and other agents |
| `episodic_memory` | Session logs and event memory |
| `scars` | Mistakes, drift events, corrections, hard lessons |
| `project_history` | Project decisions, design notes, plans, specs |
| `skills` | Capabilities, tools, learned patterns |
| `world_lore` | Fictional / world-building material |
| `style_memory` | Voice, tone, style, critiques |
| `current_state` | Recent operational state and continuity |
| `open_threads` | Unresolved concerns and open questions |

## Runtime-Required Scopes

These scopes are invariants for every turn. They are assembled by the Identity Engine / Prompt Assembler, not declared by cartridges.

```yaml
runtime_required_scopes:
  - identity_core
  - current_state
```

- `agent_defaults` may add scopes, but may **not** remove or override runtime-required scopes.
- For companion-style agents, `relationship` may be added as a default scope at the agent level, but this is not universal.

## substrate.map.yaml v1

```yaml
version: 1

agent_id: myagent
substrate_type: custom
root: ~/substrate/myagent

required_scopes:
  - identity_core
  - current_state

scopes:
  identity_core:
    description: Stable identity, axioms, and self-definition.
    required: true
    sources:
      - type: paths
        paths:
          - 0_SOUL/
          - 1_EGO/
        trust: high
        weight: 1.0
        evidence_required: true

  current_state:
    description: Current operational state and recent continuity state.
    required: true
    sources:
      - type: paths
        paths:
          - state/
          - CURRENT.md
        trust: medium
        weight: 0.8
        evidence_required: false

  self_model:
    description: Self-understanding, heuristics, reflective notes.
    required: false
    sources:
      - type: paths
        paths:
          - 1_EGO/
          - 2_MIND/
        trust: medium
        weight: 0.8
        evidence_required: true

  relationship:
    description: Relationship memory with the owner and other agents.
    required: false
    sources:
      - type: paths
        paths:
          - relations/
        trust: high
        weight: 1.0
        evidence_required: true

  project_history:
    description: Project decisions, design notes, plans, specs, and tasks.
    required: false
    sources:
      - type: paths
        paths:
          - projects/
          - design/
          - tasks/
        trust: medium
        weight: 0.8
        evidence_required: true

  scars:
    description: Mistakes, drift events, corrections, and hard lessons.
    required: false
    sources:
      - type: paths
        paths:
          - scars/
          - incidents/
        trust: high
        weight: 1.0
        evidence_required: true
```

### Source Type

v1 supports only `type: paths`. Additional source types such as `sqlite`, `graph`, `mcp`, and `harness_jsonl` are reserved for future versions but are not supported in v1.

### Evidence

`evidence_required: true` declares that the scope must be retrievable with provenance or confidence metadata (frontmatter, sidecar `.meta.json`, git history, episode ID, source link, or parent memory ID). Plain markdown without an evidence provider should produce a validation warning.

## SubstrateAdapter Interface

```ts
export interface ScopeDefinition {
  name: string;
  description: string;
  required: boolean;
  sources: SubstrateSource[];
}

export interface SubstrateSource {
  type: "paths"; // v1 only
  paths: string[];
  trust: "low" | "medium" | "high";
  weight: number; // 0.0–1.0
  evidenceRequired: boolean;
}

export interface ResolvedScope {
  name: string;
  description: string;
  required: boolean;
  files: ResolvedFile[];
}

export interface ResolvedFile {
  absolutePath: string;
  relativePath: string;
  scope: string;
  sourceIndex: number;
  trust: "low" | "medium" | "high";
  weight: number;
  evidenceRequired: boolean;
}

export interface RetrievalRequest {
  scopes: string[];
  query?: string;
  topK?: number;
  maxTokens?: number;
  requireEvidence?: boolean;
}

export interface RetrievalResult {
  id: string;
  absolutePath: string;
  relativePath: string;
  content: string;
  scopesMatched: string[];
  sourceIds: string[];
  requestedBy: string[]; // cartridge identifiers
  trust: "low" | "medium" | "high";
  weight: number;
  score?: number;
  evidence?: EvidenceMetadata;
  status: "ok" | "missing_scope" | "empty" | "unsupported_source" | "error";
}

export interface ValidationDiagnostic {
  path: string;
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

export interface SubstrateAdapter {
  agentId: string;
  substrateType: string;

  listScopes(): ScopeDefinition[];
  hasScope(scope: string): boolean;
  resolve(scope: string): ResolvedScope;
  retrieve(request: RetrievalRequest): Promise<RetrievalResult[]>;
  validateMap(): ValidationResult;
}
```

## Concrete Implementations

v1 ships with one concrete adapter:

- `MappedFilesystemAdapter` — reads `substrate.map.yaml`, resolves canonical scopes to filesystem paths, returns text chunks.

Future adapters may include:

- `GraphBackedSubstrateAdapter`
- `SQLiteMemoryAdapter`
- `HybridSubstrateAdapter`
- agent-specific adapters

ANIMA core calls `adapter.retrieve(...)` and remains agnostic of the underlying substrate layout.

## Cartridge Retrieval Policy

Cartridges request scopes, not paths:

```yaml
retrieval:
  required:
    - project_history

  preferred:
    - coding_memory
    - scars

  optional:
    - relationship

  top_k: 8
  max_tokens: 2000
  require_evidence: true

  fallback:
    project_history:
      on_missing: block
      message: "Cannot review without project history or current artifact context."
    scars:
      on_missing: continue_with_warning
    coding_memory:
      on_missing: continue
    relationship:
      on_missing: continue_with_placeholder
```

### Fallback Actions

| Action | Meaning |
|--------|---------|
| `block` | Stop activation; the requested task cannot proceed without this scope. |
| `ask_for_context` | Prompt the owner for missing context. |
| `continue_with_warning` | Proceed but log a warning that the scope is absent. |
| `continue` | Proceed silently. |
| `continue_with_generic` | Substitute generic behavior/style. |
| `continue_with_placeholder` | Explicitly tell the model the scope is absent so it does not hallucinate. |

### Activation Rules

- Unknown `required` scope → activation error.
- Unknown `preferred` or `optional` scope → warning + fallback.
- Adapter returns structured status codes (`missing_scope`, `empty`, `unsupported_source`, `error`); cartridge fallback policy decides how to act.
- Invalid map files fail at validation/startup.

## Deduping

A single filesystem path may participate in multiple scopes. The adapter deduplicates at the result/chunk identity level, not the path level. If the same chunk is retrieved through multiple scopes, the adapter keeps one result and merges metadata:

- `scopesMatched`: all scopes that contributed this chunk
- `requestedBy`: all cartridges that requested it
- `sourceIds`: all source entries that produced it
- `weight`/`score`: combined using the highest weight or score, configurable per adapter

## Validation Rules

1. `version` exists and is supported.
2. `agent_id` exists.
3. `substrate_type` exists.
4. `root` exists or is resolvable.
5. `required_scopes` contains `identity_core` and `current_state`.
6. Every required scope exists in `scopes`.
7. Every scope has at least one source.
8. Every source has a valid `type`.
9. `paths` source must have at least one path.
10. `trust` ∈ {`low`, `medium`, `high`}.
11. `weight` ∈ [0.0, 1.0].
12. No duplicate YAML scope keys (error if detectable).
13. Unknown required cartridge scope at activation time → activation error.
14. Unknown preferred/optional cartridge scope → warning + fallback.
15. `evidence_required: true` requires at least one evidence-capable source; otherwise emit a validation warning.

Validation returns structured diagnostics:

```ts
{ path: string; code: string; severity: "error" | "warning"; message: string }
```

## File Location

`rooms/{agent}/substrate.map.yaml`

This is ANIMA runtime configuration. It references native substrate roots (for example `~/substrate/myagent`) without modifying them.

## Relationship to Other Concepts

- `SOUL.md` — one source inside `identity_core`, not the whole identity.
- `AGENTS.md` — agent manifest/config source, separate from substrate.
- `scars/` — behavioral correction source.
- `relations/` — relationship source.
- `logs/` — episodic source.
- `graph DB` — semantic association source.
- `essays/` — self-narrative source.

All belong to the substrate, but the adapter maps them into canonical scopes.

## Example Turn

Owner: "myagent, review this design."

Resolver creates execution plan:

```yaml
identity:
  agent: myagent

persona:
  companion

working_role:
  reviewer

cartridges:
  - kernel/truthfulness
  - role/reviewer
  - domain/programming
  - project/anima

retrieval_plan:
  include:
    - project_history
    - scars
  require_evidence: true
  max_tokens: 3000
```

Identity Engine assembles invariants:

```yaml
runtime_required_scopes:
  - identity_core
  - current_state

agent_defaults:
  default_scopes:
    - relationship
```

The agent's `MappedFilesystemAdapter` resolves:

- `identity_core` → `~/substrate/myagent/0_SOUL` + `~/substrate/myagent/1_EGO`
- `current_state` → `~/substrate/myagent/state` + `~/substrate/myagent/CURRENT.md`
- `relationship` → `~/substrate/myagent/relations`
- `project_history` → `~/substrate/myagent/projects` + `~/substrate/myagent/design` + `~/substrate/myagent/tasks`
- `scars` → `~/substrate/myagent/scars` + `~/substrate/myagent/incidents`

Then retrieval runs, dedupes results, and feeds the Substrate View into the Prompt Assembler.

## Non-Goals

- Standardizing agent directory layouts.
- Replacing agent substrate (augment, never duplicate).
- Supporting non-text substrate sources in v1 (embeddings, LoRA, databases).
- Real-time substrate synchronization.
