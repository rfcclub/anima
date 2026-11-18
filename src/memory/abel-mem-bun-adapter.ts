// ---------------------------------------------------------------------------
// AbelMemBunAdapter — bun:sqlite native adapter for abel-mem
// ---------------------------------------------------------------------------
// Opens abel-mem.db directly via bun:sqlite (no HTTP, no Node, no spawn).
// Dual-writes to AnimaEntityStore (memory.db) for failover + embeddings.
// abel-mem.db is primary, memory.db is secondary.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentMemoryEntry,
  AgentMemoryStore,
  MemoryScope,
  RecallOptions,
  BootstrapOptions,
} from "./contract";
import { AnimaEntityStore } from "./anima-entity-store";
import { MemoryWriteError } from "./errors";

// ── abel-mem.db row types ────────────────────────────────────────────────────

interface AbelMemRow {
  id: number;
  memory_type: string;
  content: string;
  confidence: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
  is_active: number;
  abstraction_level: string;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

const DEFAULT_2B_MEM_DB = join(homedir(), "work", "abel-mem", "data", "abel-mem.db");

/**
 * AbelMemBunAdapter — AgentMemoryStore using bun:sqlite against abel-mem.db.
 *
 * All operations hit abel-mem first. On remember(), data is also written to
 * a fallback AnimaEntityStore so the embedding + FTS index stay current.
 * On recall/bootstrap, AnimaEntityStore is used as fallback when abel-mem
 * returns no results.
 */
export class AbelMemBunAdapter implements AgentMemoryStore {
  private db: Database;
  private fallback: AnimaEntityStore;
  private agentName: string;

  constructor(
    dbPath?: string,
    fallbackStore?: AnimaEntityStore,
    agentName?: string,
  ) {
    this.db = new Database(dbPath ?? DEFAULT_2B_MEM_DB);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.agentName = agentName ?? "abel";

    this.fallback =
      fallbackStore ??
      new AnimaEntityStore(
        join(homedir(), ".anima", "agents", this.agentName, "memory.db"),
      );
  }

  /** Ensure the fallback store is initialized before use. */
  async ensureFallbackReady(): Promise<void> {
    try {
      await this.fallback.initialize();
    } catch {
      // Fallback not critical — continue without it
    }
  }

  // ── AgentMemoryStore implementation ──────────────────────────────────────

  async remember(
    entry: Omit<AgentMemoryEntry, "id" | "createdAt">,
  ): Promise<AgentMemoryEntry> {
    const now = new Date().toISOString();
    const memoryType = scopeToMemoryType(entry.scope);
    const tagsJson = JSON.stringify(entry.tags ?? []);
    const confidence = entry.confidence ?? 0.8;

    // 1. Write to abel-mem (primary)
    let abelId = "";
    let primaryError: unknown;
    try {
      const stmt = this.db.prepare(
        `INSERT INTO memories (memory_type, content, confidence, tags, abstraction_level, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'direct', ?, ?)`,
      );
      const result = stmt.run(
        memoryType,
        entry.content.substring(0, 2000),
        confidence,
        tagsJson,
        now,
        now,
      );
      abelId = String(result.lastInsertRowid);
    } catch (err) {
      primaryError = err;
      console.error(`[AbelMemBunAdapter] abel-mem write error: ${err}`);
    }

    // 2. Also write to AnimaEntityStore (fallback/embeddings)
    const fallbackResult = await this.writeFallback(entry, abelId);

    if (!abelId && !fallbackResult.ok) {
      throw new MemoryWriteError(
        `both abel-mem and fallback write failed: primary=${errorMessage(primaryError)}; fallback=${errorMessage(fallbackResult.error)}`,
      );
    }

    const id = abelId || (fallbackResult.ok ? fallbackResult.entry.id : "");

    return {
      id,
      content: entry.content,
      scope: entry.scope,
      tags: entry.tags ?? [],
      confidence,
      source: entry.source ?? this.agentName,
      createdAt: now,
    };
  }

  async recall(
    query: string,
    options?: RecallOptions,
  ): Promise<AgentMemoryEntry[]> {
    if (!query || query.trim().length === 0) return [];

    const topK = options?.topK ?? 10;
    const results: AgentMemoryEntry[] = [];

    // 1. Recall from abel-mem (primary)
    try {
      const rows = this.search2bMem(query, topK);
      for (const row of rows) {
        results.push(this.rowToEntry(row));
      }
    } catch (err) {
      console.error(`[AbelMemBunAdapter] abel-mem recall error: ${err}`);
    }

    // 2. Fallback to AnimaEntityStore if abel-mem empty
    if (results.length === 0) {
      try {
        await this.ensureFallbackReady();
        const fallbackResults = await this.fallback.recall(query, options);
        return fallbackResults;
      } catch (err) {
        console.error(`[AbelMemBunAdapter] fallback recall error: ${err}`);
      }
    }

    return results.slice(0, topK);
  }

  /** Exact tag match against abel-mem's JSON tags column (M2 idempotent remember). */
  async findByTag(tag: string): Promise<AgentMemoryEntry | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE is_active = 1 AND (
           tags = json_array(?)
           OR tags LIKE '[' || ? || ',%'
           OR tags LIKE '%,' || ? || ',%'
           OR tags LIKE '%,' || ? || ']'
         )
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tag, JSON.stringify(tag), JSON.stringify(tag), JSON.stringify(tag)) as AbelMemRow | null;
    return row ? this.rowToEntry(row) : undefined;
  }

  async forget(id: string): Promise<void> {
    // Try numeric ID for abel-mem, UUID for fallback
    const numId = parseInt(id, 10);

    if (!isNaN(numId)) {
      // Soft-delete in abel-mem
      try {
        this.db
          .prepare(
            `UPDATE memories SET is_active = 0, deactivated_at = ? WHERE id = ?`,
          )
          .run(new Date().toISOString(), numId);
      } catch (err) {
        console.error(`[AbelMemBunAdapter] abel-mem forget error: ${err}`);
      }
    }

    // Also forget in fallback
    try {
      await this.ensureFallbackReady();
      await this.fallback.forget(id);
    } catch {
      // Best-effort
    }
  }

  async bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]> {
    const maxEntries = options?.maxEntries ?? 10;
    const results: AgentMemoryEntry[] = [];

    // 1. Bootstrap from abel-mem: core lane + recent
    try {
      // Core lane memories (highest priority)
      const coreRows = this.db
        .prepare(
          `SELECT m.* FROM memories m
           INNER JOIN lanes l ON l.memory_id = m.id
           WHERE m.is_active = 1 AND l.lane_type = 'core'
           ORDER BY l.priority DESC
           LIMIT ?`,
        )
        .all(maxEntries) as AbelMemRow[];

      for (const row of coreRows) {
        results.push(this.rowToEntry(row));
      }

      // Top up with recent if needed
      if (results.length < maxEntries) {
        const recentRows = this.db
          .prepare(
            `SELECT * FROM memories
             WHERE is_active = 1
             ORDER BY updated_at DESC
             LIMIT ?`,
          )
          .all(maxEntries - results.length) as AbelMemRow[];

        const seen = new Set(results.map((r) => r.id));
        for (const row of recentRows) {
          const id = String(row.id);
          if (!seen.has(id)) {
            results.push(this.rowToEntry(row));
            seen.add(id);
          }
        }
      }
    } catch (err) {
      console.error(`[AbelMemBunAdapter] abel-mem bootstrap error: ${err}`);
    }

    // 2. Fallback
    if (results.length === 0) {
      try {
        await this.ensureFallbackReady();
        return this.fallback.bootstrap(options);
      } catch {
        return [];
      }
    }

    return results.slice(0, maxEntries);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** FTS-like search against abel-mem memories. */
  private search2bMem(query: string, limit: number): AbelMemRow[] {
    // Simple LIKE search — abel-mem doesn't have FTS, keyword-based
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) {
      return this.db
        .prepare(
          `SELECT * FROM memories WHERE is_active = 1 ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(limit) as AbelMemRow[];
    }

    // Build OR LIKE clauses
    const likeClauses = words.map(() => `LOWER(content) LIKE ?`).join(" OR ");
    const params = words.map((w) => `%${w}%`);

    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE is_active = 1 AND (${likeClauses})
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as AbelMemRow[];

    return rows;
  }

  /** Convert a abel-mem row to AgentMemoryEntry. */
  private rowToEntry(row: AbelMemRow): AgentMemoryEntry {
    return {
      id: String(row.id),
      content: row.content,
      scope: memoryTypeToScope(row.memory_type),
      tags: parseTags(row.tags),
      confidence: row.confidence,
      source: this.agentName,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: {
        _abel_mem_type: row.memory_type,
        abstraction: row.abstraction_level,
      },
    };
  }

  /** Write to fallback AnimaEntityStore. Reports success/failure instead of
   *  fabricating a synthetic entry when nothing was actually persisted. */
  private async writeFallback(
    entry: Omit<AgentMemoryEntry, "id" | "createdAt">,
    abelId: string,
  ): Promise<{ ok: true; entry: AgentMemoryEntry } | { ok: false; error: unknown }> {
    try {
      await this.ensureFallbackReady();
      const written = await this.fallback.remember({
        ...entry,
        metadata: {
          ...(entry.metadata ?? {}),
          _abel_mem_id: abelId,
        },
      });
      return { ok: true, entry: written };
    } catch (err) {
      console.error(`[AbelMemBunAdapter] fallback write error: ${err}`);
      return { ok: false, error: err };
    }
  }

  close(): void {
    this.db.close();
  }
}

// ── Scope ↔ MemoryType mapping ──────────────────────────────────────────
// Mirror the abel-mem scripts mapping

const SCOPE_TO_TYPE: Record<string, string> = {
  fact: "fact",
  preference: "preference",
  behavior: "behavior",
  skill: "skill",
  relationship: "relationship",
  episode: "task",
  observation: "reflection",
  decision: "decision",
  scent: "reflection",
  private: "behavior",
  scar: "reflection",
  identity: "preference",
  project: "task",
  heartwood: "relationship",
  growth_ring: "learning",
  canopy: "reflection",
};

const TYPE_TO_SCOPE: Record<string, MemoryScope> = {
  fact: "fact",
  preference: "preference",
  behavior: "behavior",
  skill: "skill",
  relationship: "relationship",
  task: "episode",
  learning: "observation",
  reflection: "observation",
  decision: "decision",
  correction: "observation",
};

function scopeToMemoryType(scope: string): string {
  return SCOPE_TO_TYPE[scope] || "reflection";
}

function memoryTypeToScope(memoryType: string): MemoryScope {
  return TYPE_TO_SCOPE[memoryType] || "observation";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags);
  } catch {
    return [];
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createAbelMemBunAdapter(
  dbPath?: string,
  fallbackStore?: AnimaEntityStore,
  agentName?: string,
): AbelMemBunAdapter {
  return new AbelMemBunAdapter(dbPath, fallbackStore, agentName);
}
