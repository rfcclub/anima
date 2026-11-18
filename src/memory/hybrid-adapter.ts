import type { MemoryConfig } from "../config/types";
import type { MemoryAdapter, MemoryEntry, RecallOptions } from "./adapter";
import { HindsightRecallAdapter, type HindsightLog } from "./hindsight-adapter";

export interface HybridOptions {
  /** Rows the extra leg may add on top of the base rows. Default 2. */
  extraSlots?: number;
  /** Called after each merge so a pilot can count what Hindsight actually contributed. */
  onMerge?: (info: { baseRows: number; extraRows: number; keptExtra: number }) => void;
}

const DEFAULT_EXTRA_SLOTS = 2;

/**
 * Runs a primary adapter and a best-effort extra adapter in parallel.
 * Primary rows come first, cut to topK. The extra leg then adds up to `extraSlots` rows of its own,
 * so a full primary result cannot starve it. An extra leg that throws is ignored; a primary error
 * propagates. store goes to the primary only.
 */
export class HybridMemoryAdapter implements MemoryAdapter {
  private readonly extraSlots: number;

  constructor(
    private readonly base: MemoryAdapter,
    private readonly extra: MemoryAdapter,
    private readonly options: HybridOptions = {},
  ) {
    const n = options.extraSlots;
    this.extraSlots = n !== undefined && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_EXTRA_SLOTS;
  }

  store(entry: MemoryEntry): Promise<void> {
    return this.base.store(entry);
  }

  async recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]> {
    const extraLeg = this.extra.recall(query, { ...opts, topK: this.extraSlots }).catch(() => [] as MemoryEntry[]);
    const baseRows = await this.base.recall(query, opts);
    const extraRows = await extraLeg;

    const topK = opts?.topK ?? 5;
    const seen = new Set<string>();
    const merged: MemoryEntry[] = [];
    for (const row of baseRows) {
      const key = row.content.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length === topK) break;
    }
    let keptExtra = 0;
    for (const row of extraRows) {
      if (keptExtra === this.extraSlots) break;
      const key = row.content.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      keptExtra++;
    }
    this.options.onMerge?.({ baseRows: baseRows.length, extraRows: extraRows.length, keptExtra });
    return merged;
  }
}

/** Wraps `base` with a Hindsight recall leg when `memory.hindsightBank` is set; otherwise returns `base` itself. */
export function withHindsight(
  base: MemoryAdapter,
  memory: MemoryConfig | undefined,
  agentName: string,
  log: HindsightLog,
): MemoryAdapter {
  if (!memory?.hindsightBank) return base;
  return new HybridMemoryAdapter(
    base,
    new HindsightRecallAdapter({
      bank: memory.hindsightBank,
      namespace: agentName,
      timeoutMs: memory.hindsightTimeoutMs,
      log,
    }),
    {
      extraSlots: memory.hindsightTopK,
      onMerge: (m) => log("info", "hindsight_recall_merged", { agent: agentName, bank: memory.hindsightBank, ...m }),
    },
  );
}
