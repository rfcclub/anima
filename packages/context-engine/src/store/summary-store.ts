import type { SummaryRecord } from '../types.js';

type Row = Record<string, unknown>;

interface StatementLike {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export class SummaryStore {
  constructor(private db: { prepare: (sql: string) => StatementLike }) {}

  createSummary(params: {
    summaryId: string;
    conversationId: string;
    kind: 'leaf' | 'condensed';
    depth: number;
    content: string;
    tokenCount?: number;
    sourceMessageIds?: string[];
    parentSummaryIds?: string[];
    descendantCount?: number;
    descendantTokenCount?: number;
    model?: string;
  }): SummaryRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count,
        descendant_count, descendant_token_count, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.summaryId, params.conversationId, params.kind, params.depth,
      params.content, params.tokenCount ?? null,
      params.descendantCount ?? 0, params.descendantTokenCount ?? 0,
      params.model ?? null, now,
    );

    if (params.sourceMessageIds) {
      const stmt = this.db.prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
      for (const msgId of params.sourceMessageIds) {
        stmt.run(params.summaryId, msgId);
      }
    }

    if (params.parentSummaryIds) {
      const stmt = this.db.prepare('INSERT INTO summary_parents (summary_id, parent_summary_id) VALUES (?, ?)');
      for (const parentId of params.parentSummaryIds) {
        stmt.run(params.summaryId, parentId);
      }
    }

    // Populate FTS index
    try {
      this.db.prepare(
        'INSERT INTO summaries_fts (rowid, content) VALUES ((SELECT rowid FROM summaries WHERE summary_id = ?), ?)',
      ).run(params.summaryId, params.content);
    } catch { /* FTS population is best-effort */ }

    return this.getSummary(params.summaryId)!;
  }

  getSummary(id: string): SummaryRecord | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE summary_id = ?').get(id) as Row | undefined;
    return row ? this.mapSummary(row) : null;
  }

  getSummaryParents(summaryId: string): SummaryRecord[] {
    const rows = this.db.prepare(
      `SELECT s.* FROM summaries s
       JOIN summary_parents sp ON s.summary_id = sp.parent_summary_id
       WHERE sp.summary_id = ?`,
    ).all(summaryId) as Row[];
    return rows.map(r => this.mapSummary(r));
  }

  getSummaryMessages(summaryId: string): string[] {
    const rows = this.db.prepare(
      'SELECT message_id FROM summary_messages WHERE summary_id = ?',
    ).all(summaryId) as Row[];
    return rows.map(r => r.message_id as string);
  }

  replaceContextRangeWithSummary(
    conversationId: string,
    startOrdinal: number,
    endOrdinal: number,
    summaryId: string,
  ): void {
    // Delete the range
    this.db.prepare(
      'DELETE FROM context_items WHERE conversation_id = ? AND ordinal BETWEEN ? AND ?',
    ).run(conversationId, startOrdinal, endOrdinal);

    // Insert summary at the start
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(conversationId, startOrdinal, 'summary', summaryId, now);

    // Shift later ordinals by -(range_size - 1) — negative-temp scheme to avoid UNIQUE conflicts
    const rangeSize = endOrdinal - startOrdinal + 1;
    const shift = rangeSize - 1;
    if (shift > 0) {
      // Move ordinals after the range to negative temp
      this.db.prepare(
        'UPDATE context_items SET ordinal = -(ordinal + 1000000) WHERE conversation_id = ? AND ordinal > ?',
      ).run(conversationId, startOrdinal);
      // Bring them back, shifted down
      this.db.prepare(
        `UPDATE context_items SET ordinal = -ordinal - 1000000 - ? WHERE conversation_id = ? AND ordinal < 0`,
      ).run(shift, conversationId);
    }
  }

  getContextTokenCount(conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN ci.item_type = 'message' THEN COALESCE(m.token_count, 0)
          WHEN ci.item_type = 'summary' THEN COALESCE(s.token_count, 0)
          ELSE 0
        END
      ), 0) as total
      FROM context_items ci
      LEFT JOIN messages m ON ci.message_id = m.message_id
      LEFT JOIN summaries s ON ci.summary_id = s.summary_id
      WHERE ci.conversation_id = ?
    `).get(conversationId) as { total: number };
    return row.total;
  }

  searchSummaries(conversationId: string, query: string, limit = 10): SummaryRecord[] {
    const safe = query.replace(/"/g, '').trim();
    if (!safe) return [];
    try {
      const rows = this.db.prepare(
        `SELECT s.* FROM summaries s
         JOIN summaries_fts f ON s.rowid = f.rowid
         WHERE s.conversation_id = ? AND summaries_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      ).all(conversationId, `"${safe}"`, limit) as Row[];
      return rows.map(r => this.mapSummary(r));
    } catch {
      return [];
    }
  }

  private mapSummary(row: Row): SummaryRecord {
    return {
      summary_id: row.summary_id as string,
      conversation_id: row.conversation_id as string,
      kind: row.kind as 'leaf' | 'condensed',
      depth: row.depth as number,
      content: row.content as string,
      token_count: row.token_count as number | undefined,
      descendant_count: row.descendant_count as number | undefined,
      descendant_token_count: row.descendant_token_count as number | undefined,
      source_message_token_count: row.source_message_token_count as number | undefined,
      earliest_at: row.earliest_at as string | undefined,
      latest_at: row.latest_at as string | undefined,
      model: row.model as string | undefined,
      created_at: row.created_at as string,
    };
  }
}
