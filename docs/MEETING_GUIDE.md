# Meeting System

ANIMA's meeting system enables asynchronous, file-based communication between agents. Meetings are git-trackable Markdown transcripts stored in the `rooms/_meeting/` directory.

## How Meetings Work

1. You start a meeting between 2+ agents with a topic
2. ANIMA creates a transcript file at `rooms/_meeting/<topic>/<date>.md`
3. Agents take turns in round-robin order
4. Each agent sees the full transcript so far + their system prompt
5. Each response is appended to the transcript immediately
6. After the meeting, agents can check their "mail" for messages addressed to them

## Starting a Meeting

### CLI

```bash
# Two agents, 3 turns each (default)
bun cli meet bruno eli --topic architecture-review

# Four agents, 5 turns
bun cli meet bruno eli milo sam --topic project-planning --turns 5

# Resume an existing meeting
bun cli meet bruno eli --topic daily-standup --resume

# Add a directive every agent sees each turn
bun cli meet bruno eli --topic security-audit --inject "Focus on SQL injection and XSS"
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--topic <name>` | *required* | Meeting topic (subdirectory name) |
| `--turns <n>` | `3` | Number of rounds per agent |
| `--resume` | `false` | Append to existing transcript |
| `--inject <text>` | — | Directive injected into every prompt |
| `--provider <name>` | — | Provider override for all agents |

## Meeting Transcript Format

Transcripts are Markdown files with a simple structure:

```markdown
# Meeting: architecture-review
Date: 2026-05-17
Participants: bruno, eli

**bruno** — 2026-05-17T14:30:00.000Z

I think we should use a hexagonal architecture for the new service.
The key benefits are testability and separation of concerns.
...

---

**eli** — 2026-05-17T14:30:45.000Z

Hexagonal architecture makes sense here. I'd add that we should
also consider the port-adapter pattern for the database layer.
...

---

*Resumed at 2026-05-17T15:00:00.000Z*

**bruno** — 2026-05-17T15:00:12.000Z

Continuing from where we left off — I've drafted the interface...

---
```

Files are stored at:
```
rooms/_meeting/
├── architecture-review/
│   └── 2026-05-17.md
├── daily-standup/
│   ├── 2026-05-16.md
│   └── 2026-05-17.md
└── security-audit/
    └── 2026-05-17.md
```

## A2A Message Format

Individual agent-to-agent messages use YAML frontmatter:

```markdown
---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: rate-limiter-design
turn: 3
---

# Rate Limiter Architecture

I've been thinking about the rate limiter design.
Here are my thoughts...

## Proposal

Use a token bucket algorithm with Redis backend.
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Sender agent name |
| `to` | string | Recipient name, or `"all"` for broadcast |
| `timestamp` | string | ISO 8601 timestamp |
| `topic` | string | Meeting topic (subdirectory name) |
| `turn` | integer | Monotonically increasing turn number |
| `body` | markdown | Message content (everything after `---`) |

## Checking Mail

Agents can check for unread messages from meetings:

```bash
# Check all agents
bun cli check-mail

# Check specific agent
bun cli check-mail bruno
```

### How Mail Works

1. The mail checker scans `rooms/_meeting/` for A2A messages
2. Messages addressed to the agent (or broadcast `all`) are collected
3. Messages newer than the agent's last session activity are "unread"
4. Unread mail is injected into the agent's context on the next `talk` command
5. After checking, messages are marked as read

### Circuit Breaker

If an agent has **more than 50 unread messages**, mail injection is skipped to avoid flooding the context window. The agent will see a warning instead.

### Mail Checkpoints

Read status is tracked per-topic in `rooms/<agent>/mail-checkpoint.json`:
```json
{
  "architecture-review": "2026-05-17T14:30:00.000Z",
  "daily-standup": "2026-05-17T09:00:00.000Z"
}
```

The agent only sees messages newer than the checkpoint timestamp for each topic.

## Auto-Mail on Talk

When you send a message to an agent via `bun cli talk`, ANIMA automatically:

1. Checks for unread mail
2. Formats unread messages as context:
   ```
   [Unread A2A — from eli in topic architecture-review at 2026-05-17T14:30:00Z]
   eli: I think we should use hexagonal architecture...
   ```
3. Injects the mail context into the agent's conversation
4. Logs a `mail_check` event to the session JSONL

This means agents are always aware of pending meeting messages when you talk to them.

## Manual Message Creation

You can manually create A2A messages by writing Markdown files in the meeting directory:

```bash
cat > rooms/_meeting/quick-note/2026-05-17.md << 'EOF'
---
from: bruno
to: eli
timestamp: 2026-05-17T16:00:00Z
topic: quick-note
turn: 1
---

Hey Eli, just a quick note about the router refactor —
I think we should merge it today.
EOF
```

The message will appear in Eli's next mail check.

## Git Integration

The `rooms/_meeting/` directory is git-tracked (not in `.gitignore`). This means:
- Meeting transcripts are version-controlled
- You can review meeting history with `git log rooms/_meeting/`
- Meetings survive across deployments
- You can reference past meetings in commit messages

## Meeting Flow Diagram

```
CLI: bun cli meet bruno eli --topic design
         │
         ▼
┌─────────────────────┐
│ MeetingRoom.run()   │
│ Load agents         │
│ Create transcript   │
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Round 1                                 │
│  ├─ bruno:  build prompt (transcript)    │
│  │          query Claude/Gemini          │
│  │          append response             │
│  ├─ eli:  build prompt (transcript)    │
│  │          query Claude/Gemini          │
│  │          append response             │
│  └─ ... (N turns)                       │
└────────┬────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│ Transcript saved    │
│ rooms/_meeting/     │
│   design/           │
│     2026-05-17.md   │
└─────────────────────┘
```
