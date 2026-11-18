import type { MemoryAdapter, MemoryEntry, RecallOptions } from "./adapter";

export class NullMemoryAdapter implements MemoryAdapter {
  async store(_entry: MemoryEntry): Promise<void> {}
  async recall(_query: string, _opts?: RecallOptions): Promise<MemoryEntry[]> {
    return [];
  }
}
