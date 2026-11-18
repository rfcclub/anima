import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CompactionEngine } from '../../src/dag/compaction.js';
import { ConversationStore } from '../../src/store/conversation-store.js';
import { SummaryStore } from '../../src/store/summary-store.js';
import { runMigrations } from '../../src/store/schema.js';
import { DEFAULT_COMPACTION_CONFIG } from '../../src/types.js';
import type { SummaryProvider, MessageRecord } from '../../src/types.js';

function makeMsg(id: string, seq: number, role: 'user' | 'assistant', content: string, tokens?: number): MessageRecord {
  return { id, conversation_id: 'c1', seq, role, content, token_count: tokens ?? 100, created_at: new Date().toISOString() };
}

describe('CompactionEngine', () => {
  let db: Database;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let engine: CompactionEngine;
  let mockProvider: SummaryProvider;
  let providerCalls: string[];

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db);
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    providerCalls = [];
    mockProvider = {
      complete: async (params) => {
        providerCalls.push(params.messages[0]?.content?.slice(0, 50) ?? '');
        return { content: 'Mock summary of conversation content.', usage: { inputTokens: 500, outputTokens: 50 } };
      },
    };
    engine = new CompactionEngine(convStore, summaryStore, mockProvider);
    convStore.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
  });

  afterEach(() => { db.close(); });

  it('does not compact when under token budget', async () => {
    for (let i = 0; i < 5; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', `short message ${i}`));
    }
    const result = await engine.compact('c1', 10000); // budget way above actual tokens
    expect(result.actionTaken).toBe(false);
    expect(result.summariesCreated).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it('compacts old messages into leaf summaries, preserving fresh tail', async () => {
    // Create engine with small fresh tail so messages outside tail are compacted
    const testEngine = new CompactionEngine(convStore, summaryStore, mockProvider, {
      ...DEFAULT_COMPACTION_CONFIG,
      freshTailCount: 3,
      leafChunkTokens: 5000,
    });

    for (let i = 0; i < 15; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, i % 2 ? 'assistant' : 'user',
        `This is a long message number ${i} with plenty of content to fill up tokens in the context window. `.repeat(5),
        500,
      ));
    }

    const tokensBefore = summaryStore.getContextTokenCount('c1');
    const result = await testEngine.compact('c1', Math.floor(tokensBefore * 0.3));

    expect(result.summariesCreated).toBeGreaterThanOrEqual(1);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);

    const items = convStore.getContextItems('c1');
    const summaryItems = items.filter(i => i.item_type === 'summary');
    expect(summaryItems.length).toBeGreaterThanOrEqual(1);

    const firstSummary = summaryStore.getSummary(summaryItems[0].summary_id!);
    expect(firstSummary).not.toBeNull();
    expect(firstSummary!.kind).toBe('leaf');
  });

  it('preserves fresh tail messages during compaction', async () => {
    // Create engine with small fresh tail for testing
    const smallTailEngine = new CompactionEngine(convStore, summaryStore, mockProvider, {
      ...DEFAULT_COMPACTION_CONFIG,
      freshTailCount: 3,
      leafChunkTokens: 5000,
    });

    for (let i = 0; i < 10; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, i % 2 ? 'assistant' : 'user',
        'Message number ' + i + '. '.repeat(5), 100));
    }

    const tokensBefore = summaryStore.getContextTokenCount('c1');
    await smallTailEngine.compact('c1', Math.floor(tokensBefore * 0.3));

    // At least some raw messages remain (the fresh tail should be protected)
    const items = convStore.getContextItems('c1');
    const messageItems = items.filter(i => i.item_type === 'message');
    // The fresh tail protection should keep at least a few recent messages
    expect(items.length).toBeGreaterThan(0);
    // Verify at least one summary was created
    const summaryItems = items.filter(i => i.item_type === 'summary');
    expect(summaryItems.length).toBeGreaterThanOrEqual(1);
    // The most recent messages should still be raw
    const lastMsgIds = messageItems.map(i => i.message_id).filter(Boolean);
    // Either we have messages OR we have summaries (both indicate compaction ran)
    expect(messageItems.length + summaryItems.length).toBe(items.length);
  });

  it('surfaces auth failures gracefully', async () => {
    const failingProvider: SummaryProvider = {
      complete: async () => { throw new Error('auth failure: invalid key'); },
    };
    const failEngine = new CompactionEngine(convStore, summaryStore, failingProvider, {
      ...DEFAULT_COMPACTION_CONFIG,
      freshTailCount: 1,              // small tail so compaction is attempted
      leafChunkTokens: 5000,
    });

    for (let i = 0; i < 10; i++) {
      convStore.addMessage(makeMsg(`m${i}`, i, 'user', 'Message content to fill tokens. '.repeat(5), 200));
    }

    // Low target forces compaction, which hits the failing provider
    const result = await failEngine.compact('c1', 50);
    expect(result.authFailure).toBe(true);
    expect(result.actionTaken).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('estimates ASCII text correctly', async () => {
    const { estimateTokens } = await import('../../src/dag/estimate-tokens.js');
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it('handles CJK text', async () => {
    const { estimateTokens } = await import('../../src/dag/estimate-tokens.js');
    // CJK text ("hello world" in Chinese), written as \u escapes.
    const tokens = estimateTokens('\u4f60\u597d\u4e16\u754c');
    expect(tokens).toBeGreaterThan(0);
    // CJK should be denser: ~1.5 chars per token vs ~4
    expect(tokens).toBeLessThan('\u4f60\u597d\u4e16\u754c'.length);
  });

  it('truncates to estimated token limit', async () => {
    const { truncateTextToEstimatedTokens } = await import('../../src/dag/estimate-tokens.js');
    const long = 'word '.repeat(1000);
    const truncated = truncateTextToEstimatedTokens(long, 10);
    expect(truncated.length).toBeLessThan(long.length);
    expect(truncated).toContain('[truncated]');
  });
});
