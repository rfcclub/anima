# Cartridge Kinds

`kind` is the cartridge's layer in the [execution plan](./activation.md#execution-plan). It's optional. The valid values are `CARTRIDGE_KINDS` in `src/cartridge/types.ts`:

| Kind | Purpose | In this repo |
|------|---------|--------------|
| `kernel` | Engineering fundamentals | `engineering-common-lite` |
| `persona` | Interaction style | `warmth`, `creative` |
| `role` | Kind of work | `programming`, `deployment`, `game-design`, `philosophy` |
| `language` | Programming language | `typescript`, `python`, `csharp` |
| `framework` | Framework or domain | none |
| `project` | Repo-specific context | none |
| `review` | QA rules | `qa` |
| `task` | Current task | `visual-novel` |

## Rules

- A `kind` that isn't in the list makes the registry skip the file with a warning.
- A cartridge without `kind` never wins a layer. It can still be used through `universal`, `requires`, an override, or the legacy activation path.
- `kernel` isn't scored as a layer. Kernels come in through `universal` or a role's `requires`.
- The execution plan doesn't have a `review` slot, so a `review` winner isn't added to the prompt.

## Kind and category

`category` is separate and required:

```yaml
category: craft    # activation lane: craft | think | create | operate
kind: role         # layer
```

Legacy activation picks pluggable cartridges by `category`. The execution plan uses `kind` for layers, and `category` only for `selfSelect` and `taskPatterns`.
