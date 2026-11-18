import type {
  AgentMemoryEntry,
  AgentMemoryStore,
  BootstrapOptions,
  MemoryScope,
  RecallOptions,
} from "./contract";

/** Scopes no cartridge may ever write, regardless of declared policy. */
export const LOCKED_SCOPES: readonly MemoryScope[] = ["identity", "private", "heartwood"];

/** Default writable set when a cartridge declares no memory policy. */
export const DEFAULT_WRITE_SCOPES: readonly MemoryScope[] = [
  "scent", "scar", "decision", "episode", "observation", "fact", "project",
];

export interface ScopedStorePolicy {
  cartridge: string;
  writeScopes?: MemoryScope[];
}

export interface ScopeViolation {
  cartridge: string;
  scope: MemoryScope;
  timestamp: string;
}

export class MemoryScopeViolationError extends Error {
  constructor(
    public readonly scope: MemoryScope,
    public readonly cartridge: string,
  ) {
    super(`memory scope "${scope}" is not writable while cartridge "${cartridge}" is active`);
    this.name = "MemoryScopeViolationError";
  }
}

/**
 * Decorator enforcing cartridge write policy at the memory layer.
 * Reads pass through untouched; writes are scope-checked, provenance-tagged, and audited.
 */
export class ScopedMemoryStore implements AgentMemoryStore {
  private readonly allowed: Set<MemoryScope>;
  private readonly audit: ScopeViolation[] = [];

  constructor(
    private readonly inner: AgentMemoryStore,
    private readonly policy: ScopedStorePolicy,
  ) {
    const declared = policy.writeScopes ?? [...DEFAULT_WRITE_SCOPES];
    this.allowed = new Set(declared.filter((s) => !LOCKED_SCOPES.includes(s)));
  }

  violations(): ScopeViolation[] {
    return [...this.audit];
  }

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    if (!this.allowed.has(entry.scope)) {
      this.audit.push({
        cartridge: this.policy.cartridge,
        scope: entry.scope,
        timestamp: new Date().toISOString(),
      });
      throw new MemoryScopeViolationError(entry.scope, this.policy.cartridge);
    }
    return this.inner.remember({
      ...entry,
      metadata: { ...entry.metadata, cartridge: this.policy.cartridge },
    });
  }

  recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    return this.inner.recall(query, options);
  }

  bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]> {
    return this.inner.bootstrap(options);
  }

  forget(id: string): Promise<void> {
    return this.inner.forget(id);
  }
}

/** Wrap a store when a cartridge is active; identity function otherwise. */
export function guardMemoryStore(
  store: AgentMemoryStore | undefined,
  active?: { name: string; memory?: { writeScopes: MemoryScope[] } },
): AgentMemoryStore | undefined {
  if (!store || !active) return store;
  return new ScopedMemoryStore(store, {
    cartridge: active.name,
    writeScopes: active.memory?.writeScopes,
  });
}
