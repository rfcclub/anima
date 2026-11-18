import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ContextAssembler } from '../../src/dag/assembler.js';
import { ConversationStore } from '../../src/store/conversation-store.js';
import { SummaryStore } from '../../src/store/summary-store.js';
import { runMigrations } from '../../src/store/schema.js';
import type { MessageRecord } from '../../src/types.js';

function makeMsg(id: string, seq: number, role: 'user' | 'assistant', content: string, tokens = 100): MessageRecord {
  return { id, conversation_id: 'c1', seq, role, content, token_count: tokens, created_at: new Date().toISOString() };
}

describe('ContextAssembler', () => {
  let db: Database;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let assembler: ContextAssembler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db);
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    assembler = new ContextAssembler(convStore, summaryStore, 64);
    convStore.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
  });

  afterEach(() => { db.close(); });

  it('assembles all messages when under budget', () => {
    for (let i = 0; i < 5; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', `message ${i}`));
    }
    const result = assembler.assemble('c1');
    expect(result.messages).toHaveLength(5);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('returns empty result for empty conversation', () => {
    const result = assembler.assemble('c1');
    expect(result.messages).toHaveLength(0);
    expect(result.estimatedTokens).toBe(0);
  });

  it('applies budget eviction when over token budget', () => {
    for (let i = 0; i < 50; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', `message number ${i}`, 100));
    }
    // Use small fresh tail so most messages are evictable
    const smallTail = new ContextAssembler(convStore, summaryStore, 5);
    const result = smallTail.assemble('c1', undefined, 500); // tight budget
    expect(result.estimatedTokens).toBeLessThanOrEqual(600);
    expect(result.messages.length).toBeLessThan(50);
  });

  it('resolves summaries in context', () => {
    for (let i = 0; i < 5; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', `message ${i}`));
    }
    summaryStore.createSummary({
      summaryId: 'sum_1', conversationId: 'c1', kind: 'leaf', depth: 0,
      content: 'summary of m0-m2', tokenCount: 150,
      sourceMessageIds: ['m0', 'm1', 'm2'],
      descendantCount: 3,
    });
    summaryStore.replaceContextRangeWithSummary('c1', 0, 2, 'sum_1');

    const result = assembler.assemble('c1');
    // 2 raw messages (m3, m4) + 1 summary (for m0-m2) = 3 total
    expect(result.messages).toHaveLength(3);
    const summaryMsg = result.messages.find(m => m.id.startsWith('synth_'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.role).toBe('system');
    expect(summaryMsg!.content).toContain('<summary');
  });

  it('BM25-lite scores relevant items higher', () => {
    convStore.addMessage(makeMsg('m0', 0, 'user', 'deploy script is at ~/deploy.sh', 50));
    convStore.addMessage(makeMsg('m1', 1, 'user', 'the weather is nice today', 50));
    convStore.addMessage(makeMsg('m2', 2, 'user', 'random chat about movies', 50));
    convStore.addMessage(makeMsg('m3', 3, 'user', 'deployment uses docker compose up', 50));
    convStore.addMessage(makeMsg('m4', 4, 'user', 'lunch was good', 50));

    const result = assembler.assemble('c1', 'how to deploy', 100); // tight budget, 2 messages

    const contents = result.messages.map(m => m.content);
    // Should prefer deploy-related messages
    expect(contents.some(c => c?.includes('deploy'))).toBe(true);
  });
});
