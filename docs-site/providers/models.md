# Models

ANIMA doesn't have its own model list. The models you can use are the ones listed under `models:` in your [provider files](./overview.md#the-provider-registry). An agent picks one with `provider.model`, or with `model@provider` references in a mode map or fallback chain.

## Models in the repo's provider files

These are the model ids listed in `providers.d/` in this repo. Whether they work depends on your account with each provider.

| Provider id | `api` | Models |
|-------------|-------|--------|
| `anthropic` | `anthropic-messages` | `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| `gemini` | `openai-completions` | `gemini-2.5-flash`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-pro` |
| `openai` | `openai-completions` | `gpt-5.2`, `gpt-5.1`, `gpt-4.2`, `gpt-4.1`, `gpt-4.1-mini`, `o4-mini` |
| `exampleprov` | `openai-completions` | `glm-5.1`, `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`, `qwen3.5-397b-a17b` |
| `neuralwatt` | `openai-completions` | `kimi-k2.6`, `glm-5.1`, `qwen3.5-397b`, `qwen3.6-35b` |
| `fireworks` | `openai-completions` | `accounts/fireworks/routers/kimi-k2p6-turbo` |
| `minimax` | `anthropic-messages` | `MiniMax-M2.7`, `MiniMax-M2.7-highspeed` |
| `minimax-openai` | `openai-completions` | `MiniMax-M3` |
| `supergrok` | `openai-completions` | `grok-4`, `grok-4-mini`, `grok-3`, `grok-3-mini` |
| `wafer-ai` | `openai-completions` | `GLM-5.1`, `Qwen3.5-397B-A17B` |
| `xiaomi` | `anthropic-messages` | `mimo-v2.5-pro`, `mimo-v2.5` |

## Selecting a model

```yaml
# One model
provider:
  type: exampleprov
  model: deepseek-v4-flash
```

```yaml
# A model per task mode (CLI router)
provider:
  type: router
  modeMap:
    programming: [claude-sonnet-4-6@anthropic, deepseek-v4-flash@exampleprov]
    chatting: [gemini-2.5-flash@gemini]
```

You can also override the model for one call:

- CLI: `anima talk <agent> "<msg>" --model <id>`
- Telegram: `/model <id>` or `/model <provider>/<id>`
- Web UI: the model picker (`GET /api/models`)

## The same id in several providers

Some ids appear in more than one provider file (for example `glm-5.1` and `kimi-k2.6`). In a `model@provider` reference, the provider decides which one is used. The [LLM proxy](../misc/proxy-system.md) also accepts a bare model id, and then takes the first provider in alphabetical order that lists it.
