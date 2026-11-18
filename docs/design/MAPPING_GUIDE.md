# Substrate Mapping Guide

> How to map your agent's native substrate (a numbered-folder layout, a flat `context/` folder, or any custom layout) to ANIMA canonical memory scopes.

## TL;DR

1. Read the [12 canonical scopes](#canonical-scopes) below
2. Create `substrate.map.yaml` in the agent's substrate root (e.g. `~/substrate/myagent/substrate.map.yaml`)
3. For each scope your substrate can provide, map directories/files to the scope
4. Validate the map with `bun test __tests__/substrate/` or the snippet in Step 6
5. The loader finds the map at `rooms/<name>/substrate.map.yaml` or in the agent's own substrate directory

## What This Is

ANIMA's Identity Engine needs to retrieve memory context for every turn. But each agent stores memory differently — one may use numbered folders such as `0_SOUL/`, `1_EGO/`, `2_MIND/`; another may use its own layout; a simple agent might use a single `context/` folder.

**The substrate map is a per-agent YAML file that tells ANIMA: "when a cartridge asks for scope X, look in these directories/files."**

You do NOT need to restructure your substrate. You just declare where things are.

## Canonical Scopes

These 12 scopes are the shared vocabulary. Not every agent needs all 12 — map only what your substrate actually contains.

**IMPORTANT: `identity_core` in the substrate map is for SUPPLEMENTARY identity files only.** Do NOT include `SOUL.md` or `PREFACE.md` here — Identity Engine already loads and tiers SOUL.md (into 4-5 layers: core, preferences, state, etc.) separately. The substrate adapter adds context BEYOND what Identity Engine provides.

| # | Scope | What It Means | Example Sources |
|---|-------|---------------|-----------------|
| 1 | `identity_core` | Who you are — axioms, self-definition, stable identity | `0_SOUL/`, `identity.md`, `axioms/` |
| 2 | `values` | Core values, moral commitments, behavioral rules | `values.md`, `ethics/`, `principles/` |
| 3 | `self_model` | Self-understanding, heuristics, reflective notes | `1_EGO/`, `self.md`, `meta/` |
| 4 | `relationship` | Memory of relationships (the owner, other agents) | `4_RELATIONS/`, `owner.md`, `bonds/` |
| 5 | `episodic_memory` | Session logs, event records, past interactions | `3_MEMORY/`, `sessions/`, `logs/` |
| 6 | `scars` | Mistakes, drift events, corrections, hard lessons | `scars/`, `incidents/`, `corrections/` |
| 7 | `project_history` | Project decisions, design notes, plans, specs | `projects/`, `design/`, `tasks/` |
| 8 | `skills` | Capabilities, tools, learned patterns, craft | `skills/`, `tools/`, `capabilities/` |
| 9 | `world_lore` | Fictional/world-building material, narrative state | `lore/`, `world/`, `narrative/` |
| 10 | `style_memory` | Voice, tone, style references, writing critiques | `style/`, `voice/`, `tone/` |
| 11 | `current_state` | Recent operational state, continuity, active concerns | `state/`, `CURRENT.md`, `now/` |
| 12 | `open_threads` | Unresolved questions, open concerns, pending items | `open/`, `threads/`, `pending/` |

### Runtime-Required Scopes

Two scopes are **mandatory for every agent** — the Identity Engine always assembles them:

- **`identity_core`** — without identity, there is no coherent agent
- **`current_state`** — without state, there is no continuity between turns

You MUST define both in your map's `required_scopes` and `scopes` sections.

## Schema (v1)

```yaml
version: 1                          # always 1 for now

agent_id: your-agent-name           # unique agent identifier
substrate_type: your-substrate      # free-form label for the layout
root: ~/path/to/your/substrate      # absolute or ~-prefixed path

required_scopes:                    # must include at minimum:
  - identity_core
  - current_state

scopes:                             # one entry per scope you support
  scope_name:
    description: Human-readable description of what this scope contains.
    required: true | false          # true = agent cannot operate without it
    sources:                        # at least one source per scope
      - type: paths                 # v1 only supports "paths"
        paths:                      # directories or files, relative to root
          - relative/path/
          - another/file.md
        trust: low | medium | high  # how reliable is this source?
        weight: 0.0 - 1.0           # relative importance of this source
        evidence_required: true | false  # must content have provenance metadata?
```

### Path Resolution

- **Directories** (ending with `/`) — globbed recursively for all `.md`, `.txt`, `.yaml`, `.json` files
- **Files** — resolved directly
- **Glob patterns** — `state/*.md`, `projects/**/design.md` — standard glob syntax
- All paths are **relative to `root`**

### Trust & Weight Guidelines

| Trust | When to Use |
|-------|-------------|
| `high` | Source you wrote yourself, frequently reviewed, carries direct evidence |
| `medium` | Auto-generated, derived, or infrequently updated source |
| `low` | External reference, cached copy, unverified content |

| Weight | When to Use |
|--------|-------------|
| `0.8–1.0` | Primary source for this scope — this IS the scope |
| `0.5–0.7` | Supporting source — adds context but not authoritative |
| `0.1–0.4` | Ancillary — nice to have, low signal |

### Evidence

Set `evidence_required: true` when content in this scope should carry provenance metadata (YAML frontmatter with `confidence`, `episode_id`, `source_link`, etc.). If your files don't have frontmatter, either:

- Add frontmatter to key files (see [Adding Evidence](#adding-evidence-metadata))
- Create `.meta.json` sidecar files
- Set `evidence_required: false`

## Step-by-Step: Mapping Your Substrate

### Step 1: Create the file in YOUR substrate root

```bash
# Create the map in the agent's own substrate directory:
touch ~/substrate/myagent/substrate.map.yaml
```

### Step 2: Fill in the header

```yaml
version: 1
agent_id: your-agent-id
substrate_type: your-substrate-type
root: ~/path/to/your/memory/root
```

### Step 3: Map `identity_core` (MANDATORY)

Walk your substrate root. Find the files/directories that answer: **"Who am I?"**

```yaml
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
          - identity/          # directory containing identity files
          - axioms.md          # single file with core axioms
        trust: high
        weight: 1.0
        evidence_required: true
```

### Step 4: Map `current_state` (MANDATORY)

Find files that answer: **"What was I just doing? What's my current context?"**

```yaml
  current_state:
    description: Current operational state and recent continuity.
    required: true
    sources:
      - type: paths
        paths:
          - state/
          - CURRENT.md
        trust: medium
        weight: 0.8
        evidence_required: false
```

### Step 5: Map optional scopes

For each remaining scope your substrate can satisfy, add an entry. **Skip scopes your substrate doesn't have** — it's better to be honest than to point at irrelevant files.

### Step 6: Validate

```bash
bun test __tests__/substrate/
```

Or validate just your map:

```ts
import { MappedFilesystemAdapter } from "../src/substrate/mapped-filesystem-adapter";
import { readFileSync } from "node:fs";

const map = readFileSync("rooms/YOUR_AGENT_ID/substrate.map.yaml", "utf-8");
const adapter = new MappedFilesystemAdapter(map);
const result = adapter.validateMap();
console.log(result); // { valid: boolean, diagnostics: [...] }
```

### Step 7: Test retrieval

```ts
const results = await adapter.retrieve({
  scopes: ["identity_core", "current_state"],
  requireEvidence: true,
});
console.log(results.map(r => ({ path: r.relativePath, status: r.status, evidence: !!r.evidence })));
```

## Adding Evidence Metadata

Files that carry `evidence_required: true` should include YAML frontmatter:

```markdown
---
confidence: 0.9
episode_id: "2026-07-04-reflection"
source_link: "https://..."
parent_memory_id: "mem-123"
provenance: "self-written"
---

# Content starts here
```

Or create a sidecar `.meta.json` next to the file:

```json
{
  "confidence": 0.9,
  "episode_id": "2026-07-04-reflection",
  "provenance": "self-written"
}
```

## File Location Convention

```
{your_substrate_root}/
  substrate.map.yaml    ← the map (in the agent's own directory)
  ...                   ← your other substrate files
```

Keep the map in the agent's own substrate directory, or place a copy at `rooms/<name>/substrate.map.yaml` as a deployment override.

For example: `~/substrate/myagent/substrate.map.yaml`.

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Forgot `required_scopes` | Must include `identity_core` + `current_state` |
| Missing scope definition | Every scope in `required_scopes` must have an entry in `scopes` |
| Paths not resolving | Paths are relative to `root`; check `root` is correct and paths exist |
| `trust` not in enum | Must be `low`, `medium`, or `high` |
| `weight` out of range | Must be `0.0` to `1.0` |
| No sources | Every scope needs at least one source |
| `evidence_required: true` without frontmatter | Either add frontmatter/sidecar or set to `false` |
| Mapping scopes you don't have | Skip them — missing is better than wrong |

## Review Checklist

Before submitting your map:

- [ ] `identity_core` and `current_state` are in `required_scopes` AND defined in `scopes`
- [ ] Every scope has at least one source
- [ ] All paths are relative to `root` and resolve to existing files
- [ ] `trust` and `weight` values are valid
- [ ] File placed at `{your_substrate_root}/substrate.map.yaml`
- [ ] `bun test __tests__/substrate/` passes
