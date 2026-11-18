# CLI Reference

ANIMA CLI provides one-shot access to all agent operations. No server required.

```
bun cli <command> [args...] [flags]
```

## Commands

### `status` — List All Agents

Show every configured agent and its current status.

```bash
bun cli status
```

**Output:**
```json
{
  "agents": [
    {
      "name": "bruno",
      "label": "Bruno",
      "provider": "claude",
      "mount": "ok",
      "lastSession": "2026-05-17T14:30:00.000Z"
    },
    {
      "name": "eli",
      "label": "Eli",
      "provider": "gemini",
      "mount": "ok",
      "lastSession": null
    }
  ]
}
```

**Fields:**
- `name` — agent identifier (directory name under `rooms/`)
- `label` — display name from config
- `provider` — configured provider type
- `mount` — `"ok"` if substrate mount exists, `"fail"` if broken symlink or missing
- `lastSession` — timestamp of most recent session file, or `null`

---

### `talk` — Send a Message to an Agent

Send a one-shot message and get a response.

```bash
bun cli talk <agent> <message> [flags]
```

**Examples:**

```bash
# Simple chat
bun cli talk bruno "What is the current architecture of the LLM proxy?"

# With a specific mode (also changes permission)
bun cli talk eli "Review this code" --mode programming

# Override permission mode
bun cli talk sam "Refactor the router" --permission edit

# Use a different provider
bun cli talk milo "Hello" --provider gemini
```

**Flags:**

| Flag | Values | Description |
|------|--------|-------------|
| `--mode <mode>` | `chatting`, `programming`, `image`, `private`, `philosophy`, `creative` | Task mode for model routing |
| `--permission <mode>` | `plan`, `edit`, `auto` | Override permission mode |
| `--provider <name>` | `claude`, `gemini`, `router` | Override provider |

**What happens under the hood:**
1. Agent room is loaded (config.yaml + substrate mount)
2. Mail is checked for unread meeting messages
3. System prompt is built from SOUL.md + boot files
4. Provider resolves based on config or `--provider` flag
5. Query is sent to LLM
6. Response is written to session JSONL
7. If token threshold exceeded, session is compacted

---

### `meet` — Host an Agent Meeting

Run a round-robin discussion between two or more agents.

```bash
bun cli meet <agent1> <agent2> [agent3...] --topic <topic> [flags]
```

**Examples:**

```bash
# Two-agent discussion
bun cli meet bruno eli --topic architecture-review

# Multi-agent with custom turns
bun cli meet bruno eli milo sam --topic project-planning --turns 5

# Resume yesterday's meeting
bun cli meet bruno eli --topic daily-standup --resume

# Add a directive to every turn
bun cli meet bruno eli --topic code-review --inject "Focus on security vulnerabilities"

# Use specific provider for all agents
bun cli meet bruno eli --topic design --provider claude
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--topic <name>` | *(required)* | Meeting topic (also used as directory name) |
| `--turns <n>` | `3` | Number of round-robin turns per agent |
| `--resume` | `false` | Resume existing transcript instead of starting fresh |
| `--inject <text>` | — | Directive appended to every agent's prompt each turn |
| `--provider <name>` | — | Override provider for all agents |

**Meeting flow:**
1. Agents are loaded from their rooms
2. Transcript header is written to `rooms/_meeting/<topic>/<date>.md`
3. For each round, each agent sees the full transcript + their system prompt
4. Each agent's response is appended to the transcript immediately (crash-safe)
5. Final transcript is written and displayed

---

### `mode` — Manage Task Mode

Get or set the current task mode (persisted globally for the CLI session).

```bash
# Get current mode
bun cli mode
# Output: Current mode: chatting

# Set mode
bun cli mode programming
# Output: Current mode: programming
```

**Valid modes:** `chatting`, `programming`, `image`, `private`, `philosophy`, `creative`

The task mode affects which model is used when the provider is `router`.

---

### `check-mail` — Check Unread Messages

Check for unread A2A messages from meetings.

```bash
# Check mail for all agents
bun cli check-mail

# Check mail for a specific agent
bun cli check-mail bruno
```

**What it does:**
1. Scans `rooms/_meeting/<topic>/` for A2A messages
2. Finds messages addressed to the agent (or broadcast `all`)
3. Messages newer than the agent's last session are "unread"
4. Displays unread messages grouped by agent
5. Marks messages as read (updates checkpoint)

**Circuit breaker:** If an agent has more than 50 unread messages, mail injection is skipped to avoid flooding the agent's context.

---

### `session` — Session Management

View session status for an agent.

```bash
bun cli session status <agent>
```

**Output:**
```json
{
  "agent": "bruno",
  "sessionId": "abc123-...",
  "todayTurnCount": 5,
  "estimatedTokens": 15000,
  "hasBaseline": false
}
```

---

### `seed` — Seed a New Agent Room

Create a new room with a seed script.

```bash
bun cli seed <agent-name> --boot SOUL.md
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Usage error or agent error |
| `2` | Provider error (network, auth, quota) |
