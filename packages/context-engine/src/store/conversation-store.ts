import type { MessageRecord, ContextItem, MessagePartInput } from '../types.js';

type Row = Record<string, unknown>;

interface ConversationRecord {
  conversation_id: string;
  agent_id: string;
  platform: string;
  channel_id: string;
  active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ConversationStore {
  constructor(private db: { prepare: (sql: string) => StatementLike; exec?: (sql: string) => void }) {}

  createConversation(params: {
    conversationId: string;
    agentId: string;
    platform: string;
    channelId?: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO conversations (conversation_id, agent_id, platform, channel_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(params.conversationId, params.agentId, params.platform, params.channelId || '', now, now);
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE conversation_id = ?').get(id) as Row | undefined;
    return row ? this.mapConversation(row) : null;
  }

  addMessage(msg: MessageRecord): void {
    // Defensive: MessageRecord.id is typed as required, but the ingest path
    // (openclaw-adapter.ts ingest) may pass a single message without an id.
    // Generate one to keep SQLite parameter 1 bindable and prevent
    // "Provided value cannot be bound to SQLite parameter 1".
    const messageId = msg.id ?? this._generateId();
    const stmt = this.db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(messageId, msg.conversation_id ?? '', msg.seq, msg.role, msg.content, msg.token_count ?? null, msg.created_at);
    this.addContextItem(msg.conversation_id!, 'message', messageId, null);
    // Populate FTS index
    if (msg.content) {
      try {
        this.db.prepare(
          'INSERT INTO messages_fts (rowid, content) VALUES ((SELECT rowid FROM messages WHERE message_id = ?), ?)',
        ).run(messageId, msg.content);
      } catch { /* FTS population is best-effort */ }
    }
  }

  private _generateId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID
    return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  getMessage(id: string): MessageRecord | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(id) as Row | undefined;
    return row ? this.mapMessage(row) : null;
  }

  getMessages(conversationId: string): MessageRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq',
    ).all(conversationId) as Row[];
    return rows.map(r => this.mapMessage(r));
  }

  /** Persist structured message parts (tool calls, reasoning, text blocks, etc.)
   *  mirrors lossless-claw's message_parts table for structured tool tracking. */
  addMessageParts(messageId: string, sessionId: string, parts: MessagePartInput[]): void {
    for (const part of parts) {
      const partId = crypto.randomUUID?.() ?? `part-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.db.prepare(
        `INSERT OR IGNORE INTO message_parts (
          part_id, message_id, session_id, part_type, ordinal, text_content,
          is_ignored, is_synthetic, tool_call_id, tool_name, tool_status,
          tool_input, tool_output, tool_error, tool_title,
          patch_hash, patch_files, file_mime, file_name, file_url,
          subtask_prompt, subtask_desc, subtask_agent,
          step_reason, step_cost, step_tokens_in, step_tokens_out,
          snapshot_hash, compaction_auto, metadata
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        partId, messageId, sessionId, part.partType, part.ordinal, part.textContent ?? null,
        part.isIgnored ?? null, part.isSynthetic ?? null,
        part.toolCallId ?? null, part.toolName ?? null, part.toolStatus ?? null,
        part.toolInput ?? null, part.toolOutput ?? null, part.toolError ?? null, part.toolTitle ?? null,
        part.patchHash ?? null, part.patchFiles ?? null,
        part.fileMime ?? null, part.fileName ?? null, part.fileUrl ?? null,
        part.subtaskPrompt ?? null, part.subtaskDesc ?? null, part.subtaskAgent ?? null,
        part.stepReason ?? null, part.stepCost ?? null, part.stepTokensIn ?? null, part.stepTokensOut ?? null,
        part.snapshotHash ?? null, part.compactionAuto ?? null, part.metadata ?? null,
      );
    }
  }

  addContextItem(
    conversationId: string,
    itemType: 'message' | 'summary',
    messageId: string | null,
    summaryId: string | null,
  ): void {
    const maxRow = this.db.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 as next FROM context_items WHERE conversation_id = ?',
    ).get(conversationId) as { next: number };
    const nextOrd = (maxRow?.next ?? 0);
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(conversationId, nextOrd, itemType, messageId, summaryId, now);
  }

  getContextItems(conversationId: string): ContextItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM context_items WHERE conversation_id = ? ORDER BY ordinal',
    ).all(conversationId) as Row[];
    return rows.map(r => ({
      conversation_id: r.conversation_id as string,
      ordinal: r.ordinal as number,
      item_type: r.item_type as 'message' | 'summary',
      message_id: r.message_id as string | undefined,
      summary_id: r.summary_id as string | undefined,
    }));
  }

  deleteContextItems(conversationId: string, startOrdinal: number, endOrdinal: number): void {
    this.db.prepare(
      'DELETE FROM context_items WHERE conversation_id = ? AND ordinal BETWEEN ? AND ?',
    ).run(conversationId, startOrdinal, endOrdinal);
  }

  updateContextOrdinals(conversationId: string): void {
    // Resequence ordinals after deletions — set negative temp then back to positive
    // to avoid UNIQUE constraint violations
    const items = this.db.prepare(
      'SELECT conversation_id, ordinal FROM context_items WHERE conversation_id = ? AND ordinal < 0',
    ).all(conversationId) as Row[];
    for (const item of items) {
      const newOrd = -(item.ordinal as number) - 1_000_000;
      this.db.prepare(
        'UPDATE context_items SET ordinal = ? WHERE conversation_id = ? AND ordinal = ?',
      ).run(newOrd, conversationId, item.ordinal);
    }
  }

  /**
   * @deprecated Use SummaryStore.getContextTokenCount() instead — it includes both
   * message and summary tokens. This method only counts raw message tokens.
   */
  totalContextTokens(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(COALESCE(m.token_count, 0)), 0) as total
      FROM context_items ci
      JOIN messages m ON ci.message_id = m.message_id
      WHERE ci.conversation_id = ? AND ci.item_type = 'message'
    `).get(conversationId) as { total: number };
    return row.total;
  }

  private mapConversation(row: Row): ConversationRecord {
    return {
      conversation_id: row.conversation_id as string,
      agent_id: row.agent_id as string,
      platform: row.platform as string,
      channel_id: row.channel_id as string,
      active: (row.active as number) === 1,
      archived_at: row.archived_at as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  private mapMessage(row: Row): MessageRecord {
    return {
      id: row.message_id as string,
      conversation_id: row.conversation_id as string,
      seq: row.seq as number,
      role: row.role as 'user' | 'assistant' | 'system' | 'tool',
      content: row.content as string | null,
      token_count: row.token_count as number | undefined,
      created_at: row.created_at as string,
    };
  }
}

// Minimal statement interface (compatible with both node:sqlite and bun:sqlite)
interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
