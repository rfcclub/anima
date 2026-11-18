# Providers

A provider is an LLM backend. ANIMA has a few built-in provider types and a registry of OpenAI- and Anthropic-compatible endpoints defined in YAML files.

## Choosing a provider for an agent

`provider.type` in the room's `config.yaml` picks one of:

| `provider.type` | What it is |
|-----------------|-----------|
| A provider id from `providers.d/` | An HTTP endpoint from the [registry](#the-provider-registry) |
| `claude` | Built-in Claude provider. The CLI uses `AnthropicProvider` (`src/providers/anthropic.ts`, Claude Agent SDK). The server uses `ClaudeProvider`, a deprecated alias of `AnthropicProvider` |
| `gemini` | Built-in `GeminiProvider` (`src/providers/gemini.ts`). Server only, and only when no registry entry is called `gemini` |
| `router` | CLI only: picks a model by task mode. See [Provider Router](./router.md) |

`provider.model` is the model id within that provider.

## The provider registry

`ProviderRegistry.load(dir)` (`src/providers/registry.ts`) reads every `*.yaml` file in a `providers.d/` directory. Each file defines one provider:

```yaml
id: exampleprov                         # required, what provider.type refers to
label: "Example Provider"           # required
api: openai-completions             # required, see below
baseUrl: https://provider.example/v1         # required
apiKey: ${EXAMPLEPROV_API_KEY}      # required
models:                             # required, at least the ids you use
  - id: deepseek-v4-flash
  - id: glm-5.1
    label: GLM 5.1                  # optional
    extraParams: { temperature: 0.7 }   # optional, per model
endpoint: /chat/completions         # optional
headers: { X-Title: anima }         # optional
extraParams: { max_tokens: 4096 }   # optional, every request
sharedSafe: false                   # optional, default false
```

### `api`

| Value | Handled by |
|-------|-----------|
| `openai-completions` | `OpenAIv1ChatProvider` (`/chat/completions`) |
| `anthropic-messages` | `OpenAIv1ChatProvider` in Anthropic Messages mode |
| `openai-responses` | `OpenAIv1ResponseProvider` (`/responses`) |
| `generic` | Accepted by the schema, but no provider class handles it |

::: warning CLI limitation
The CLI's own factory (`createProviderFromDef` in `src/cli.ts`) only handles `openai-completions` and `openai-responses`. With `anima talk`, a provider with `api: anthropic-messages` fails with `provider not implemented: <id>`. The server and the router's default factory handle it.
:::

### `apiKey`

The key is resolved when the file loads:

- `${VAR}` is replaced with the environment variable. If it's unset, **the whole file is skipped** with a warning (`skipping invalid provider file ...: env var not set: VAR`).
- `${VAR:-default}` uses `default` when `VAR` is unset. The default can be empty.
- `${OAUTH:openai}` reads an OAuth token from a Codex login or an OpenClaw auth profile. `${OAUTH:supergrok}` reads an xAI token from `~/.anima/auth/supergrok.json`, `~/.config/xai/auth.json` or an OpenClaw profile. Other sources throw `unknown OAuth source`.

### `sharedSafe`

Opt-in flag for shared-conversation use. The default is `false`, because being OpenAI-compatible doesn't prove that an endpoint keeps sessions apart.

### Importing from OpenClaw

If an `import.yaml` file sits next to the `providers.d/` directory, its `sources` are imported too:

```yaml
# ~/.anima/import.yaml
sources:
  - type: openclaw
    path: ~/.openclaw/openclaw.json
```

## Where the registry is read from

| Component | Directory |
|-----------|-----------|
| CLI | `$ANIMA_HOME/providers.d` (default `~/.anima/providers.d`) |
| Server, Telegram, mesh | `<rooms dir>/../providers.d` |
| Meeting room | `~/.anima/providers.d` |

With `ANIMA_ROOMS_DIR=~/.anima/rooms`, all of these resolve to `~/.anima/providers.d`.

## Providers in this repo

`providers.d/` in the repo has example files for `anthropic`, `fireworks`, `gemini`, `minimax`, `minimax-openai`, `exampleprov`, `neuralwatt`, `openai`, `supergrok`, `wafer-ai` and `xiaomi`. Copy the ones you need into your `providers.d/` and set their API key variables. See [Models](./models.md) for the model ids they list.

## Related

- [Provider Router](./router.md): retries, fallback chains and the circuit breaker
- [Prompt Caching](../misc/prompt-caching.md): how the static prompt prefix is marked for caching
- [Proxy System](../misc/proxy-system.md): using the registry as an OpenAI- or Anthropic-compatible proxy
