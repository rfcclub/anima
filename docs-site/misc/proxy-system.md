# Proxy System

The ANIMA server can act as an LLM proxy. Tools that speak the Anthropic Messages API or the OpenAI Chat Completions API can point at the server, and it forwards each request to a provider from your [provider registry](../providers/overview.md#the-provider-registry).

The proxy is part of the main server (`src/server.ts` → `handleProxyRequest()` in `src/proxy/index.ts`). There's no separate proxy process or port.

::: warning
Like the rest of the HTTP API, the proxy has no authentication, and it uses your provider API keys. Only run the server bound to localhost. See [Security Status](../guide/security.md).
:::

## Endpoints

All endpoints accept `POST` only. Other methods get `405`.

| Path | Request format |
|------|----------------|
| `/ai/v1/messages` | Anthropic Messages |
| `/ai/v1/chat/completions` | OpenAI Chat Completions |
| `/ai/v1/responses` | Parsed the same way as Chat Completions |

Any other `/ai/v1/...` path returns `404`. If the provider registry can't be loaded, the response is `503`.

Streaming (`"stream": true`) is supported.

## Choosing the provider

The `model` field in the request decides where it goes:

1. **Overrides** are checked first (see below).
2. `provider/model`, for example `exampleprov/deepseek-v4-flash`: that provider, with everything after the first `/` as the model id.
3. A bare model id, for example `deepseek-v4-flash`: the first provider, in alphabetical order of provider id, that lists that id under `models:`.

If nothing matches, the response is `400` with `model not found: <model>`.

The upstream request is sent with `OpenAIv1ChatProvider` using the provider's `api`, `baseUrl`, `apiKey`, `headers` and `extraParams`.

## Overrides

An optional YAML file redirects models. Its path is `ANIMA_PROXY_OVERRIDES`, default `~/.config/anima/proxy-overrides.yaml`:

```yaml
overrides:
  - match: claude-sonnet-4-6      # exact model name, or "*" for everything
    provider: exampleprov             # a registry provider id, or a key under providers:
    model: deepseek-v4-flash
providers:                        # optional inline providers
  local:
    baseUrl: http://127.0.0.1:8080/v1
    apiKey: ${LOCAL_KEY}
    api: openai-completions
```

The first matching rule wins. When an override is used, the server logs a `proxy override` line with the original and new model. The file is read once and cached until the server restarts. If it's missing or has no `overrides` list, overrides are off.

## Caller detection

Each request is tagged with a caller: the `x-anima-caller` header if present, otherwise a guess from the `User-Agent` (`claude-code`, `codex`, `anthropic-sdk`, `openai-sdk`), otherwise `proxy-gateway`.

## Example

```bash
curl http://127.0.0.1:3700/ai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "gemini/gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]}'
```

## Cost tracking

Agent sessions (CLI, `AgentSession`, Web UI) log token usage to `ANIMA_COST_DB`, default `~/.anima/cost.db`. Proxy requests aren't logged there. The server reports it at:

- `GET /api/cost/summary`
- `GET /api/cost/by-model`
- `GET /api/cost/by-agent`
- `GET /api/cost/by-provider`

There's no `anima cost` CLI command.
