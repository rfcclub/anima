import { Database, type Statement, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import type { AgentMemoryStore, AgentMemoryEntry, RecallOptions, BootstrapOptions, MemoryScope } from "./contract";
import { configureMemoryWal } from "./sqlite-wal";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Neuron {
  id: string;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Synapse {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  neuron: Neuron;
  score: number;
}

/* ------------------------------------------------------------------ */
/*  Entity Store                                                       */
/* ------------------------------------------------------------------ */

const EMBEDDING_MODEL = "models/gemini-embedding-2";
const RRF_K = 60;

/**
 * AnimaEntityStore — SQLite-backed neural entity store with hybrid search.
 *
 * The standard fallback memory backend for all non-core colony agents,
 * implementing the full AgentMemoryStore contract. Stores neurons (memory
 * entries) and synapses (weighted relationships) in an SQLite database with
 * FTS5 full-text search. When GEMINI_API_KEY is configured, also generates
 * and stores embeddings for semantic vector search, combining results via
 * Reciprocal Rank Fusion (RRF). Supports scope/tag/confidence filtering and
 * provides direct CRUD access to the underlying graph structure.
 */
export class AnimaEntityStore {
  private db!: Database;
  private stmtCache = new Map<string, Statement>();
  private embeddingClient: GoogleGenerativeAI | null = null;
  private embeddingsAvailable = false;
  private readonly pendingEmbeddings = new Set<Promise<void>>();

  constructor(private readonly dbPath: string) {}

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async initialize(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    try {
      await configureMemoryWal(this.db);
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeSchema(): void {
    this.db.exec("PRAGMA foreign_keys=ON");

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
    // Migration: add parent_ids and constraints columns for provenance tracking
    try {
      this.db.exec("ALTER TABLE neurons ADD COLUMN parent_ids TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE neurons ADD COLUMN constraints TEXT");
    } catch {
      // Column already exists
    }

    // Scratchpad table for session-scoped key-value notes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scratchpad (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Check embedding availability
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        this.embeddingClient = new GoogleGenerativeAI(apiKey);
        this.embeddingsAvailable = true;
      } catch {
        this.embeddingsAvailable = false;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  AgentMemoryStore Interface Implementation                          */
  /* ------------------------------------------------------------------ */

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    const content = entry.content ?? "";
    const stripped = content.trimStart();
    if (
      stripped.startsWith("[auto] assistant:") ||
      stripped.startsWith("[auto] user:") ||
      (stripped.startsWith('[{"type"') && (stripped.includes('"toolCall"') || stripped.includes('"type":"toolCall"')))
    ) {
      const now = new Date().toISOString();
      return { id: "skipped-garbage", content, scope: entry.scope, tags: entry.tags ?? [], confidence: 0, source: entry.source, createdAt: now, metadata: {} };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(entry.tags ?? []);
    const metadata = { ...(entry.metadata ?? {}), _scope: entry.scope };
    const parentIdsJson = JSON.stringify(entry.parentIds ?? []);
    const constraintsJson = JSON.stringify(entry.constraints ?? []);

    this.stmt(
      "INSERT INTO neurons (id, type, content, scope, tags, source, confidence, metadata, parent_ids, constraints, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    ).run(id, entry.scope, entry.content, entry.scope, tagsJson, entry.source, entry.confidence ?? 0.5, JSON.stringify(metadata), parentIdsJson, constraintsJson, now, now);

    // Fire-and-forget embedding generation
    if (this.embeddingsAvailable) {
      this.storeEmbedding(id, entry.content).catch((err) => {
        console.error(`[anima-entity-store] embedding failed for neuron ${id}:`, err);
      });
    }

    // Auto-create synapses to parent entries (provenance edges)
    if (entry.parentIds && entry.parentIds.length > 0) {
      for (const parentId of entry.parentIds) {
        // Verify parent exists before creating synapse
        const parent = this.stmt("SELECT id FROM neurons WHERE id = ?").get(parentId);
        if (parent) {
          const synapseId = crypto.randomUUID();
          this.stmt(
            "INSERT INTO synapses (id, source_id, target_id, type, weight, metadata) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(synapseId, parentId, id, "derives_from", 1.0, JSON.stringify({ type: "provenance" }));
        }
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
      parentIds: entry.parentIds,
      constraints: entry.constraints,
    };
  }

  async recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    const topK = options?.topK ?? 10;
    const results = await this.search(query, topK * 2);

    let entries = results
      .map((r) => {
        const row = this.stmt("SELECT * FROM neurons WHERE id = ?").get(r.neuron.id) as Row | undefined;
        return row ? this.toAgentMemoryEntry(row) : null;
      })
      .filter((e): e is AgentMemoryEntry => e !== null);

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
    const maxEntries = options?.maxEntries ?? 10;

    // 1. Most recent entries
    const recent = this.stmt(
      "SELECT * FROM neurons ORDER BY created_at DESC LIMIT ?",
    ).all(maxEntries) as Row[];

    // 2. Top accessed entries
    const topAccessed = this.stmt(
      "SELECT * FROM neurons ORDER BY access_count DESC, created_at DESC LIMIT ?",
    ).all(maxEntries) as Row[];

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

  /** Remove an entry by id. No-op if id does not exist. */
  async forget(id: string): Promise<void> {
    this.deleteNeuron(id);
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------------ */
  /*  Neuron CRUD                                                        */
  /* ------------------------------------------------------------------ */

  addNeuron(
    type: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metaJson = JSON.stringify(metadata);

    this.stmt(
      "INSERT INTO neurons (id, type, content, metadata, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    ).run(id, type, content, metaJson, now, now);

    // Fire-and-forget embedding generation
    if (this.embeddingsAvailable) {
      this.storeEmbedding(id, content).catch((err) => {
        console.error(`[anima-entity-store] embedding failed for neuron ${id}:`, err);
      });
    }

    return id;
  }

  /** Insert a neuron with explicit type/scope/source (used by the Hindsight sync); embeds like remember(). */
  addNeuronRecord(n: {
    type: string;
    scope: string;
    content: string;
    tags: string[];
    source: string;
    confidence: number;
    metadata: Record<string, unknown>;
    createdAt?: string;
  }): string {
    const id = crypto.randomUUID();
    const now = n.createdAt ?? new Date().toISOString();
    this.stmt(
      "INSERT INTO neurons (id, type, content, scope, tags, source, confidence, metadata, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    ).run(id, n.type, n.content, n.scope, JSON.stringify(n.tags), n.source, n.confidence, JSON.stringify(n.metadata), now, now);
    if (this.embeddingsAvailable) {
      const pending: Promise<void> = this.storeEmbedding(id, n.content)
        .catch((err) => {
          console.error(`[anima-entity-store] embedding failed for neuron ${id}:`, err);
        })
        .finally(() => this.pendingEmbeddings.delete(pending));
      this.pendingEmbeddings.add(pending);
    }
    return id;
  }

  /** Wait for embeddings started by addNeuronRecord; call before close() or they are written to a closed DB and lost. */
  async flushEmbeddings(): Promise<void> {
    while (this.pendingEmbeddings.size > 0) await Promise.all([...this.pendingEmbeddings]);
  }

  /** Run fn in one SQLite transaction: any throw rolls back every write made inside. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Map of source -> neuron id for every neuron whose source starts with the prefix. */
  sourceIndex(prefix: string): Map<string, string> {
    const rows = this.stmt("SELECT id, source FROM neurons WHERE source LIKE ? ESCAPE '\\'").all(
      `${prefix.replace(/[\\%_]/g, "\\$&")}%`,
    ) as Array<{ id: string; source: string }>;
    return new Map(rows.map((r) => [r.source, r.id]));
  }

  getNeuron(id: string): Neuron | null {
    const row = this.stmt("SELECT * FROM neurons WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapNeuron(row) : null;
  }

  updateNeuron(
    id: string,
    content?: string,
    metadata?: Record<string, unknown>,
    confidence?: number,
  ): void {
    const existing = this.getNeuron(id);
    if (!existing) return;

    const now = new Date().toISOString();
    const newContent = content ?? existing.content;
    const newMeta = metadata
      ? JSON.stringify({ ...existing.metadata, ...metadata })
      : JSON.stringify(existing.metadata);
    this.stmt(
      "UPDATE neurons SET content = ?, metadata = ?, updated_at = ?, confidence = COALESCE(?, confidence) WHERE id = ?",
    ).run(newContent, newMeta, now, confidence ?? null, id);

    if (content && this.embeddingsAvailable) {
      this.storeEmbedding(id, content).catch((err) => {
        console.error(`[anima-entity-store] embedding failed for neuron ${id}:`, err);
      });
    }
  }

  deleteNeuron(id: string): void {
    this.stmt("DELETE FROM neurons WHERE id = ?").run(id);
  }

  listNeurons(type?: string, limit = 100, offset = 0): Neuron[] {
    let sql: string;
    let params: unknown[];

    if (type) {
      sql = "SELECT * FROM neurons WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params = [type, limit, offset];
    } else {
      sql = "SELECT * FROM neurons ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params = [limit, offset];
    }

    const rows = this.stmt(sql).all(...params) as Row[];
    return rows.map((r) => this.mapNeuron(r));
  }

  incrementAccess(id: string): void {
    this.stmt(
      "UPDATE neurons SET access_count = access_count + 1, updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), id);
  }

  /* ------------------------------------------------------------------ */
  /*  Synapse CRUD                                                       */
  /* ------------------------------------------------------------------ */

  addSynapse(
    sourceId: string,
    targetId: string,
    type: string,
    weight = 1.0,
    metadata: Record<string, unknown> = {},
  ): string {
    const id = crypto.randomUUID();
    const metaJson = JSON.stringify(metadata);

    this.stmt(
      "INSERT INTO synapses (id, source_id, target_id, type, weight, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, sourceId, targetId, type, weight, metaJson);

    return id;
  }

  getSynapses(neuronId: string): Synapse[] {
    const rows = this.stmt(
      "SELECT * FROM synapses WHERE source_id = ? OR target_id = ?",
    ).all(neuronId, neuronId) as Row[];

    return rows.map((r) => this.mapSynapse(r));
  }

  deleteSynapse(id: string): void {
    this.stmt("DELETE FROM synapses WHERE id = ?").run(id);
  }

  /* ------------------------------------------------------------------ */
  /*  Search — RRF hybrid (async for embedding generation)              */
  /* ------------------------------------------------------------------ */

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const ftsResults = this.ftsSearch(query, topK * 3);

    // Build FTS rank map (1-based rank)
    const ftsRanks = new Map<string, number>();
    for (let i = 0; i < ftsResults.length; i++) {
      ftsRanks.set(ftsResults[i].id as string, i + 1);
    }

    // Build vector rank map if embeddings available
    const vecRanks = new Map<string, number>();

    if (this.embeddingsAvailable) {
      try {
        const queryEmbedding = await this.generateEmbedding(query);
        const vecResults = this.vectorSearchWithEmbedding(queryEmbedding, topK * 3);
        for (let i = 0; i < vecResults.length; i++) {
          vecRanks.set(vecResults[i], i + 1);
        }
      } catch {
        // Graceful fallback — FTS only
      }
    }

    // Collect all candidate IDs
    const allIds = new Set([...ftsRanks.keys(), ...vecRanks.keys()]);

    // RRF scoring
    const scored: Array<{ id: string; score: number }> = [];
    for (const id of allIds) {
      let score = 0;
      if (ftsRanks.has(id)) score += 1 / (RRF_K + ftsRanks.get(id)!);
      if (vecRanks.has(id)) score += 1 / (RRF_K + vecRanks.get(id)!);
      scored.push({ id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topIds = scored.slice(0, topK);

    return topIds.map(({ id, score }) => {
      const neuron = this.getNeuron(id)!;
      return { neuron, score };
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Embedding generation                                               */
  /* ------------------------------------------------------------------ */

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingClient) {
      throw new Error("Gemini API key not configured for embeddings");
    }

    const model = this.embeddingClient.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.embeddingClient) {
      throw new Error("Gemini API key not configured for embeddings");
    }

    const model = this.embeddingClient.getGenerativeModel({ model: EMBEDDING_MODEL });
    const requests = texts.map((t) => ({ content: { role: "user", parts: [{ text: t }] }, taskType: TaskType.RETRIEVAL_DOCUMENT }));
    const result = await model.batchEmbedContents({ requests });
    return result.embeddings.map((e: { values: number[] }) => e.values);
  }

  /** Retrieve a stored embedding for a neuron. */
  getEmbedding(neuronId: string): number[] | null {
    try {
      const row = this.stmt(
        "SELECT embedding FROM embeddings WHERE neuron_id = ? AND model = ?",
      ).get(neuronId, EMBEDDING_MODEL) as Row | undefined;

      if (!row) return null;
      const blob = row.embedding as Buffer;
      const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      return Array.from(f32);
    } catch {
      return null;
    }
  }

  /** Check whether embeddings are available (API key configured). */
  get isEmbeddingAvailable(): boolean {
    return this.embeddingsAvailable;
  }

  /* ------------------------------------------------------------------ */
  /*  Phase 3b — Stats / Diagnose / Invalidate / Export / Import         */
  /* ------------------------------------------------------------------ */

  stats(): {
    total_neurons: number;
    total_synapses: number;
    total_embeddings: number;
    db_path: string;
    db_size_bytes: number;
    oldest_entry_at: string | null;
    newest_entry_at: string | null;
  } {
    const total_neurons = (this.stmt("SELECT COUNT(*) as c FROM neurons").get() as { c: number }).c;
    const total_synapses = (this.stmt("SELECT COUNT(*) as c FROM synapses").get() as { c: number }).c;
    const total_embeddings = (this.stmt("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;
    const oldest = (this.stmt("SELECT MIN(created_at) as v FROM neurons").get() as { v: string | null }).v;
    const newest = (this.stmt("SELECT MAX(created_at) as v FROM neurons").get() as { v: string | null }).v;
    let db_size_bytes = 0;
    try {
      const { statSync } = require("node:fs");
      db_size_bytes = statSync(this.dbPath).size;
    } catch { /* ok */ }
    return { total_neurons, total_synapses, total_embeddings, db_path: this.dbPath, db_size_bytes, oldest_entry_at: oldest, newest_entry_at: newest };
  }

  diagnose(): {
    total_entries: number;
    by_scope: Record<string, number>;
    low_confidence_count: number;
    stale_count: number;
    db_size_bytes: number;
  } {
    const total_entries = (this.stmt("SELECT COUNT(*) as c FROM neurons").get() as { c: number }).c;
    const rows = this.stmt("SELECT scope, type FROM neurons").all() as Array<{ scope: string | null; type: string }>;
    const by_scope: Record<string, number> = {};
    for (const r of rows) {
      const s = r.scope || r.type || "unknown";
      by_scope[s] = (by_scope[s] ?? 0) + 1;
    }
    const low_confidence_count = (this.stmt("SELECT COUNT(*) as c FROM neurons WHERE confidence < 0.4").get() as { c: number }).c;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stale_count = (this.stmt("SELECT COUNT(*) as c FROM neurons WHERE updated_at < ?").get(thirtyDaysAgo) as { c: number }).c;
    let db_size_bytes = 0;
    try {
      const { statSync } = require("node:fs");
      db_size_bytes = statSync(this.dbPath).size;
    } catch { /* ok */ }
    return { total_entries, by_scope, low_confidence_count, stale_count, db_size_bytes };
  }

  invalidateBySource(source: string): number {
    const result = this.db.run("UPDATE neurons SET confidence = 0, updated_at = ? WHERE source = ?", [new Date().toISOString(), source]);
    return result.changes;
  }

  dryRunInvalidateBySource(source: string): string[] {
    const rows = this.stmt("SELECT id FROM neurons WHERE source = ?").all(source) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  exportAll(scopes?: string[]): { neurons: unknown[]; synapses: unknown[] } {
    let neurons: unknown[];
    if (scopes && scopes.length > 0) {
      const placeholders = scopes.map(() => "?").join(", ");
      neurons = this.stmt(`SELECT * FROM neurons WHERE scope IN (${placeholders}) OR type IN (${placeholders})`).all(...scopes, ...scopes);
    } else {
      neurons = this.stmt("SELECT * FROM neurons").all();
    }
    const synapses = this.stmt("SELECT * FROM synapses").all();
    return { neurons, synapses };
  }

  listAll(scope?: string, limit = 20, offset = 0): unknown[] {
    if (scope) {
      return this.stmt("SELECT id, type, content, metadata, access_count, created_at, updated_at, scope, tags, source, confidence, parent_ids, constraints FROM neurons WHERE type = ? OR JSON_EXTRACT(metadata, '$.scope') = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(scope, scope, limit, offset);
    }
    return this.stmt("SELECT id, type, content, metadata, access_count, created_at, updated_at, scope, tags, source, confidence, parent_ids, constraints FROM neurons ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  }

  importAll(neurons: unknown[], synapses: unknown[], merge: boolean): { imported: number; skipped: number; errors: string[] } {
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const n of neurons as Array<Record<string, unknown>>) {
      try {
        const exists = this.stmt("SELECT id FROM neurons WHERE id = ?").get(n.id as string);
        if (exists && merge) { skipped++; continue; }
        this.db.run(
          "INSERT OR REPLACE INTO neurons (id, type, content, metadata, access_count, created_at, updated_at, scope, tags, source, confidence, parent_ids, constraints) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [n.id, n.type ?? "fact", n.content, n.metadata ?? "{}", n.access_count ?? 0, n.created_at ?? new Date().toISOString(), n.updated_at ?? new Date().toISOString(), n.scope ?? null, n.tags ?? "[]", n.source ?? null, n.confidence ?? 0.5, n.parent_ids ?? "[]", n.constraints ?? "[]"] as SQLQueryBindings[],
        );
        imported++;
      } catch (e) {
        errors.push(String(e));
      }
    }
    return { imported, skipped, errors };
  }

  /* ------------------------------------------------------------------ */
  /*  Phase 3b — Scratchpad                                              */
  /* ------------------------------------------------------------------ */

  scratchpadSet(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO scratchpad (key, value, updated_at) VALUES (?, ?, ?)", [key, value, new Date().toISOString()]);
  }

  scratchpadGet(key: string): { key: string; value: string | null; updated_at: string | null } {
    const row = this.stmt("SELECT key, value, updated_at FROM scratchpad WHERE key = ?").get(key) as { key: string; value: string; updated_at: string } | undefined;
    return row ? { key: row.key, value: row.value, updated_at: row.updated_at } : { key, value: null, updated_at: null };
  }

  scratchpadDelete(key?: string): number {
    if (key) {
      const result = this.db.run("DELETE FROM scratchpad WHERE key = ?", [key]);
      return result.changes;
    }
    const result = this.db.run("DELETE FROM scratchpad");
    return result.changes;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — FTS search                                              */
  /* ------------------------------------------------------------------ */

  private ftsSearch(query: string, limit: number): Row[] {
    const safe = query.replace(/["'*+^:~()-]/g, " ").trim();
    if (!safe) return [];

    try {
      return this.stmt(
        `SELECT n.* FROM neurons n
         JOIN neurons_fts f ON n.rowid = f.rowid
         WHERE neurons_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(safe, limit) as Row[];
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — Vector search with precomputed query embedding          */
  /* ------------------------------------------------------------------ */

  private vectorSearchWithEmbedding(queryEmbedding: number[], limit: number): string[] {
    const rows = this.stmt(
      "SELECT neuron_id, embedding FROM embeddings WHERE model = ?",
    ).all(EMBEDDING_MODEL) as Row[];

    if (rows.length === 0) return [];

    const scored: Array<{ id: string; score: number }> = [];

    for (const row of rows) {
      const blob = row.embedding as Buffer;
      const stored = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      const sim = cosineSimilarity(queryEmbedding, Array.from(stored));
      scored.push({ id: row.neuron_id as string, score: sim });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.id);
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — Embedding storage                                       */
  /* ------------------------------------------------------------------ */

  private async storeEmbedding(neuronId: string, text: string): Promise<void> {
    try {
      const values = await this.generateEmbedding(text);
      const f32 = new Float32Array(values);
      const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

      this.stmt(
        "INSERT OR REPLACE INTO embeddings (neuron_id, embedding, model) VALUES (?, ?, ?)",
      ).run(neuronId, buf, EMBEDDING_MODEL);
    } catch {
      // Graceful fallback
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — Prepared statement cache                                */
  /* ------------------------------------------------------------------ */

  private stmt(sql: string): Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — Row mapping                                             */
  /* ------------------------------------------------------------------ */

  /** Map a database row to AgentMemoryEntry for the memory contract. */
  private toAgentMemoryEntry(row: Row): AgentMemoryEntry {
    const meta = parseMeta(row.metadata as string | undefined);
    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags as string); } catch { tags = []; }
    } else if (meta._tags) {
      tags = meta._tags as string[];
    }
    let parentIds: string[] | undefined;
    if (row.parent_ids) {
      try { parentIds = JSON.parse(row.parent_ids as string); } catch { parentIds = undefined; }
    }
    let constraints: string[] | undefined;
    if (row.constraints) {
      try { constraints = JSON.parse(row.constraints as string); } catch { constraints = undefined; }
    }
    return {
      id: row.id as string,
      content: row.content as string,
      scope: (row.scope || row.type || "fact") as MemoryScope,
      tags,
      confidence: (row.confidence as number) ?? 0.5,
      source: (row.source || (meta._source as string) || "unknown") as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string | undefined,
      metadata: meta,
      parentIds,
      constraints,
    };
  }

  private mapNeuron(row: Row): Neuron {
    return {
      id: row.id as string,
      type: row.type as string,
      content: row.content as string,
      metadata: JSON.parse((row.metadata as string) || "{}"),
      accessCount: row.access_count as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapSynapse(row: Row): Synapse {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      type: row.type as string,
      weight: row.weight as number,
      metadata: JSON.parse((row.metadata as string) || "{}"),
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Utility                                                            */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function parseMeta(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
