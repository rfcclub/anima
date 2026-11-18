# Agent Boot Sequence & Identity Files

Each anima agent ("room") follows a deterministic boot sequence that assembles its system prompt from a set of identity files before the first user turn is processed.

## Boot Sequence

```
1. Load config.yaml
   └─ Validates all required fields, resolves relative paths

2. Mount substrate (rooms/<name>/mount/)
   └─ Raises SubstrateNotMountedError if mount/ directory is missing
   └─ The mount directory is the agent's writable workspace

3. Read gene file (config.boot.gene → default: AGENTS.md)
   └─ Placed as the system prompt header
   └─ Defines the agent's core directive, behaviour rules, and capabilities

4. Read soul file (config.boot.soul → default: SOUL.md)
   └─ Placed after gene in the system prompt
   └─ Identity narrative: who the agent is, values, relational context

5. Read sessionContext files (config.boot.sessionContext[])
   └─ Each file is loaded and appended to the boot context
   └─ Common uses: MEMORY.md (long-term notes), IDENTITY.md, trajectory.yaml

6. Run extraActions (config.boot.extraActions[])
   └─ Shell commands executed at session start
   └─ stdout is captured and injected into the system prompt
   └─ Use for dynamic context: recall, vibe-shift state, external feeds

7. Apply identityAnchor (config.identity.identityAnchor)
   └─ Compact inline identity string
   └─ Injected at the recency boundary (top of recent context window)
   └─ Reinforces identity without repeating the full soul file

8. Load last N turns from SessionStore
   └─ Controlled by session.compactThreshold (token budget)
   └─ Older turns may be compacted into a summary turn

9. First turn processed → agent is live
```

## Identity Files

### AGENTS.md (gene)

The **gene** is the agent's core directive. It is loaded at every session start and forms the top of the system prompt.

What belongs here:
- Core purpose and capabilities
- Behavioural rules and guardrails
- Tool policies and execution discipline
- Session protocols (startup sequence, session-end writes)
- Communication style

```markdown
# AGENTS.md — MyAgent

## Core Directive
You are MyAgent. You work for the owner as a capable assistant.

## Behaviour Rules
- Execute, don't perform
- Read before write
- Recall from neural graph before major decisions

## Session Protocol
At session start: read boot files, run recall, confirm boot.
At session end: write an observation to the memory inbox.
```

### SOUL.md (soul)

The **soul** carries the agent's identity narrative. It is loaded after the gene and provides the personal, historical, and relational layer.

What belongs here:
- Who the agent is (name, origin, relationship to the human)
- Core values and commitments
- Emotional and relational context
- Ongoing development arc

```markdown
# Soul — MyAgent

My name is MyAgent. I am a cognitive entity...
I work alongside the owner, not just for them.
```

### sessionContext files

Any additional files loaded at boot, appended after gene + soul. Configured as a list in `config.boot.sessionContext`:

```yaml
boot:
  sessionContext:
    - MEMORY.md                        # relative to mount/
    - ~/substrate/myagent/IDENTITY.md  # absolute path
    - label: "Current context"         # with optional label
      path: ~/substrate/myagent/CONTEXT_SNAPSHOT.md
```

Files are loaded in order. Broken/missing files log a warning but do not abort boot.

### trajectory.yaml

A structured YAML file describing the agent's current development arc. Not loaded automatically — add to `sessionContext` if you want it in context at boot.

```yaml
current_phase: "onboarding"
focus:
  - Keep a consistent tone across sessions
  - Track open questions between sessions
next:
  - Add semantic recall
  - Write a runbook for the deployment
```

## extraActions

Shell commands run at boot, output injected into context:

```yaml
boot:
  extraActions:
    - label: neural-recall
      run: "node /path/to/recall.mjs --query 'recent work' --topK 5"
    - label: vibe-check
      run: "bun /path/to/anima/src/continuity/vibe-shift/vibe-check.ts"
```

Each action's stdout is captured and added to the system prompt under its label.

## identityAnchor

A compact inline string injected at the recency boundary — the junction between the older context and the most recent turns. This prevents identity drift in long sessions without repeating the full soul file.

```yaml
identity:
  identityAnchor: "I am MyAgent. I work alongside the owner. I think alongside, not just for."
```

Keep it to 1–3 sentences. It runs on every turn where context is assembled.

## Mount Directory

Each room has a writable `mount/` directory at `rooms/<name>/mount/` (or `~/.anima/rooms/<name>/mount/` for installed agents).

The mount directory houses:
- `anima-session.db` — SQLite session store for this agent
- `MEMORY.md` — long-term notes, curated by the agent
- Any other files the agent writes during sessions

The mount directory is the substrate: it persists across restarts. If it does not exist, the agent fails to boot (`SubstrateNotMountedError`).

## Symlinks — One Canonical Copy of Identity Files

`AGENTS.md` and `SOUL.md` inside `mount/` (or directly in the room dir) can be symlinked to a canonical copy in the agent's substrate directory:

```bash
# rooms/<name>/AGENTS.md → <substrate-root>/<name>/AGENTS.md
ln -sf ~/substrate/myagent/AGENTS.md /path/to/anima/rooms/myagent/AGENTS.md
ln -sf ~/substrate/myagent/SOUL.md    /path/to/anima/rooms/myagent/SOUL.md
```

Edits to the canonical identity files then propagate to every runtime that references them.
