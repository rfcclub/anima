# ANIMA Interfaces

Key contracts and data schemas used across the system.

## Provider Interface

**File:** `src/providers/interface.ts`

All LLM providers implement this interface:

```ts
interface Provider {
  readonly name: ProviderName;  // "claude" | "gemini" | "qwen" | "codex" | "router" | custom

  query(req: ProviderRequest): AsyncGenerator<ProviderChunk> | Promise<ProviderResponse>;
}

interface ProviderRequest {
  messages: ProviderMessage[];     // conversation history
  tools?: ProviderToolDefinition[]; // available tools
  system?: string;                  // system prompt
  agent: string;                    // agent name for logging
  mode: PermissionMode;             // plan | edit | auto
  cwd?: string;                     // working directory
  model?: string;                   // model override
  canUseTool?: ProviderPermissionHandler;  // tool gate callback
  signal?: AbortSignal;             // cancellation
}

interface ProviderResponse {
  message: ProviderMessage;
  tool_calls?: ProviderToolCall[];
  usage?: { input_tokens: number; output_tokens: number };
}
```

### Error Codes

| Code | Meaning | Retryable |
|------|---------|-----------|
| `AUTH_ERROR` | Invalid API key or credentials | No |
| `QUOTA_EXHAUSTED` | Billing/credit exhausted | Yes |
| `RATE_LIMITED` | Too many requests | Yes |
| `TIMEOUT` | Request timed out | Yes |
| `SERVER_ERROR` | Provider-side failure | Yes |

Provider errors use the `ProviderError` class with `.code`, `.provider`, and `.retryable` properties.

## A2A Message Format

**File:** `src/meeting/types.ts`

Agent-to-agent messages are Markdown files with YAML frontmatter:

```markdown
---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: architecture-review
turn: 3
---

# Thoughts on the provider router

I think we should add a fallback timeout of 30s...
```

**Schema:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `from` | string | Yes | Sender agent name |
| `to` | string | Yes | Recipient ("all" for broadcast) |
| `timestamp` | string | Yes | ISO 8601, js-yaml Date objects auto-converted |
| `topic` | string | Yes | Subdirectory name in meeting room |
| `turn` | integer | Yes | Monotonically increasing per topic |
| `body` | string | — | Everything after YAML frontmatter |

Parse with `parseA2AMessage(markdown: string): A2AMessage`. Throws `A2AParseError` on invalid input.

## Room Config Schema

**File:** `src/config/types.ts`

```ts
interface RoomConfig {
  identity: {
    name: string;          // agent name (directory name)
    label: string;         // display label
  };
  provider: {
    type: ProviderType;    // "claude" | "gemini" | "qwen" | "codex" | "router"
    model?: string;        // model override
    modeMap?: Partial<ModeMap>;  // per-task-mode model routing
  };
  policy: {
    allowedRoots: string[];       // directories agent can access
    readOnlyRoots?: string[];     // read-only mounts
    allowedTools?: string[];      // tools permitted in auto mode
    deniedPatterns?: string[];    // forbidden command patterns
  };
  session: {
    defaultMode: PermissionMode;  // "plan" | "edit" | "auto"
    autoModeOptIn: boolean;       // must be true for auto mode
    compactThreshold: number;     // token threshold for compaction (default: 60000)
    idleTimeoutMs?: number;       // auto-sleep timeout
    maxTokens?: number;           // response token cap
    resetAfterDream?: boolean;    // reset idle sessions after the nightly consolidation (default true)
    resetIdleMs?: number;         // idle threshold for that reset (default 30 minutes)
  };
  boot: {
    soul: string;                 // canonical identity file (e.g., "SOUL.md")
    additional?: string[];        // extra boot files
  };
}
```

Validation via `loadRoomConfig(yamlText: string): RoomConfig`. Throws `ConfigValidationError` on missing/invalid fields.

## JSONL Event Schema

**File:** `src/memory/jsonl-store.ts`

Each line in a session file is a JSON object:

```ts
interface JsonlEvent {
  timestamp: string;     // ISO 8601
  type: string;          // event type: "message", "turn", "tool_blocked", "recovery", etc.
  sessionId: string;     // UUID for the session
  // ... type-specific fields
}
```

Files are stored as `rooms/<agent>/sessions/<YYYY-MM-DD>.jsonl`. The JSONL store provides:
- `append(agent, event)` — append an event to today's file
- `readDate(agent, date)` — read all events for a date
- `recover(agent, date)` — repair a corrupted file (truncates bad last line, logs recovery event)
- `compact(agent, date, sessionId)` — compact a session into a summary baseline

## Provider Registry

**File:** `src/providers/registry.ts`

Optional external provider configuration via `providers.d/*.yaml`:

```yaml
id: fireworks
label: Fireworks AI
baseUrl: https://api.fireworks.ai/inference/v1
api: openai-completions
apiKey: ${FIREWORKS_API_KEY}
models:
  - id: llama-4-maverick
    label: Llama 4 Maverick
```

Provider IDs can be referenced in room config's `modeMap` as `<provider>@<model>`, e.g., `fireworks@llama-4-maverick`.

## Session Manager

**File:** `src/session/manager.ts`

Manages per-agent session lifecycle: creating new sessions, loading context, compacting old sessions, and maintaining wake/sleep state.
