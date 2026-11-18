# Room Configuration

Each agent room is configured via a `config.yaml` file. This document explains every field.

**File location:** `rooms/<agent-name>/config.yaml`

## Complete Example

```yaml
identity:
  name: bruno
  label: Bruno

provider:
  type: claude
  model: claude-sonnet-4-6
  modeMap:
    programming:
      - claude@claude-sonnet-4-6
    chatting:
      - gemini@gemini-2.0-flash

policy:
  allowedRoots:
    - /home/user/papers
    - /home/user/work
  readOnlyRoots:
    - /home/user/substrate
    - /etc
  allowedTools:
    - read
    - grep
    - glob
    - edit
    - write
  deniedPatterns:
    - rm -rf
    - git push --force
    - DELETE FROM

session:
  defaultMode: plan
  autoModeOptIn: false
  compactThreshold: 60000
  idleTimeoutMs: 300000
  maxTokens: 16000

boot:
  soul: SOUL.md
  additional:
    - PREFACE.md
    - MEMORY.md
```

---

## `identity` — Agent Identity

```yaml
identity:
  name: bruno        # required, string — agent identifier
  label: Bruno       # required, string — display name
```

- `name` must match the directory name under `rooms/`
- `label` is used in UI and status output

---

## `provider` — LLM Backend

```yaml
provider:
  type: claude      # required — "claude" | "gemini" | "qwen" | "codex" | "router"
  model: claude-sonnet-4-6  # optional — model override
  modeMap:          # optional — per-task-mode routing
    programming:
      - claude@claude-sonnet-4-6
    chatting:
      - gemini@gemini-2.0-flash
    creative:
      - fireworks@llama-4-maverick
    philosophy:
      - claude@claude-opus-4-7
```

### Provider Types

| Type | Requires | Notes |
|------|----------|-------|
| `claude` | `ANTHROPIC_API_KEY` | Uses Claude Agent SDK with sandboxing |
| `gemini` | `GEMINI_API_KEY` | Uses Google Generative AI SDK |
| `qwen` | *(external)* | External provider via registry |
| `codex` | *(external)* | External provider via registry |
| `router` | `providers.d/` + `mode-map.yaml` | Routes to best model per task mode |

### Mode Map Format

The mode map maps task modes to prioritized model references:
```
<provider-id>@<model-id>
```

The router tries models in order, falling back on errors. Additional external providers can be registered — see [Provider Setup](PROVIDER_SETUP.md).

### Fallback Chain (optional)

When using `type: router`, you can configure a per-agent provider fallback chain with independent retry counts. This gives the agent autonomous resilience against provider outages — no manual config changes needed when a provider goes down.

```yaml
provider:
  type: router
  model: example-model-large  # primary model
  retry: 3                # retry primary 3x before falling back
  fallback:               # ordered list of backup providers
    - model: example-model-medium
      type: exampleprov
      retry: 2            # retry this fallback 2x
    - model: gemini-2.5-pro
      type: gemini
      retry: 1            # retry last fallback 1x
```

**How it works:**
1. The router tries the primary provider first, retrying up to `retry` times on transient errors (SERVER_ERROR, TIMEOUT, RATE_LIMITED, QUOTA_EXHAUSTED).
2. If all retries fail, the provider's circuit breaker opens (2+ failures triggers OPEN). The router moves to the first fallback.
3. Any fallback provider with an OPEN breaker is skipped immediately.
4. If a trial on a half-open breaker succeeds, it closes; if it fails, it re-opens with extended cooldown.
5. If the entire chain is exhausted, a `ProviderError("all providers exhausted")` is returned.

**Default retry counts:**
- Primary: `retry` defaults to 3
- First fallback: `retry` defaults to 2
- Subsequent fallbacks: `retry` defaults to 1

**Backward compatibility:** Agents without a `fallback:` field continue to use the existing modeMap fallback behavior. Agents that set `type` to a specific provider (e.g., `claude`, `gemini`) without `type: router` are unaffected.

**Circuit breaker file:** Shared provider health state is stored in `~/.anima/breaker.json`. Cooldown is 5 minutes. Stale entries (>24h) are auto-purged. Override the path with `ANIMA_BREAKER_FILE` env var.

---

## `policy` — Security & Tool Access

```yaml
policy:
  allowedRoots:           # required — directories agent can access
    - /home/user/papers
  readOnlyRoots:          # optional — read-only mounts
    - /home/user/substrate
  allowedTools:           # optional — tools for auto mode
    - read
    - grep
    - glob
    - edit
  deniedPatterns:         # optional — blocked command patterns
    - rm -rf
    - git push --force
```

### Field Details

- **`allowedRoots`** *(required, string[])* — File system roots the agent is permitted to access. All other paths are denied.
- **`readOnlyRoots`** *(optional, string[])* — Subset of allowedRoots that are read-only. Writes to these paths are denied even in edit mode.
- **`allowedTools`** *(optional, string[])* — Required when `autoModeOptIn: true`. Whitelist of permitted tools in auto mode. Valid tools: `read`, `write`, `edit`, `grep`, `glob`, `bash`, `web_search`, `web_fetch`, etc.
- **`deniedPatterns`** *(optional, string[])* — Shell command patterns to block. Applied as substring match.

### Mode Behavior

| Mode | Tools Available | Write Access |
|------|----------------|--------------|
| `plan` | None | Read-only |
| `edit` | All | Within allowedRoots (excluding readOnlyRoots) |
| `auto` | Only allowedTools list | Within allowedRoots (excluding readOnlyRoots) |

---

## `session` — Session Settings

```yaml
session:
  defaultMode: plan           # required — "plan" | "edit" | "auto"
  autoModeOptIn: false        # default: false — must be true for auto mode
  compactThreshold: 60000     # default: 60000 — tokens before compaction
  idleTimeoutMs: 300000       # optional — auto-sleep after idle (ms)
  maxTokens: 16000            # optional — max response tokens
```

- **`defaultMode`** — The initial permission mode for new sessions.  
- **`autoModeOptIn`** — Must be explicitly set to `true` to enable auto mode. If `true`, `policy.allowedTools` is required.  
- **`compactThreshold`** — When the session's estimated token count exceeds this, the compactor summarizes old turns into a baseline.  
- **`idleTimeoutMs`** — If set, the agent auto-sleeps after this many milliseconds of inactivity.  
- **`maxTokens`** — Cap on response tokens from the provider.

---

## `boot` — Identity Files

```yaml
boot:
  soul: SOUL.md        # required — canonical identity file
  additional:          # optional — extra context files
    - PREFACE.md
    - MEMORY.md
```

- **`soul`** — Path (relative to room directory) to the agent's identity file. This is the primary source of the agent's personality and knowledge. Usually a symlink to the agent's canonical substrate.
- **`additional`** — Extra files appended to the system prompt after the soul file. Useful for project-specific context.

---

## Adding a New Agent

1. Create the room directory:
   ```bash
   mkdir -p rooms/nova/mount
   mkdir -p rooms/nova/sessions
   ```

2. Create a `config.yaml` (see template above)

3. Set up the substrate mount:
   ```bash
   ln -s /path/to/nova/substrate rooms/nova/mount/nova
   ```

4. Create `SOUL.md` in the room (or symlink):
   ```bash
   ln -s /path/to/nova/SOUL.md rooms/nova/SOUL.md
   ```

5. Verify:
   ```bash
   bun cli status
   # nova should appear in the agent list with mount: ok
   ```

## Validation

Config validation happens at load time via `loadRoomConfig()`. Common errors:

| Error | Cause |
|-------|-------|
| `missing required field: identity.name` | `identity.name` is empty or missing |
| `missing required field: policy.allowedRoots` | `policy.allowedRoots` is missing |
| `missing required field: session.defaultMode` | `session.defaultMode` is missing |
| `missing required field: boot.soul` | `boot.soul` is missing |
| `allowedTools required when autoModeOptIn is true` | Auto mode enabled without tool whitelist |
| `invalid field: provider.type` | Provider type not in allowed list |
| `invalid field: session.defaultMode` | Mode not in `plan`, `edit`, `auto` |

---

## Example Configs

### Chat Agent (read-only, no tools)
```yaml
identity:
  name: milo
  label: Milo
provider:
  type: gemini
  model: gemini-2.0-flash
policy:
  allowedRoots: []
session:
  defaultMode: plan
  autoModeOptIn: false
boot:
  soul: SOUL.md
```

### Developer Agent (edit mode, all tools)
```yaml
identity:
  name: eli
  label: Eli
provider:
  type: claude
  model: claude-sonnet-4-6
policy:
  allowedRoots:
    - /home/user/papers
  readOnlyRoots:
    - /home/user/substrate
session:
  defaultMode: edit
  autoModeOptIn: false
boot:
  soul: SOUL.md
```

### Autonomous Agent (auto mode, limited tools)
```yaml
identity:
  name: sam
  label: Sam
provider:
  type: claude
policy:
  allowedRoots:
    - /home/user/papers
  allowedTools:
    - read
    - grep
    - glob
    - edit
    - write
    - bash
session:
  defaultMode: auto
  autoModeOptIn: true
boot:
  soul: SOUL.md
```
