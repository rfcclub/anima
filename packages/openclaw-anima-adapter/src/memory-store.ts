/**
 * AnimaMemoryStore for Node.js — wraps node:sqlite (DatabaseSync) to persist
 * agent memory entries in ~/.anima/agents/<name>/memory.db.
 *
 * Shares the same schema as AnimaEntityStore (neurons, synapses, embeddings + FTS5)
 * but uses node:sqlite instead of bun:sqlite so it works in the OpenClaw (Node.js) runtime.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryScope } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AgentMemoryEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  tags: string[];
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallOptions {
  scopes?: MemoryScope[];
  tags?: string[];
  minConfidence?: number;
  topK?: number;
  offset?: number;
}

export interface BootstrapOptions {
  currentPrompt?: string;
  maxEntries?: number;
}

export interface AgentMemoryStore {
  remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry>;
  recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]>;
  bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]>;
  forget(id: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Row type (internal)                                                */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/*  AnimaMemoryStore                                                   */
/* ------------------------------------------------------------------ */

export type EmbeddingFn = (text: string) => Promise<number[]>;

export class AnimaMemoryStore implements AgentMemoryStore {
  private db!: DatabaseSync;
  private initialized = false;
  private embeddingFn: EmbeddingFn | null = null;
  private embeddingModel = "unknown";

  constructor(private readonly dbPath: string) {}

  /** Wire an embedding function for vector search. Falls back to FTS-only if not set. */
  setEmbeddingFn(fn: EmbeddingFn, model = "external"): void {
    this.embeddingFn = fn;
    this.embeddingModel = model;
  }

  /** Open the database, apply schema, enable WAL. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS neurons (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        content      TEXT NOT NULL,
        metadata     TEXT NOT NULL DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synapses (
        id         TEXT PRIMARY KEY,
        source_id  TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
        target_id  TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        weight     REAL NOT NULL DEFAULT 1.0,
        metadata   TEXT NOT NULL DEFAULT '{}'
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS neurons_fts USING fts5(
        content,
        content='neurons',
        content_rowid='rowid',
        tokenize='trigram'
      )
    `);

    // Migration: rebuild FTS index with trigram tokenizer if existing DB uses the old default
    {
      const existing = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='neurons_fts'"
      ).get() as { sql: string } | undefined;
      if (!existing?.sql?.includes("trigram")) {
        this.db.exec("DROP TRIGGER IF EXISTS neurons_ai");
        this.db.exec("DROP TRIGGER IF EXISTS neurons_ad");
        this.db.exec("DROP TRIGGER IF EXISTS neurons_au");
        this.db.exec("DROP TABLE IF EXISTS neurons_fts");
        this.db.exec(`
          CREATE VIRTUAL TABLE neurons_fts USING fts5(
            content,
            content='neurons',
            content_rowid='rowid',
            tokenize='trigram'
          )
        `);
        this.db.exec("INSERT INTO neurons_fts(neurons_fts) VALUES('rebuild')");
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        neuron_id TEXT NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model     TEXT NOT NULL,
        PRIMARY KEY (neuron_id, model)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_synapses_source ON synapses(source_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_synapses_target ON synapses(target_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_neurons_type ON neurons(type)
    `);

    // FTS sync triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS neurons_ai AFTER INSERT ON neurons BEGIN
        INSERT INTO neurons_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS neurons_ad AFTER DELETE ON neurons BEGIN
        INSERT INTO neurons_fts(neurons_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS neurons_au AFTER UPDATE ON neurons BEGIN
        INSERT INTO neurons_fts(neurons_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO neurons_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `);

    // Migration: add scope/tags columns if they don't exist
    try {
      this.db.exec("ALTER TABLE neurons ADD COLUMN scope TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE neurons ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE neurons ADD COLUMN source TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE neurons ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5");
    } catch {
      // Column already exists
    }

    this.initialized = true;
  }

  /* ------------------------------------------------------------------ */
  /*  AgentMemoryStore Interface                                         */
  /* ------------------------------------------------------------------ */

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    this.ensureInitialized();

    const id = randomUUID();
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(entry.tags ?? []);
    const metadata = { ...(entry.metadata ?? {}), _scope: entry.scope };

    this.db
      .prepare(
        "INSERT INTO neurons (id, type, content, scope, tags, source, confidence, metadata, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        id,
        entry.scope,
        entry.content,
        entry.scope,
        tagsJson,
        entry.source,
        entry.confidence ?? 0.5,
        JSON.stringify(metadata),
        now,
        now,
      );

    // Generate and store embedding if embedding function is available
    if (this.embeddingFn) {
      try {
        const vec = await this.embeddingFn(entry.content);
        const blob = float32ArrayToBuffer(vec);
        this.db
          .prepare("INSERT OR REPLACE INTO embeddings (neuron_id, embedding, model) VALUES (?, ?, ?)")
          .run(id, blob, this.embeddingModel);
      } catch {
        // non-fatal — FTS fallback still works
      }
    }

    return {
      id,
      content: entry.content,
      scope: entry.scope,
      tags: entry.tags ?? [],
      confidence: entry.confidence ?? 0.5,
      source: entry.source,
      createdAt: now,
      metadata,
    };
  }

  async recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    this.ensureInitialized();

    const topK = options?.topK ?? 10;
    const results = await this.search(query, topK * 2);

    let entries = results.map((r) => this.toAgentMemoryEntry(r.neuron));

    // Filter by scope if specified
    if (options?.scopes && options.scopes.length > 0) {
      entries = entries.filter((e) => options.scopes!.includes(e.scope as MemoryScope));
    }

    // Filter by minimum confidence
    if (options?.minConfidence !== undefined) {
      entries = entries.filter((e) => e.confidence >= options.minConfidence!);
    }

    // Apply offset
    if (options?.offset !== undefined) {
      entries = entries.slice(options.offset);
    }

    return entries.slice(0, topK);
  }

  async bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]> {
    this.ensureInitialized();

    const maxEntries = options?.maxEntries ?? 10;

    // Most recent entries
    const recent = this.db
      .prepare("SELECT * FROM neurons ORDER BY created_at DESC LIMIT ?")
      .all(maxEntries) as Row[];

    // Top accessed entries
    const topAccessed = this.db
      .prepare("SELECT * FROM neurons ORDER BY access_count DESC, created_at DESC LIMIT ?")
      .all(maxEntries) as Row[];

    // Deduplicate by id
    const seen = new Set<string>();
    const results: AgentMemoryEntry[] = [];

    for (const rows of [topAccessed, recent]) {
      for (const row of rows) {
        const entry = this.toAgentMemoryEntry(row);
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          results.push(entry);
        }
      }
    }

    return results.slice(0, maxEntries);
  }

  async forget(id: string): Promise<void> {
    this.ensureInitialized();
    this.db.prepare("DELETE FROM neurons WHERE id = ?").run(id);
  }

  /** Close the database connection. */
  close(): void {
    if (this.initialized) {
      try {
        this.db.close();
      } catch {
        // best-effort
      }
      this.initialized = false;
    }
  }

  getDbPath(): string {
    return this.dbPath;
  }

  /** Expose the underlying DatabaseSync handle for direct table access.
   *  Only tools that need tables not covered by the AgentMemoryStore
   *  interface (neurons, synapses, embeddings) should use this. */
  getDb(): DatabaseSync {
    this.ensureInitialized();
    return this.db;
  }

  /* ------------------------------------------------------------------ */
  /*  Stats / Diagnose                                                   */
  /* ------------------------------------------------------------------ */

  getStats(): Record<string, unknown> {
    this.ensureInitialized();
    const n = this.db.prepare("SELECT COUNT(*) as c FROM neurons").get() as { c: number };
    const s = this.db.prepare("SELECT COUNT(*) as c FROM synapses").get() as { c: number };
    const e = this.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number };
    const oldest = this.db.prepare("SELECT MIN(created_at) as v FROM neurons").get() as { v: string | null };
    const newest = this.db.prepare("SELECT MAX(created_at) as v FROM neurons").get() as { v: string | null };
    return {
      total_neurons: n.c, total_synapses: s.c, total_embeddings: e.c,
      db_path: this.dbPath,
      oldest_entry_at: oldest.v, newest_entry_at: newest.v,
    };
  }

  diagnose(): Record<string, unknown> {
    this.ensureInitialized();
    const rows = this.db.prepare("SELECT scope, COUNT(*) as c FROM neurons GROUP BY scope").all() as Array<{ scope: string; c: number }>;
    const byScope: Record<string, number> = {};
    for (const r of rows) byScope[r.scope] = r.c;
    const low = this.db.prepare("SELECT COUNT(*) as c FROM neurons WHERE confidence < 0.4").get() as { c: number };
    const staleDate = new Date(Date.now() - 30 * 86400000).toISOString();
    const stale = this.db.prepare("SELECT COUNT(*) as c FROM neurons WHERE updated_at < ?").get(staleDate) as { c: number };
    return {
      total_entries: rows.reduce((sum, r) => sum + r.c, 0),
      by_scope: byScope,
      low_confidence_count: low.c,
      stale_count: stale.c,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Scratchpad                                                         */
  /* ------------------------------------------------------------------ */

  scratchpadSet(key: string, value: string): void {
    this.ensureInitialized();
    this.db.exec("CREATE TABLE IF NOT EXISTS scratchpad (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    this.db.prepare("INSERT OR REPLACE INTO scratchpad (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, new Date().toISOString());
  }

  scratchpadGet(key: string): { key: string; value: string | null; updated_at: string | null } {
    this.ensureInitialized();
    this.db.exec("CREATE TABLE IF NOT EXISTS scratchpad (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const row = this.db.prepare("SELECT key, value, updated_at FROM scratchpad WHERE key = ?").get(key) as { key: string; value: string; updated_at: string } | undefined;
    return row ?? { key, value: null, updated_at: null };
  }

  scratchpadDelete(key?: string): number {
    this.ensureInitialized();
    if (key) {
      this.db.prepare("DELETE FROM scratchpad WHERE key = ?").run(key);
      return 1;
    }
    const count = this.db.prepare("SELECT COUNT(*) as c FROM scratchpad").get() as { c: number };
    this.db.exec("DELETE FROM scratchpad");
    return count.c;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — FTS search                                              */
  /* ------------------------------------------------------------------ */

  private async search(
    query: string,
    topK: number,
  ): Promise<Array<{ neuron: Row; score: number }>> {
    const ftsResults = this.ftsSearch(query, topK * 2);
    const ftsRanks = new Map<string, number>();
    for (let i = 0; i < ftsResults.length; i++) {
      ftsRanks.set(ftsResults[i].id as string, i + 1);
    }

    // Vector search via cosine similarity when embedding function is available
    const vecRanks = new Map<string, number>();
    if (this.embeddingFn) {
      try {
        const queryVec = await this.embeddingFn(query);
        const rows = this.db
          .prepare("SELECT neuron_id, embedding FROM embeddings WHERE model = ?")
          .all(this.embeddingModel) as Array<{ neuron_id: string; embedding: Buffer }>;

        const scored: Array<{ id: string; sim: number }> = rows.map((r) => ({
          id: r.neuron_id,
          sim: cosineSimilarity(queryVec, bufferToFloat32Array(r.embedding)),
        }));
        scored.sort((a, b) => b.sim - a.sim);
        for (let i = 0; i < scored.length; i++) {
          vecRanks.set(scored[i].id, i + 1);
        }
      } catch {
        // embedding failed — fall back to FTS only
      }
    }

    // RRF fusion
    const RRF_K = 60;
    const allIds = new Set([...ftsRanks.keys(), ...vecRanks.keys()]);
    const scored: Array<{ id: string; score: number }> = [];
    for (const id of allIds) {
      let score = 0;
      if (ftsRanks.has(id)) score += 1 / (RRF_K + ftsRanks.get(id)!);
      if (vecRanks.has(id)) score += 1 / (RRF_K + vecRanks.get(id)!);
      scored.push({ id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ id, score }) => {
      const neuron = this.getNeuron(id)!;
      return { neuron, score };
    });
  }

  private ftsSearch(query: string, limit: number): Row[] {
    // Strip FTS5 control characters, then wrap each whitespace-separated
    // token as a quoted phrase. Join with OR so any matching word scores —
    // RRF fusion with vector search handles final ranking.
    const tokens = query
      .replace(/["'*+^:~()-]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return [];

    const phrase = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");

    try {
      return this.db
        .prepare(
          `SELECT n.* FROM neurons n
           JOIN neurons_fts f ON n.rowid = f.rowid
           WHERE neurons_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(phrase, limit) as Row[];
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — helpers                                                 */
  /* ------------------------------------------------------------------ */

  private getNeuron(id: string): Row | null {
    const row = this.db.prepare("SELECT * FROM neurons WHERE id = ?").get(id) as Row | undefined;
    return row ?? null;
  }

  private toAgentMemoryEntry(row: Row): AgentMemoryEntry {
    const meta = this.parseMeta(row.metadata as string | undefined);
    let tags: string[] = [];
    if (row.tags) {
      try {
        tags = JSON.parse(row.tags as string);
      } catch {
        tags = [];
      }
    } else if (meta._tags) {
      tags = meta._tags as string[];
    }

    return {
      id: row.id as string,
      content: row.content as string,
      scope: ((row.scope as string) || (row.type as string) || "fact") as MemoryScope,
      tags,
      confidence: (row.confidence as number) ?? 0.5,
      source: ((row.source as string) || (meta._source as string) || "unknown") as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string | undefined,
      metadata: meta,
    };
  }

  private parseMeta(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("AnimaMemoryStore not initialized. Call initialize() first.");
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Vector helpers                                                     */
/* ------------------------------------------------------------------ */

function float32ArrayToBuffer(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function bufferToFloat32Array(buf: Buffer): number[] {
  const out: number[] = new Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
