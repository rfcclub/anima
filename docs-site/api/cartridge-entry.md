# CartridgeEntry

A `CartridgeEntry` is one parsed cartridge file, as returned by `CartridgeRegistry.list()` (`src/cartridge/registry.ts`).

## Interface

```typescript
type CartridgeScope = "shared" | "agent" | "pluggable" | "dynamic";

interface CartridgeEntry {
  category: CartridgeCategory;  // craft | think | create | operate
  kind?: CartridgeKind;         // kernel | persona | role | language | framework | project | review | task
  name: string;
  path: string;                 // absolute path of the file
  content: string;              // body after the frontmatter, trimmed
  scope: CartridgeScope;
  guides?: string[];
  rules?: string[];
  /** @deprecated Use guides/rules instead. Legacy fallback — treated as guides. */
  skills?: string[];
  requires?: string[];
  conflicts?: string[];
  priority?: number;
  persona?: string;
  retrieval?: RetrievalPolicy;
  triggers?: { task?: string[]; mode?: string[] };
  budgetTokens?: number;        // from `budget_tokens`
  memory?: CartridgeMemoryPolicy; // { writeScopes } from `memory.write_scopes`
}
```

## Scope

The registry sets `scope` from where the file was found:

| Location | `scope` |
|----------|---------|
| `cartridges/shared/` in any tier | `shared` |
| `cartridges/pluggable/` in any tier | `pluggable` |
| `cartridges/dynamic/` in any tier (legacy) | `pluggable` |
| `rooms/<agent>/cartridges/` | `agent` |

`dynamic` is part of the type, but the registry doesn't assign it.

## Frontmatter mapping

Most fields have the same name in YAML. The exceptions are `budget_tokens` → `budgetTokens` and `memory.write_scopes` → `memory.writeScopes`. Entries are de-duplicated by `name` + `category`, and the higher tier wins. See [Creating a Cartridge](../cartridge/creating.md).

## Related

- `CartridgeBlock` (`src/cartridge/types.ts`): `{ name, scope, category, content }`, the form used in prompts and execution plans
- `validateEntry()`: fails an entry that declares `identity`, `private` or `heartwood` in `memory.write_scopes`
