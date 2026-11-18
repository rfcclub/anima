// ---------------------------------------------------------------------------
// BunContextEngine — lightweight context engine using bun:sqlite
// ---------------------------------------------------------------------------
// Wraps @anima/context-engine's ConversationStore and SummaryStore with a
// Bun-native SQLite backend. Creates/manages ~/.anima/rooms/<name>/context.db
// (the ANIMA server's store — ~/.anima/agents/ belongs to the OpenClaw CLI adapter).
//
// Used by:
//   - server.ts chat handler: ingests messages each turn → lcm_grep searchable
//   - executor.ts: passed as ContextEngine for anima_context_* tools
//   - executor.ts handleLcmTool: reads context.db directly (no engine needed)
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configureMemoryWal } from "./sqlite-wal";
import {
  ConversationStore,
  SummaryStore,
  ContextAssembler,
  runMigrations,
  type MessageRecord,
  type SearchOptions,
  type SearchResult,
  type IntegrityReport,
} from "@anima/context-engine";

// ---------------------------------------------------------------------------
// Public interface (subset of ContextEngine we actually use)
// ---------------------------------------------------------------------------

export interface BunContextEngine {
  /** Ensure DB is ready, run migrations, open connection. */
  initialize(agentId: string, platform: string): Promise<void>;

  /** Store a single message in the given conversation. Creates conv if needed.
   *  Accepts both the ContextEngine IngestInput shape ({ conversationId,
   *  message }) and the two-arg (conversationId, message) shape. */
  ingest(
    conversationIdOrInput: string | { conversationId: string; message: MessageRecord },
    message?: MessageRecord,
  ): Promise<void>;

  /** Search across messages and summaries. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  /** Get DB stats. */
  checkIntegrity(): Promise<IntegrityReport>;

  /** Close the DB connection. */
  dispose(): void;

  /** Expose for anima_context_* tools. */
  getDb(): Database;

  /** Assemble context for a prompt (anima_context_describe). */
  assemble(conversationId: string, prompt?: string, tokenBudget?: number): {
    messages: MessageRecord[];
    estimatedTokens: number;
    freshTailCount: number;
    systemPromptAddition?: string;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BunContextEngineImpl implements BunContextEngine {
  private db: Database | null = null;
  private conversationStore: ConversationStore | null = null;
  private summaryStore: SummaryStore | null = null;
  private assembler: ContextAssembler | null = null;
  private initialized = false;
  private agentId = "";
  private platform = "";

  constructor(private readonly dbPath: string) {}

  async initialize(agentId: string, platform: string): Promise<void> {
    if (this.initialized) return;

    this.agentId = agentId;
    this.platform = platform;

    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(this.dbPath);
    try {
      await configureMemoryWal(this.db);
      this.db.exec("PRAGMA foreign_keys = ON");

      // Run schema migrations
      runMigrations(this.db);

      // Initialize stores — bun:sqlite Database is directly compatible
      // with { prepare, exec } interface expected by the stores
      this.conversationStore = new ConversationStore(this.db as unknown as {
        prepare: (sql: string) => StatementLike;
        exec?: (sql: string) => void;
      });
      this.summaryStore = new SummaryStore(this.db as unknown as {
        prepare: (sql: string) => StatementLike;
      });

      // ContextAssembler for anima_context_describe
      this.assembler = new ContextAssembler(
        this.conversationStore,
        this.summaryStore,
        64, // freshTailCount
      );

      this.initialized = true;
    } catch (error) {
      this.db.close();
      this.db = null;
      this.conversationStore = null;
      this.summaryStore = null;
      this.assembler = null;
      throw error;
    }
  }

  async ingest(
    conversationIdOrInput: string | { conversationId: string; message: MessageRecord },
    message?: MessageRecord,
  ): Promise<void> {
    if (!this.initialized || !this.conversationStore) return;

    // Normalize both call shapes:
    //  - ContextEngine interface (session.ts:435): one IngestInput object
    //    { conversationId, message }
    //  - BunContextEngine interface (talk.ts:860): two args (conversationId,
    //    message)
    // Without this, passing the object as `conversationId` corrupts the
    // INSERT bind and throws `NOT NULL constraint failed:
    // conversations.agent_id`.
    const convId =
      typeof conversationIdOrInput === "string"
        ? conversationIdOrInput
        : conversationIdOrInput.conversationId;
    const msg =
      typeof conversationIdOrInput === "string" ? message! : conversationIdOrInput.message;

    // Ensure conversation exists
    const existing = this.conversationStore.getConversation(convId);
    if (!existing) {
      this.conversationStore.createConversation({
        conversationId: convId,
        agentId: this.agentId,
        platform: this.platform,
      });
    }

    // Store message — enriches with conversation_id
    this.conversationStore.addMessage({
      ...msg,
      conversation_id: convId,
    });
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    if (!this.initialized || !this.db) return [];

    const results: SearchResult[] = [];
    const scope = opts?.scope ?? "both";
    const limit = opts?.limit ?? 50;
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];

    if (scope === "both" || scope === "messages") {
      try {
        const rows = this.db
          .query(
            `SELECT m.message_id AS id, m.content, m.created_at FROM messages m
             JOIN messages_fts f ON m.rowid = f.rowid
             WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(`"${safe}"`, limit) as Array<{
          id: string;
          content: string;
          created_at: string;
        }>;
        for (const row of rows) {
          results.push({
            type: "message",
            id: row.id,
            content: row.content ?? "",
            snippet: truncateSnippet(row.content ?? ""),
            created_at: row.created_at,
          });
        }
      } catch {
        // FTS may not exist yet
      }
    }

    if (scope === "both" || scope === "summaries") {
      try {
        const rows = this.db
          .query(
            `SELECT s.summary_id AS id, s.content, s.created_at FROM summaries s
             JOIN summaries_fts f ON s.rowid = f.rowid
             WHERE summaries_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(`"${safe}"`, limit) as Array<{
          id: string;
          content: string;
          created_at: string;
        }>;
        for (const row of rows) {
          results.push({
            type: "summary",
            id: row.id,
            content: row.content ?? "",
            snippet: truncateSnippet(row.content ?? ""),
            created_at: row.created_at,
          });
        }
      } catch {
        // FTS may not exist yet
      }
    }

    return results.slice(0, limit);
  }

  assemble(
    conversationId: string,
    prompt?: string,
    tokenBudget?: number,
  ): {
    messages: MessageRecord[];
    estimatedTokens: number;
    freshTailCount: number;
    systemPromptAddition?: string;
  } {
    if (!this.initialized || !this.assembler) {
      return { messages: [], estimatedTokens: 0, freshTailCount: 0 };
    }
    return this.assembler.assemble(conversationId, prompt, tokenBudget);
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    if (!this.initialized || !this.db) {
      return { healthy: false, checks: [] };
    }

    const checks: IntegrityReport["checks"] = [];
    try {
      const convCount = (
        this.db.query("SELECT COUNT(*) as c FROM conversations").get() as {
          c: number;
        }
      ).c;
      checks.push({ name: "conversations", passed: true, detail: `${convCount} conversations` });
    } catch (e) {
      checks.push({ name: "conversations", passed: false, detail: String(e) });
    }

    try {
      const msgCount = (
        this.db.query("SELECT COUNT(*) as c FROM messages").get() as {
          c: number;
        }
      ).c;
      checks.push({ name: "messages", passed: true, detail: `${msgCount} messages` });
    } catch (e) {
      checks.push({ name: "messages", passed: false, detail: String(e) });
    }

    try {
      const sumCount = (
        this.db.query("SELECT COUNT(*) as c FROM summaries").get() as {
          c: number;
        }
      ).c;
      checks.push({ name: "summaries", passed: true, detail: `${sumCount} summaries` });
    } catch (e) {
      checks.push({ name: "summaries", passed: false, detail: String(e) });
    }

    const healthy = checks.every((c) => c.passed);
    return { healthy, checks };
  }

  getDb(): Database {
    if (!this.db) throw new Error("Context engine not initialized");
    return this.db;
  }

  dispose(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // best-effort
      }
      this.db = null;
    }
    this.conversationStore = null;
    this.summaryStore = null;
    this.initialized = false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Path to per-agent context database. */
export function perAgentContextDb(agentName: string): string {
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  return join(homedir(), ".anima", "rooms", agentName, "context.db");
}

/**
 * Create and initialize a BunContextEngine for the given agent.
 * Returns undefined if the DB file can't be opened (non-fatal).
 */
export async function createBunContextEngine(
  agentName: string,
): Promise<BunContextEngine | undefined> {
  const dbPath = perAgentContextDb(agentName);
  const engine = new BunContextEngineImpl(dbPath);
  try {
    await engine.initialize(agentName, "anima");
    return engine;
  } catch (err) {
    console.error(
      `[context-store] BunContextEngine init failed for ${agentName}: ${err}`,
    );
    try {
      engine.dispose();
    } catch {
      // best-effort
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/["'*+^:~()-]/g, " ")
    .trim()
    .replace(/"/g, "");
}

function truncateSnippet(content: string, maxLen = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.substring(0, maxLen - 3) + "...";
}

// Minimal statement interface (bun:sqlite Statement satisfies this)
interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
