# Memory Contract

`src/memory/contract.ts` defines the types that every memory store and adapter shares.

## MemoryScope

```typescript
type MemoryScope =
  | "episode" | "fact" | "observation" | "scent"
  | "preference" | "private" | "scar" | "decision"
  | "project" | "heartwood" | "growth_ring" | "canopy"
  | "identity" | "narrative" | "behavior" | "skill"
  | "relationship";
```

Cartridges can't declare `identity`, `private` or `heartwood` in `memory.write_scopes` (`LOCKED_WRITE_SCOPES` in `src/cartridge/registry.ts`).

## AgentMemoryEntry

```typescript
interface AgentMemoryEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  tags: string[];
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  parentIds?: string[];     // entries this one was derived from
  constraints?: string[];   // conditions under which it holds, e.g. "only_in_private_mode"
}
```

## RecallOptions and BootstrapOptions

```typescript
interface RecallOptions {
  scopes?: MemoryScope[];
  tags?: string[];
  minConfidence?: number;
  topK?: number;
  offset?: number;
}

interface BootstrapOptions {
  currentPrompt?: string;
  maxEntries?: number;
}
```

## AgentMemoryStore

The cross-session store interface:

```typescript
interface AgentMemoryStore {
  remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry>;
  recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]>;
  bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]>;
  forget(id: string): Promise<void>;           // no error if the id doesn't exist
  findByTag?(tag: string): Promise<AgentMemoryEntry | undefined>; // optional, for idempotent writes
}
```

Which implementation an agent gets is described in [Memory](../substrate/memory.md).
