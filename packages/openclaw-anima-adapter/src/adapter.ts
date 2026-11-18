/**
 * AnimaContextEngineAdapter — wraps @anima/context-engine stores
 * as an OpenClaw context engine adapter.
 *
 * Delegates to ConversationStore, SummaryStore, CompactionEngine, and
 * ContextAssembler from @anima/context-engine. Uses node:sqlite (DatabaseSync).
 */

import {
  ConversationStore,
  SummaryStore,
  CompactionEngine,
  ContextAssembler,
  runMigrations,
  DEFAULT_COMPACTION_CONFIG,
  type MessageRecord,
  type SummaryProvider,
  type CompactionConfig,
  type BootstrapInput,
  type BootstrapResult,
  type IngestInput,
  type AssembleInput,
  type AssembleResult,
  type CompactInput,
  type CompactResult,
  type SearchOptions,
  type SearchResult,
  type IntegrityReport,
  estimateTokens,
  truncateTextToEstimatedTokens,
  type MessagePartInput,
} from "@anima/context-engine";
import type { CompactionResult } from "@anima/context-engine";

/** Runtime context passed by OpenClaw during compaction, containing per-call LLM access. */
interface RuntimeContext {
  llm?: {
    complete: (params: {
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      agentId?: string;
    }) => Promise<{
      content: string;
      model?: string;
      usage?: { inputTokens: number; outputTokens: number };
    }>;
  };
}
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/* ------------------------------------------------------------------ */
/*  Logger interface                                                   */
/* ------------------------------------------------------------------ */

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/* ------------------------------------------------------------------ */
/*  StatementLike — compatible with ConversationStore's internal type  */
/* ------------------------------------------------------------------ */

interface StatementLike {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Create a duck-typed wrapper for node:sqlite DatabaseSync that satisfies
 *  the StatementLike interface expected by @anima/context-engine stores. */
function makeStoreDb(
  db: DatabaseSync,
): { prepare: (sql: string) => StatementLike; exec?: (sql: string) => void } {
  return {
    prepare(sql: string): StatementLike {
      const raw = db.prepare(sql) as unknown as {
        run(...args: unknown[]): { changes: number };
        get(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown[];
      };
      return { run: (...args) => raw.run(...args), get: (...args) => raw.get(...args), all: (...args) => raw.all(...args) };
    },
    exec(sql: string) {
      db.exec(sql);
    },
  };
}

/** Create a duck-typed wrapper for SummaryStore (needs only prepare). */
function makeSummaryStoreDb(db: DatabaseSync): { prepare: (sql: string) => StatementLike } {
  return {
    prepare(sql: string): StatementLike {
      const raw = db.prepare(sql) as unknown as {
        run(...args: unknown[]): { changes: number };
        get(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown[];
      };
      return { run: (...args) => raw.run(...args), get: (...args) => raw.get(...args), all: (...args) => raw.all(...args) };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Row type                                                           */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/*  AnimaContextEngineAdapter                                          */
/* ------------------------------------------------------------------ */

export class AnimaContextEngineAdapter {
  private db: DatabaseSync | null = null;
  private conversationStore: ConversationStore | null = null;
  private summaryStore: SummaryStore | null = null;
  private compactionEngine: CompactionEngine | null = null;
  private assembler: ContextAssembler | null = null;
  private summaryProvider: SummaryProvider | null = null;
  private compactionConfig: CompactionConfig = DEFAULT_COMPACTION_CONFIG;
  private initialized = false;
  private agentId = "";
  private platform = "";
  private logger: Logger;

  constructor(private readonly contextDbPath: string, log?: Logger) {
    this.logger = log ?? noopLogger;
  }

  /** Configure the summary provider (LLM) used by the compaction engine. */
  setSummaryProvider(provider: SummaryProvider): void {
    this.summaryProvider = provider;
    // Rebuild engine if already initialized
    if (this.initialized && this.conversationStore && this.summaryStore) {
      this.compactionEngine = new CompactionEngine(
        this.conversationStore,
        this.summaryStore,
        provider,
        this.compactionConfig,
      );
    }
  }

  /** Override default compaction config. */
  setCompactionConfig(config: Partial<CompactionConfig>): void {
    this.compactionConfig = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  /* ------------------------------------------------------------------ */
  /*  ContextEngine interface implementation                             */
  /* ------------------------------------------------------------------ */

  async initialize(agentId: string, platform: string): Promise<void> {
    if (this.initialized) return;

    this.agentId = agentId;
    this.platform = platform;

    const dir = dirname(this.contextDbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database with WAL mode
    this.db = new DatabaseSync(this.contextDbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Run schema migrations
    runMigrations(this.db);

    // Initialize stores with compatible wrappers
    const convDb = makeStoreDb(this.db);
    const sumDb = makeSummaryStoreDb(this.db);

    this.conversationStore = new ConversationStore(convDb);
    this.summaryStore = new SummaryStore(sumDb);

    // CompactionEngine needs a SummaryProvider. If none is set, we create
    // one that returns a placeholder (compaction will be no-op without it).
    const provider = this.summaryProvider ?? createNoopProvider();

    this.compactionEngine = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      provider,
      this.compactionConfig,
    );

    // ContextAssembler(convStore, summaryStore, freshTailCount)
    this.assembler = new ContextAssembler(
      this.conversationStore,
      this.summaryStore,
      this.compactionConfig.freshTailCount,
    );

    this.initialized = true;
    this.logger.info(
      `[anima] Context engine initialized: db=${this.contextDbPath} agent=${agentId}`,
    );
  }

  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    this.ensureInitialized();

    const conversationId = input.conversationId ?? crypto.randomUUID();

    const existing = this.conversationStore!.getConversation(conversationId);
    if (!existing) {
      this.conversationStore!.createConversation({
        conversationId,
        agentId: this.agentId,
        platform: this.platform,
      });
    }

    let importedCount = 0;
    if (input.messages && input.messages.length > 0) {
      for (const msg of input.messages) {
        const enriched = { 
          ...msg, 
          conversation_id: conversationId,
          token_count: msg.token_count ?? estimateTokens(msg.content ?? ''),
        };
        this.conversationStore!.addMessage(enriched as MessageRecord);
        importedCount++;
      }
    }

    return { importedCount, conversationId };
  }

  async ingest(input: IngestInput): Promise<void> {
    this.ensureInitialized();

    const existing = this.conversationStore!.getConversation(input.conversationId);
    if (!existing) {
      this.conversationStore!.createConversation({
        conversationId: input.conversationId,
        agentId: this.agentId,
        platform: this.platform,
      });
    }

    const message = {
      ...input.message,
      token_count: input.message.token_count ?? estimateTokens(input.message.content ?? ''),
    };
    this.conversationStore!.addMessage(message);

    // Build structured message_parts from the raw agent message (lossless-claw parity)
    if (input.rawAgentMessage && input.sessionId) {
      try {
        const parts = buildMessageParts({
          sessionId: input.sessionId,
          message: input.rawAgentMessage,
          fallbackContent: message.content ?? '',
        });
        if (parts.length > 0) {
          this.conversationStore!.addMessageParts(message.id, input.sessionId, parts);
        }
      } catch {
        // message_parts are best-effort — don't fail ingest for them
      }
    }
  }

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    this.ensureInitialized();
    // ContextAssembler.assemble takes (conversationId, prompt?, tokenBudget?)
    const result = this.assembler!.assemble(input.conversationId, input.prompt, input.tokenBudget);
    return {
      messages: result.messages,
      estimatedTokens: result.estimatedTokens,
      freshTailCount: result.freshTailCount,
      systemPromptAddition: result.systemPromptAddition,
    };
  }

  async compact(input: CompactInput): Promise<CompactResult> {
    this.ensureInitialized();
    // CompactionEngine.compact takes (conversationId, targetTokens, currentTokens?)
    const targetTokens = input.targetTokens ?? this.compactionConfig.condensedTargetTokens;
    
    // Use OpenClaw's per-compaction runtime LLM if available (passed via runtimeContext)
    // This is the correct provider for compaction - it has proper agent context, auth, etc.
    const runtimeCtx = input as CompactInput & { runtimeContext?: RuntimeContext };
    let provider: SummaryProvider = this.summaryProvider ?? createNoopProvider();
    
    if (runtimeCtx.runtimeContext?.llm?.complete) {
      const logger = this.logger;
      provider = {
        async complete(params) {
          try {
            return await runtimeCtx.runtimeContext!.llm!.complete({
              system: params.system,
              messages: params.messages,
              model: params.model,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn?.(`[anima] runtimeContext LLM error, falling back: ${msg}`);
            return { content: "" };
          }
        },
      };
    } else if (!this.summaryProvider) {
      // DETERMINISTIC FALLBACK: no runtime LLM available — truncate instead of no-op
      // This ensures compaction still runs and prevents "Auto-compaction could not recover" errors
      const logger = this.logger;
      provider = {
        async complete(params) {
          const formatted = params.messages
            .map((m) => `[${m.role}]: ${m.content}`)
            .join("\n\n");
          const maxTokens = params.maxTokens ?? targetTokens;
          const truncated = truncateTextToEstimatedTokens(formatted, maxTokens);
          logger.warn?.(
            `[anima] No LLM available for compaction — using deterministic truncation (${estimateTokens(formatted)} -> ~${estimateTokens(truncated)} tokens)`
          );
          return { content: truncated };
        },
      };
    }

    // Temporarily swap provider for this compaction call
    const originalEngine = this.compactionEngine;
    if (provider !== this.summaryProvider && provider !== createNoopProvider()) {
      this.compactionEngine = new CompactionEngine(
        this.conversationStore!,
        this.summaryStore!,
        provider,
        this.compactionConfig,
      );
    }

    const result: CompactionResult = await this.compactionEngine!.compact(
      input.conversationId,
      targetTokens,
      input.currentTokens,
    );

    // Restore original engine if we swapped
    if (provider !== this.summaryProvider && provider !== createNoopProvider()) {
      this.compactionEngine = originalEngine;
    }

    return {
      compacted: result.actionTaken,
      summariesCreated: result.summariesCreated,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    this.ensureInitialized();

    const results: SearchResult[] = [];
    const scope = opts?.scope ?? "both";
    const limit = opts?.limit ?? 50;

    if (scope === "both" || scope === "messages") {
      try {
        const messages = this.queryMessagesFts(query, opts?.conversationId, limit);
        for (const msg of messages) {
          const content = (msg.content as string) ?? "";
          results.push({
            type: "message",
            id: msg.message_id as string,
            content,
            snippet: truncateSnippet(content),
            created_at: msg.created_at as string,
          });
        }
      } catch {
        // best-effort
      }
    }

    if (scope === "both" || scope === "summaries") {
      try {
        const summaries = this.querySummariesFts(query, opts?.conversationId, limit);
        for (const s of summaries) {
          const content = s.content as string;
          results.push({
            type: "summary",
            id: s.summary_id as string,
            content,
            snippet: truncateSnippet(content),
            created_at: s.created_at as string,
          });
        }
      } catch {
        // best-effort
      }
    }

    return results.slice(0, limit);
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    this.ensureInitialized();

    const checks: IntegrityReport["checks"] = [];

    try {
      const convCount = (
        this.db!.prepare("SELECT COUNT(*) as c FROM conversations").get() as { c: number }
      ).c;
      checks.push({ name: "conversations", passed: true, detail: `${convCount} conversations` });
    } catch (e) {
      checks.push({ name: "conversations", passed: false, detail: String(e) });
    }

    try {
      const msgCount = (
        this.db!.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }
      ).c;
      checks.push({ name: "messages", passed: true, detail: `${msgCount} messages` });
    } catch (e) {
      checks.push({ name: "messages", passed: false, detail: String(e) });
    }

    try {
      const sumCount = (
        this.db!.prepare("SELECT COUNT(*) as c FROM summaries").get() as { c: number }
      ).c;
      checks.push({ name: "summaries", passed: true, detail: `${sumCount} summaries` });
    } catch (e) {
      checks.push({ name: "summaries", passed: false, detail: String(e) });
    }

    try {
      this.db!.prepare("SELECT 1 FROM messages_fts LIMIT 1").get();
      this.db!.prepare("SELECT 1 FROM summaries_fts LIMIT 1").get();
      checks.push({ name: "full_text_search", passed: true, detail: "FTS tables accessible" });
    } catch (e) {
      checks.push({ name: "full_text_search", passed: false, detail: String(e) });
    }

    const healthy = checks.every((c) => c.passed);
    return { healthy, checks };
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
    this.compactionEngine = null;
    this.assembler = null;
    this.initialized = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — FTS queries on context.db                               */
  /* ------------------------------------------------------------------ */

  private queryMessagesFts(query: string, conversationId?: string, limit: number = 50): Row[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];

    if (conversationId) {
      return this.db!
        .prepare(
          `SELECT m.* FROM messages m
           JOIN messages_fts f ON m.rowid = f.rowid
           WHERE messages_fts MATCH ? AND m.conversation_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(`"${safe}"`, conversationId, limit) as Row[];
    }

    return this.db!
      .prepare(
        `SELECT m.* FROM messages m
         JOIN messages_fts f ON m.rowid = f.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(`"${safe}"`, limit) as Row[];
  }

  private querySummariesFts(query: string, conversationId?: string, limit: number = 50): Row[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];

    if (conversationId) {
      return this.db!
        .prepare(
          `SELECT s.* FROM summaries s
           JOIN summaries_fts f ON s.rowid = f.rowid
           WHERE summaries_fts MATCH ? AND s.conversation_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(`"${safe}"`, conversationId, limit) as Row[];
    }

    return this.db!
      .prepare(
        `SELECT s.* FROM summaries s
         JOIN summaries_fts f ON s.rowid = f.rowid
         WHERE summaries_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(`"${safe}"`, limit) as Row[];
  }

  /* ------------------------------------------------------------------ */
  /*  Public accessors for tools                                          */
  /* ------------------------------------------------------------------ */

  getDb(): DatabaseSync | null {
    return this.db;
  }

  getSummaryStore(): SummaryStore | null {
    return this.summaryStore;
  }

  getConversationStore(): ConversationStore | null {
    return this.conversationStore;
  }

  get config(): CompactionConfig {
    return this.compactionConfig;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal — helpers                                                 */
  /* ------------------------------------------------------------------ */

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("AnimaContextEngineAdapter not initialized. Call initialize() first.");
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Utility functions                                                  */
/* ------------------------------------------------------------------ */

function sanitizeFtsQuery(query: string): string {
  return query.replace(/["'*+^:~()-]/g, " ").trim().replace(/"/g, "");
}

function truncateSnippet(content: string, maxLen: number = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.substring(0, maxLen - 3) + "...";
}

/** Create a noop SummaryProvider for initialization when no real provider is configured. */
function createNoopProvider(): SummaryProvider {
  return {
    async complete(): Promise<{ content: string; model?: string; usage?: { inputTokens: number; outputTokens: number } }> {
      return { content: "" };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Message parts — lossless-claw parity                               */
/* ------------------------------------------------------------------ */

/** Build structured message_parts from an AgentMessage, mirroring
 *  lossless-claw's buildMessageParts (engine.ts:980-1160).
 *  Decomposes content blocks into typed parts for tool tracking. */
export function buildMessageParts(params: {
  sessionId: string;
  message: unknown;
  fallbackContent: string;
}): Array<{
  partType: string; ordinal: number; textContent?: string | null;
  isIgnored?: number | null; isSynthetic?: number | null;
  toolCallId?: string | null; toolName?: string | null; toolStatus?: string | null;
  toolInput?: string | null; toolOutput?: string | null; toolError?: string | null;
  toolTitle?: string | null; patchHash?: string | null; patchFiles?: string | null;
  fileMime?: string | null; fileName?: string | null; fileUrl?: string | null;
  subtaskPrompt?: string | null; subtaskDesc?: string | null; subtaskAgent?: string | null;
  stepReason?: string | null; stepCost?: number | null; stepTokensIn?: number | null;
  stepTokensOut?: number | null; snapshotHash?: string | null; compactionAuto?: number | null;
  metadata?: string | null;
}> {
  const msg = params.message as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : "unknown";
  const topLevelToolCallId =
    (msg.toolCallId as string) ?? (msg.tool_call_id as string) ??
    (msg.toolUseId as string) ?? (msg.tool_use_id as string) ??
    (msg.call_id as string) ?? (msg.id as string);
  const topLevelToolName = (msg.toolName as string) ?? (msg.tool_name as string);
  const topLevelIsError = msg.isError === true || msg.is_error === true;

  // BashExecutionMessage shape
  if (!("content" in msg) && "command" in msg && "output" in msg) {
    return [{
      partType: "text", ordinal: 0, textContent: params.fallbackContent,
      metadata: JSON.stringify({ originalRole: role, source: "bash-exec", command: String((msg as any).command ?? "") }),
    }];
  }

  if (!("content" in msg)) {
    return [{
      partType: "agent", ordinal: 0, textContent: params.fallbackContent || null,
      metadata: JSON.stringify({ originalRole: role, source: "unknown-message-shape" }),
    }];
  }

  if (typeof msg.content === "string") {
    return [{
      partType: "text", ordinal: 0, textContent: msg.content,
      metadata: JSON.stringify({
        originalRole: role,
        toolCallId: topLevelToolCallId ?? null,
        toolName: topLevelToolName ?? null,
        isError: topLevelIsError || undefined,
      }),
    }];
  }

  if (!Array.isArray(msg.content)) {
    return [{
      partType: "agent", ordinal: 0, textContent: params.fallbackContent || null,
      metadata: JSON.stringify({ originalRole: role, source: "non-array-content" }),
    }];
  }

  const parts: ReturnType<typeof buildMessageParts> = [];
  for (let ordinal = 0; ordinal < (msg.content as unknown[]).length; ordinal++) {
    const block = (msg.content as unknown[])[ordinal] as Record<string, unknown> | null;
    if (!block || typeof block !== "object") continue;

    const rawBlockType = (block.type as string) ?? (block.partType as string) ?? "unknown";
    const partType = normalizePartType(rawBlockType);
    const toolCallId =
      (block.toolCallId as string) ?? (block.tool_call_id as string) ??
      (block.toolUseId as string) ?? (block.tool_use_id as string) ??
      (block.call_id as string) ??
      (partType === "tool" ? (block.id as string) : undefined) ??
      topLevelToolCallId;

    const toolOutput = extractBlockToolOutput(block, partType);
    const toolInput = extractBlockToolInput(block, partType);

    parts.push({
      partType,
      ordinal,
      textContent: (block.text as string) ?? toolOutput ?? null,
      toolCallId: toolCallId ?? null,
      toolName: ((block.name as string) ?? (block.toolName as string) ?? topLevelToolName) ?? null,
      toolStatus: (block.status as string) ?? (topLevelIsError ? "error" : null),
      toolInput: toolInput ?? null,
      toolOutput: partType === "tool" ? (toolOutput ?? null) : null,
      toolError: topLevelIsError ? (toolOutput ?? null) : null,
      metadata: JSON.stringify({ rawType: rawBlockType }),
    });
  }

  return parts;
}

function normalizePartType(rawType: string): string {
  switch (rawType) {
    case "text": return "text";
    case "reasoning": case "reasoning_content": return "reasoning";
    case "toolCall": case "tool_call": case "tool_use": return "tool";
    case "toolResult": case "tool_result": return "tool";
    case "patch": return "patch";
    case "file": return "file";
    case "subtask": return "subtask";
    case "compaction": return "compaction";
    case "step_start": return "step_start";
    case "step_finish": return "step_finish";
    case "snapshot": return "snapshot";
    case "agent": return "agent";
    case "retry": return "retry";
    default: return "text";
  }
}

function extractBlockToolOutput(block: Record<string, unknown>, partType: string): string | undefined {
  if (partType !== "tool") return undefined;
  if (typeof block.content === "string") return block.content;
  if (typeof block.output === "string") return block.output;
  if (typeof block.result === "string") return block.result;
  if (block.content && typeof block.content === "object") return JSON.stringify(block.content);
  return undefined;
}

function extractBlockToolInput(block: Record<string, unknown>, _partType: string): string | undefined {
  const args = block.arguments ?? block.input ?? block.args;
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return undefined;
}
