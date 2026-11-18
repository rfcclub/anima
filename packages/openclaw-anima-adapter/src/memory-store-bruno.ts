/**
 * MemoryStoreBruno — AnimaMemoryStore that connects to bruno-entity's shared DB.
 *
 * Schema matches bruno-entity: INTEGER PK, type (scope), metadata JSON,
 * fts_neurons (FTS5). Multi-agent via agent_id column.
 *
 * DB path: <bruno-entity checkout>/data/bruno.db
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

import type { MemoryScope } from "./types.js";
export type { MemoryScope };

export interface AgentMemoryEntry {
  id: number;
  content: string;
  scope: MemoryScope;
  tags: string[];
  confidence: number;
  source: string;
  agentId?: string;
  state?: string;
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

export type EmbeddingFn = (text: string) => Promise<number[]>;

/* ------------------------------------------------------------------ */
/*  Row type (internal)                                                */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/*  MemoryStoreBruno                                                    */
/* ------------------------------------------------------------------ */

/** Resolve the shared memory DB path for Bruno. */
export function resolveBrunoMemoryDbPath(): string {
  const envPath = process.env.ANIMA_BRUNO_MEMORY_DB;
  if (envPath) return envPath;
  return join(homedir(), "work", "bruno-entity", "data", "bruno.db");
}

export class MemoryStoreBruno {
  private db!: DatabaseSync;
  private initialized = false;
  private embeddingFn: EmbeddingFn | null = null;
  private embeddingModel = "unknown";

  constructor(
    private readonly dbPath: string,
    private agentId: string = "bruno",
  ) {}

  setEmbeddingFn(fn: EmbeddingFn, model = "external"): void {
    this.embeddingFn = fn;
    this.embeddingModel = model;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // bruno-entity creates tables; we only ensure scratchpad + anima_embeddings exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scratchpad (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anima_embeddings (
        neuron_id INTEGER NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        PRIMARY KEY (neuron_id, model)
      )
    `);

    // Ensure agent_id column exists (for multi-agent in shared DB)
    try { this.db.exec("ALTER TABLE neurons ADD COLUMN agent_id TEXT"); } catch { /* exists */ }

    this.initialized = true;
  }

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    this.ensureInitialized();
    const now = new Date().toISOString();
    const neuronType = entry.scope ?? "fact";

    const extraMeta: Record<string, unknown> = {};
    if (entry.tags?.length) extraMeta._tags = entry.tags;
    if (entry.source) extraMeta._source = entry.source;
    if (entry.confidence !== undefined) extraMeta._confidence = entry.confidence;
    if (this.agentId) extraMeta._agent_id = this.agentId;

    const combinedMeta = { ...(entry.metadata ?? {}), ...extraMeta };
    const result = this.db.prepare(
      `INSERT INTO neurons (type, content, metadata, state, access_count, created_at, last_active, agent_id)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`,
    ).run(neuronType, entry.content, JSON.stringify(combinedMeta), now, now, this.agentId || null);

    if (this.embeddingFn) {
      try {
        const vec = await this.embeddingFn(entry.content);
        const buf = Buffer.allocUnsafe(vec.length * 4);
        for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
        this.db.prepare(
          "INSERT OR REPLACE INTO anima_embeddings (neuron_id, embedding, model) VALUES (?, ?, ?)",
        ).run(result.lastInsertRowid, buf, this.embeddingModel);
      } catch { /* non-fatal */ }
    }

    return {
      id: Number(result.lastInsertRowid),
      content: entry.content,
      scope: entry.scope ?? "fact",
      tags: entry.tags ?? [],
      confidence: entry.confidence ?? 0.5,
      source: entry.source ?? this.agentId,
      agentId: this.agentId,
      state: "active",
      createdAt: now,
      metadata: combinedMeta,
    };
  }

  async recall(query: string, options?: RecallOptions): Promise<AgentMemoryEntry[]> {
    this.ensureInitialized();
    const topK = options?.topK ?? 10;
    const results = await this.search(query, topK * 2);
    let entries = results.map((r) => this.toEntry(r.neuron));

    if (options?.scopes?.length) entries = entries.filter((e) => options.scopes!.includes(e.scope));
    if (options?.minConfidence !== undefined) entries = entries.filter((e) => e.confidence >= options.minConfidence!);
    if (options?.offset !== undefined) entries = entries.slice(options.offset);

    return entries.slice(0, topK);
  }

  async bootstrap(options?: BootstrapOptions): Promise<AgentMemoryEntry[]> {
    this.ensureInitialized();
    const maxEntries = options?.maxEntries ?? 10;
    const recent = this.db.prepare(
      "SELECT * FROM neurons WHERE agent_id = ? OR agent_id IS NULL ORDER BY created_at DESC LIMIT ?",
    ).all(this.agentId, maxEntries) as Row[];
    const top = this.db.prepare(
      "SELECT * FROM neurons WHERE agent_id = ? OR agent_id IS NULL ORDER BY access_count DESC, created_at DESC LIMIT ?",
    ).all(this.agentId, maxEntries) as Row[];

    const seen = new Set<number>();
    const results: AgentMemoryEntry[] = [];
    for (const rows of [top, recent]) {
      for (const row of rows) {
        const entry = this.toEntry(row);
        if (!seen.has(entry.id)) { seen.add(entry.id); results.push(entry); }
      }
    }
    return results.slice(0, maxEntries);
  }

  async forget(id: string | number): Promise<void> {
    this.ensureInitialized();
    const numericId = typeof id === "string" ? parseInt(id, 10) : id;
    if (isNaN(numericId)) {
      this.db.prepare(
        "DELETE FROM neurons WHERE CAST(id AS TEXT) = ? AND (agent_id = ? OR agent_id IS NULL)",
      ).run(String(id), this.agentId);
    } else {
      this.db.prepare(
        "DELETE FROM neurons WHERE id = ? AND (agent_id = ? OR agent_id IS NULL)",
      ).run(numericId, this.agentId);
    }
  }

  close(): void {
    if (this.initialized) { try { this.db.close(); } catch { /* ok */ } this.initialized = false; }
  }

  getDbPath(): string { return this.dbPath; }
  getDb(): DatabaseSync { this.ensureInitialized(); return this.db; }

  getStats(): Record<string, unknown> {
    this.ensureInitialized();
    const n = this.db.prepare(
      "SELECT COUNT(*) as c FROM neurons WHERE agent_id = ? OR agent_id IS NULL",
    ).get(this.agentId) as { c: number };
    const s = this.db.prepare("SELECT COUNT(*) as c FROM synapses").get() as { c: number };
    const e = this.db.prepare("SELECT COUNT(*) as c FROM anima_embeddings").get() as { c: number };
    return { total_neurons: n.c, total_synapses: s.c, total_embeddings: e.c, db_path: this.dbPath, agent_id: this.agentId };
  }

  diagnose(): Record<string, unknown> {
    this.ensureInitialized();
    const rows = this.db.prepare(
      "SELECT type, COUNT(*) as c FROM neurons WHERE agent_id = ? OR agent_id IS NULL GROUP BY type",
    ).all(this.agentId) as Array<{ type: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.type] = r.c;
    return { total_entries: rows.reduce((s, r) => s + r.c, 0), by_type: byType };
  }

  /* ── Scratchpad ── */
  scratchpadSet(key: string, value: string): void {
    this.ensureInitialized();
    this.db.prepare(
      "INSERT OR REPLACE INTO scratchpad (key, value, updated_at) VALUES (?, ?, ?)",
    ).run(key, value, new Date().toISOString());
  }
  scratchpadGet(key: string): { key: string; value: string | null; updated_at: string | null } {
    this.ensureInitialized();
    const row = this.db.prepare("SELECT * FROM scratchpad WHERE key = ?").get(key) as Row | undefined;
    return row ? { key: row.key as string, value: row.value as string, updated_at: row.updated_at as string } : { key, value: null, updated_at: null };
  }
  scratchpadDelete(key?: string): number {
    this.ensureInitialized();
    if (key) { this.db.prepare("DELETE FROM scratchpad WHERE key = ?").run(key); return 1; }
    const c = this.db.prepare("SELECT COUNT(*) as c FROM scratchpad").get() as { c: number };
    this.db.exec("DELETE FROM scratchpad");
    return c.c;
  }

  /* ── Internal ── */
  private async search(query: string, topK: number): Promise<Array<{ neuron: Row; score: number }>> {
    const safe = query.replace(/["'*+^:~()-]/g, " ").trim();
    const tokens = safe.split(/\s+/).filter(Boolean);
    let ftsResults: Row[] = [];
    if (tokens.length > 0) {
      // Join tokens with OR so any matching word scores — RRF fusion handles ranking
      const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      try {
        ftsResults = this.db.prepare(
          `SELECT n.* FROM neurons n JOIN fts_neurons f ON n.rowid = f.rowid
           WHERE fts_neurons MATCH ? AND (n.agent_id = ? OR n.agent_id IS NULL)
           ORDER BY rank LIMIT ?`,
        ).all(ftsQuery, this.agentId, topK * 2) as Row[];
      } catch { /* FTS fail → empty */ }
    }

    const ftsRanks = new Map<string, number>();
    ftsResults.forEach((r, i) => ftsRanks.set(String(r.id), i + 1));

    // Vector search — join with neurons to scope by agent_id
    const vecRanks = new Map<string, number>();
    if (this.embeddingFn) {
      try {
        const qv = await this.embeddingFn(query);
        const rows = this.db.prepare(
          `SELECT ae.neuron_id, ae.embedding
           FROM anima_embeddings ae
           JOIN neurons n ON n.id = ae.neuron_id
           WHERE ae.model = ? AND (n.agent_id = ? OR n.agent_id IS NULL)`,
        ).all(this.embeddingModel, this.agentId) as Array<{ neuron_id: number; embedding: Buffer }>;
        const scored = rows.map((r) => ({ id: r.neuron_id, sim: cosineSim(qv, bufToVec(r.embedding)) }));
        scored.sort((a, b) => b.sim - a.sim);
        scored.forEach((s, i) => vecRanks.set(String(s.id), i + 1));
      } catch { /* fallback to FTS */ }
    }

    // RRF fusion
    const K = 60;
    const allIds = new Set([...ftsRanks.keys(), ...vecRanks.keys()]);
    const scored = [...allIds].map((id) => {
      let score = 0;
      if (ftsRanks.has(id)) score += 1 / (K + ftsRanks.get(id)!);
      if (vecRanks.has(id)) score += 1 / (K + vecRanks.get(id)!);
      return { id, score };
    });
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(({ id, score }) => ({
      neuron: this.db.prepare("SELECT * FROM neurons WHERE id = ?").get(parseInt(id, 10)) as Row,
      score,
    })).filter((r) => r.neuron);
  }

  private toEntry(row: Row): AgentMemoryEntry {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse((row.metadata as string) ?? "{}"); } catch { /* ok */ }
    return {
      id: row.id as number,
      content: row.content as string,
      scope: ((row.type as string) || "fact") as MemoryScope,
      tags: (Array.isArray(meta._tags) ? meta._tags : []) as string[],
      confidence: (typeof meta._confidence === "number" ? meta._confidence : 0.5) as number,
      source: (meta._source as string) ?? (row.agent_id as string) ?? "unknown",
      agentId: (row.agent_id as string) ?? (meta._agent_id as string),
      state: (row.state as string) ?? "active",
      createdAt: row.created_at as string,
      updatedAt: row.last_active as string | undefined,
      metadata: meta,
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error("MemoryStoreBruno not initialized. Call initialize() first.");
  }
}

function bufToVec(buf: Buffer): number[] {
  const out = new Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
