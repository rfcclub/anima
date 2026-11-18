import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SummaryStore } from '../../src/store/summary-store.js';
import { ConversationStore } from '../../src/store/conversation-store.js';
import { runMigrations } from '../../src/store/schema.js';

function makeMsg(id: string, seq: number, role: 'user' | 'assistant', content: string, tokens = 100) {
  return { id, conversation_id: 'c1', seq, role, content, token_count: tokens, created_at: new Date().toISOString() };
}

describe('SummaryStore', () => {
  let db: Database;
  let summaryStore: SummaryStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db);
    summaryStore = new SummaryStore(db);
    convStore = new ConversationStore(db);
    convStore.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
  });

  afterEach(() => {
    db.close();
  });

  it('creates a leaf summary linked to messages', () => {
    for (let i = 0; i < 5; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, i % 2 ? 'assistant' : 'user', `message ${i}`));
    }
    const summary = summaryStore.createSummary({
      summaryId: 'sum_1', conversationId: 'c1', kind: 'leaf', depth: 0,
      content: 'summary of messages 0-4', tokenCount: 200,
      sourceMessageIds: ['m0', 'm1', 'm2', 'm3', 'm4'],
      descendantCount: 5, descendantTokenCount: 500,
    });
    expect(summary.summary_id).toBe('sum_1');
    expect(summary.kind).toBe('leaf');
    expect(summary.depth).toBe(0);

    const parents = summaryStore.getSummaryParents('sum_1');
    expect(parents).toHaveLength(0); // leaf has no parents

    const messages = summaryStore.getSummaryMessages('sum_1');
    expect(messages).toHaveLength(5);
  });

  it('creates a condensed summary with parent links', () => {
    // Add messages first so foreign key constraints pass
    convStore.addMessage(makeMsg('m0', 0, 'user', 'msg 0'));
    convStore.addMessage(makeMsg('m1', 1, 'assistant', 'msg 1'));
    summaryStore.createSummary({
      summaryId: 'sum_1', conversationId: 'c1', kind: 'leaf', depth: 0,
      content: 'leaf 1', sourceMessageIds: ['m0'],
    });
    summaryStore.createSummary({
      summaryId: 'sum_2', conversationId: 'c1', kind: 'leaf', depth: 0,
      content: 'leaf 2', sourceMessageIds: ['m1'],
    });
    const condensed = summaryStore.createSummary({
      summaryId: 'sum_3', conversationId: 'c1', kind: 'condensed', depth: 1,
      content: 'condensed of sum_1 + sum_2', tokenCount: 150,
      parentSummaryIds: ['sum_1', 'sum_2'],
      descendantCount: 2,
    });
    expect(condensed.kind).toBe('condensed');
    expect(condensed.depth).toBe(1);

    const parents = summaryStore.getSummaryParents('sum_3');
    expect(parents).toHaveLength(2);
    expect(parents.map(p => p.summary_id).sort()).toEqual(['sum_1', 'sum_2']);
  });

  it('replaces context range with summary', () => {
    for (let i = 0; i < 10; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', `msg ${i}`));
    }
    summaryStore.createSummary({
      summaryId: 'sum_1', conversationId: 'c1', kind: 'leaf', depth: 0,
      content: 'summary of 0-4', tokenCount: 150,
      sourceMessageIds: ['m0', 'm1', 'm2', 'm3', 'm4'],
      descendantCount: 5, descendantTokenCount: 500,
    });
    summaryStore.replaceContextRangeWithSummary('c1', 0, 4, 'sum_1');

    const items = convStore.getContextItems('c1');
    expect(items).toHaveLength(6); // sum_1 + m5-m9
    expect(items[0].item_type).toBe('summary');
    expect(items[0].summary_id).toBe('sum_1');
    expect(items[1].message_id).toBe('m5');
    expect(items[5].message_id).toBe('m9');
  });

  it('getContextTokenCount sums message + summary tokens', () => {
    for (let i = 0; i < 3; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', `msg ${i}`, 100));
    }
    expect(summaryStore.getContextTokenCount('c1')).toBe(300);

    summaryStore.createSummary({
      summaryId: 'sum_1', conversationId: 'c1', kind: 'leaf', depth: 0,
      content: 'summary', tokenCount: 150,
      sourceMessageIds: ['m0', 'm1'],
      descendantCount: 2,
    });
    summaryStore.replaceContextRangeWithSummary('c1', 0, 1, 'sum_1');

    // sum_1 (150) + m2 (100) = 250
    expect(summaryStore.getContextTokenCount('c1')).toBe(250);
  });

  it('returns null for missing summary', () => {
    expect(summaryStore.getSummary('nonexistent')).toBeNull();
  });
});
