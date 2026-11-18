# Provider Setup

ANIMA supports multiple LLM providers. This guide covers setup for each.

---

## Claude (Anthropic)

Uses the `@anthropic-ai/claude-agent-sdk` for full agent capabilities including sandboxed tool execution.

### Setup

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

Get your key from [Anthropic Console](https://console.anthropic.com/).

### Configuration

```yaml
provider:
  type: claude
  model: claude-sonnet-4-6    # optional — default is the SDK default
```

### Available Models

Any model supported by the Claude Agent SDK. Common options:
- `claude-sonnet-4-6` — best balance of speed/capability
- `claude-opus-4-7` — most capable
- `claude-haiku-4-5` — fastest, cheapest

### Sandboxing

The Claude provider automatically enables filesystem sandboxing:
- Writes to the agent's `mount/` directory are denied (substrate is read-only)
- All other file access is governed by `policy.allowedRoots` and permission mode

### Error Handling

| Error Message | Error Code | Retry |
|---------------|-----------|-------|
| Invalid API key / 401 | `AUTH_ERROR` | No |
| Rate limit / 429 | `RATE_LIMITED` | Yes |
| Credit exhausted / billing | `QUOTA_EXHAUSTED` | Yes |
| Timeout | `TIMEOUT` | Yes |
| Other server errors | `SERVER_ERROR` | Yes |

---

## Gemini (Google)

Uses the `@google/generative-ai` SDK.

### Setup

```bash
export GEMINI_API_KEY="..."
```

Get your key from [Google AI Studio](https://aistudio.google.com/apikey).

### Configuration

```yaml
provider:
  type: gemini
  model: gemini-2.0-flash    # optional — default
```

### Available Models

- `gemini-2.0-flash` — fast, good for most tasks
- `gemini-2.5-pro` — most capable Gemini
- `gemini-2.5-flash` — fast capable
- `gemini-3.1-flash-lite-preview` — cheapest, used as router fallback

### How It Works

1. System prompt is passed as `systemInstruction`
2. Conversation history is converted to Gemini `Content[]` format
3. Last user message is sent separately via `chat.sendMessage()`
4. Usage metadata (`promptTokenCount`, `candidatesTokenCount`) is captured

### Error Mapping

| Gemini Error | ANIMA Code |
|-------------|------------|
| API_KEY_INVALID / 401 / 403 | `AUTH_ERROR` |
| RESOURCE_EXHAUSTED / quota | `QUOTA_EXHAUSTED` |
| DEADLINE_EXCEEDED / timeout | `TIMEOUT` |
| UNAVAILABLE / 503 | `SERVER_ERROR` |

---

## OpenAI-Compatible Provider

Any API with OpenAI-compatible endpoints (Fireworks, Together, Groq, Ollama, vLLM, etc.)

### Setup — Provider Registry

External providers are registered via YAML files in `~/.anima/providers.d/`. Each file defines one provider.

**File:** `~/.anima/providers.d/fireworks.yaml`
```yaml
id: fireworks
label: Fireworks AI
baseUrl: https://api.fireworks.ai/inference/v1
api: openai-completions
apiKey: ${FIREWORKS_API_KEY}
models:
  - id: llama-4-maverick
    label: Llama 4 Maverick
  - id: mixtral-8x22b
    label: Mixtral 8x22B
```

**File:** `~/.anima/providers.d/ollama.yaml`
```yaml
id: ollama
label: Ollama Local
baseUrl: http://localhost:11434/v1
api: openai-completions
apiKey: ollama    # Ollama doesn't require a real key
models:
  - id: llama3
    label: Llama 3 (Local)
  - id: codellama
    label: Code Llama (Local)
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Provider identifier (used in `modeMap`) |
| `label` | Yes | Display name |
| `baseUrl` | Yes | API base URL |
| `api` | Yes | `openai-completions`, `openai-responses`, `anthropic-messages`, or `generic` |
| `apiKey` | Yes | API key (supports `${ENV_VAR}` syntax) |
| `models` | Yes | List of available models |
| `endpoint` | No | Custom endpoint path override |
| `headers` | No | Extra HTTP headers |
| `extraParams` | No | Extra query/body params |

### API Types

- **`openai-completions`** — Standard `/v1/chat/completions` endpoint
- **`openai-responses`** — OpenAI Responses API
- **`anthropic-messages`** — Anthropic Messages API format
- **`generic`** — Provider-specific handling

### Environment Variable Substitution

The `apiKey` field supports `${ENV_VAR}` syntax:
```yaml
apiKey: ${FIREWORKS_API_KEY}
```

The `${ENV_VAR}` will be replaced with the actual environment variable value at runtime.

---

## Mode Router

The router (`type: router`) selects the best model for each task mode, with fallback chains.

### Setup

1. Create a global mode map at `~/.anima/mode-map.yaml`:
   ```yaml
   chatting:
     - claude@claude-sonnet-4-6
     - gemini@gemini-2.0-flash
   programming:
     - claude@claude-sonnet-4-6
     - fireworks@llama-4-maverick
   image:
     - gemini@gemini-2.5-pro
   private:
     - claude@claude-opus-4-7
   philosophy:
     - claude@claude-opus-4-7
     - gemini@gemini-2.5-pro
   creative:
     - claude@claude-sonnet-4-6
     - gemini@gemini-2.0-flash
   ```

2. Set up providers in `~/.anima/providers.d/` for any non-built-in provider IDs.

3. Configure the agent to use the router:
   ```yaml
   provider:
     type: router
     modeMap:            # optional — per-agent overrides
       programming:
         - claude@claude-opus-4-7
   ```

### How Routing Works

1. Determine the task mode (from `--mode` flag, or current CLI mode, or default `chatting`)
2. Look up the model list for that mode (agent override → global map)
3. Try each model in order until one succeeds
4. On failure with a retryable error (`RATE_LIMITED`, `QUOTA_EXHAUSTED`, `SERVER_ERROR`, `TIMEOUT`), try the next model
5. On `AUTH_ERROR`, skip to next model immediately

### Built-in Fallback

When no external providers are available, the router defaults to:
- Gemini 2.0 Flash for everything

---

## Debugging Provider Issues

### Check API key
```bash
# Verify key is set
echo $ANTHROPIC_API_KEY
echo $GEMINI_API_KEY
```

### Enable verbose logging
The server and CLI log provider errors in JSON format:
```json
{
  "level": "error",
  "ts": "2026-05-17T12:00:00.000Z",
  "msg": "claude query failed",
  "agent": "bruno",
  "mode": "plan",
  "code": "AUTH_ERROR",
  "retryable": false,
  "durationMs": 234
}
```

### Test a provider directly
```bash
# Test Claude
bun cli talk bruno "hello" --provider claude

# Test Gemini
bun cli talk bruno "hello" --provider gemini

# Test with different task mode
bun cli talk bruno "hello" --mode programming
```

### Common Issues

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| `AUTH_ERROR` | Invalid/missing API key | Check env vars, regenerate key |
| `QUOTA_EXHAUSTED` | Billing limit reached | Check billing dashboard |
| `RATE_LIMITED` | Too many requests | Add delay between requests |
| `TIMEOUT` | Network or provider slow | Check connectivity, increase timeout |
| `SERVER_ERROR` | Provider outage | Wait and retry, or use fallback |
