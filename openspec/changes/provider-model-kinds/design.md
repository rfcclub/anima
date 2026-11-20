# Provider model kinds

Source issue #91. Design and plan for review.

## Architecture

`src/config/types.ts` owns the optional model discriminant `kind: "chat" | "decision" | "image"`. Normalize an omitted kind to chat where the registry reads provider YAML and imports. Keep legacy public TypeScript literals valid. Validate any decision-bearing provider before API-key resolution. Accept only HTTPS with the exact TypeSafe decision hostname, no userinfo, query, fragment, port override or redirect. Derive the fixed `/v1/systemone` route from the validated origin. Provider-wide chat API/endpoint settings remain for chat only. Use explicit `model@provider` references and refuse missing or wrong-kind references without choosing a model or switching providers. Config failures skip the invalid provider and produce a credential-free warning.

Keep `ProviderRegistry` as the single config source. Pass a minimal resolved decision descriptor to the existing `decideQueryChoices` package transport. The package accepts an injected descriptor and never imports server modules. Resolve the descriptor in the host at composition time. An independently launched hook can read the same operator-specified registry directory through the existing Bun registry path. This shared-config approach and model-level kind are proposed answers to #91's two open questions. Approve before wiring either consumer. Do not add a second config format or duplicate credentials. Preserve the current behavior of both callers on missing configuration, timeout or malformed replies. Keep the existing hook gating and sensitivity rules. The transport receives only the caller-approved state.

Before exposing mixed definitions to chat, filter chat defaults to explicit or legacy chat models and refuse explicit wrong-kind catalog selections at the chat and proxy boundaries. Preserve existing uncatalogued chat overrides where they already work. Image is catalog metadata until a dedicated transport exists. A later consumer can use the same resolver without changes to decision policy.

## Test strategy

Registry fixtures cover all three kinds, missing and malformed kinds, matching and wrong-kind named references, and pre-key rejection for unsafe decision origins. Stub requests assert selected model, fixed route, no redirects and injected credentials. Tests preserve query limits, answer validation, hook failures keeping all items, sensitive-term filtering and old chat behavior.

## Non-goals

Image generation, chat task-mode changes, releasing credentials, and changes to the hook sensitivity policy are outside this work.
