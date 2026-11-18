# Prompt Caching

ANIMA splits every system prompt into a **static prefix** and a **dynamic suffix** (see [Context Engine](../sessions/context-engine.md)). The prefix is the part that stays the same between turns, so it's what a provider can cache. ANIMA passes the prefix to the provider as `cachePrefix`, and some providers turn it into explicit cache markers.

## What ANIMA sends

The CLI and `AgentSession` send:

- `system`: the full prompt
- `cachePrefix`: the static prefix (`system` starts with it)
- `staticHash`: a short hash of the prefix, for tracking whether it changed

```typescript
// src/agents/prompter.ts
let h = 0;
for (let i = 0; i < staticPrefix.length; i++) {
  h = ((h << 5) - h) + staticPrefix.charCodeAt(i);
  h |= 0;
}
const staticHash = (h >>> 0).toString(36);
```

## What each provider does with it

| Provider class | Behavior |
|----------------|----------|
| `OpenAIv1ChatProvider` with provider id `anthropic`, `xiaomi` or `minimax` | Adds `cache_control: { type: "ephemeral" }` breakpoints: on the static prefix as its own system block, on the last tool definition, and on the last message |
| `OpenAIv1ChatProvider` with any other provider id | No cache markers. The request is sent as usual, and any caching is up to the provider |
| `AnthropicProvider` (CLI `claude`, Claude Agent SDK) | Sends the system prompt as `[cachePrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamic part]` so the SDK can cache the prefix |
| Others | Ignore `cachePrefix` |

The list of providers that get `cache_control` is `CACHE_CONTROL_PROVIDERS` in `src/providers/openai-v1-chat.ts`. It's matched by provider **id**, so a provider file with a different id won't get markers even if it uses the same API.

ANIMA doesn't measure cache hits or savings itself. Whether a provider caches and what it charges depends on that provider.

## Keeping the prefix stable

The prefix only stays cacheable if it's the same from turn to turn. The code keeps volatile content out of it:

- The date is in the dynamic suffix (`Date: YYYY-MM-DD`), not the prefix.
- Memory, recall and bootstrap content are in the suffix.
- In legacy activation, the per-turn pluggable cartridge is in the suffix as `## Active Cartridge`. With an execution plan, all layer winners are in the prefix, so a different language or task cartridge on the next turn changes the prefix.
- Blocks that `AgentSession` appends after the builder (substrate view, host context, `[Memory Context]`, identity anchor) come after the prefix.

Editing the soul, instructions or cartridge files changes the prefix and its `staticHash`.
