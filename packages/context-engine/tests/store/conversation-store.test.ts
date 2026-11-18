import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ConversationStore } from '../../src/store/conversation-store.js';
import { runMigrations } from '../../src/store/schema.js';

describe('ConversationStore', () => {
  let db: Database;
  let store: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db);
    store = new ConversationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a conversation', () => {
    store.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'anima' });
    const conv = store.getConversation('c1');
    expect(conv).not.toBeNull();
    expect(conv!.agent_id).toBe('bruno');
    expect(conv!.platform).toBe('anima');
    expect(conv!.active).toBe(true);
  });

  it('adds a message and creates context item', () => {
    store.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
    store.addMessage({
      id: 'm1', conversation_id: 'c1', seq: 0, role: 'user',
      content: 'hello', created_at: new Date().toISOString(),
    });
    const items = store.getContextItems('c1');
    expect(items).toHaveLength(1);
    expect(items[0].item_type).toBe('message');
    expect(items[0].message_id).toBe('m1');
  });

  it('context items maintain ordinal order', () => {
    store.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
    for (let i = 0; i < 5; i++) {
      store.addMessage({
        id: `m${i}`, conversation_id: 'c1', seq: i, role: 'user',
        content: `msg ${i}`, created_at: new Date().toISOString(),
      });
    }
    const items = store.getContextItems('c1');
    expect(items).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(items[i].ordinal).toBe(i);
    }
  });

  it('retrieves a message by id', () => {
    store.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
    store.addMessage({
      id: 'm1', conversation_id: 'c1', seq: 0, role: 'assistant',
      content: 'hi there', token_count: 50, created_at: new Date().toISOString(),
    });
    const msg = store.getMessage('m1');
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('hi there');
    expect(msg!.token_count).toBe(50);
    expect(msg!.role).toBe('assistant');
  });

  it('returns null for missing message', () => {
    expect(store.getMessage('nonexistent')).toBeNull();
  });

  it('totalContextTokens sums message tokens in context', () => {
    store.createConversation({ conversationId: 'c1', agentId: 'bruno', platform: 'test' });
    for (let i = 0; i < 3; i++) {
      store.addMessage({
        id: `m${i}`, conversation_id: 'c1', seq: i, role: 'user',
        content: `msg ${i}`, token_count: 100, created_at: new Date().toISOString(),
      });
    }
    expect(store.totalContextTokens('c1')).toBe(300);
  });
});
