# Provider Router

`ModeRouter` (`src/providers/router.ts`) tries a list of models in order and moves on when one fails with a transient error. It's used when `provider.type` is `router`, which the CLI supports (`createRouterProvider` in `src/cli.ts`).

## Which list it uses

`ModeRouter.query()` picks one of two paths:

1. **Fallback chain**, when the agent config has both `provider.type` and `provider.model`:

   ```yaml
   provider:
     type: anthropic
     model: claude-sonnet-4-6
     retry: 3                 # default 3
     fallback:
       - { type: gemini, model: gemini-2.5-flash }            # default retry 2
       - { type: exampleprov, model: deepseek-v4-flash, retry: 1 } # later entries default to 1
   ```

   The chain is the main `model@type`, then each fallback in order.

2. **Mode map**, otherwise. The router takes the list for the current task mode from `provider.modeMap` in the room config, or from `~/.anima/mode-map.yaml`:

   ```yaml
   # ~/.anima/mode-map.yaml — every task mode needs an entry
   chatting: [gemini-2.5-flash@gemini]
   programming: [claude-sonnet-4-6@anthropic, deepseek-v4-flash@exampleprov]
   image: [gemini-2.5-flash@gemini]
   private: [gemini-2.5-flash@gemini]
   philosophy: [gemini-2.5-flash@gemini]
   creative: [gemini-2.5-flash@gemini]
   ```

   The current task mode comes from `--mode`, or from `anima mode` (stored in `~/.anima/state.yaml`). The default is `chatting`.

References are always `model@provider`. The part after the last `@` is the provider id. `ProviderRegistry.resolve()` throws `unknown provider` or `unknown model` if either isn't in the registry.

::: tip
With `provider.type: router`, a config that also sets `provider.model` takes the fallback-chain path with `router` as the provider id, which isn't a registry entry. Leave `provider.model` out when you use the mode map.
:::

## Errors and fallback

| Error code | Fallback chain | Mode map |
|------------|----------------|----------|
| `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `SERVER_ERROR`, `TIMEOUT` | Retry this entry up to `retry` times, then move to the next | Move to the next entry |
| `AUTH_ERROR` | Skip to the next entry, no retry | Skip every later entry for the same provider |
| Anything else | Thrown right away | Thrown right away |

When every entry fails, the router throws `SERVER_ERROR` with `all providers exhausted. tried: ...` and lists each attempt.

Streaming responses aren't supported through the router.

## Circuit breaker

`CircuitBreaker` (`src/providers/circuit-breaker.ts`) shares provider health between processes through a JSON file.

| Setting | Value |
|---------|-------|
| State file | `ANIMA_BREAKER_FILE`, default `~/.anima/breaker.json` |
| Opens after | 2 failures |
| Cooldown | 5 minutes, then half-open (one trial request) |
| Stale entries | Dropped after 24 hours without updates |
| Turn it off | `ANIMA_BREAKER_DISABLED=true` |

When a provider's breaker is open, the router skips it. In the fallback chain, a failure is recorded once that entry's retries are used up. A success while half-open closes the breaker. In the mode-map path, each transient failure is recorded.

## Provider instances

The router creates one provider object per provider id and reuses it. The CLI passes its own factory, so the [CLI limitation](./overview.md#api) on `anthropic-messages` applies here too. The router's default factory handles `openai-completions`, `anthropic-messages` and `openai-responses`.

## Default files

When the CLI needs the router or the task mode and the files are missing, it writes:

- `~/.anima/providers.d/gemini.yaml` with `api: generic` and model `gemini-3.1-flash-lite-preview`
- `~/.anima/mode-map.yaml` mapping every task mode to `gemini-3.1-flash-lite-preview@gemini`

Because no provider class handles `api: generic`, replace the generated `gemini.yaml` with a working one (for example the repo's `providers.d/gemini.yaml`, which uses `openai-completions`).
