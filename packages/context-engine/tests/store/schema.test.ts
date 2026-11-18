import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/store/schema.js';

test('context schema keeps core storage usable when SQLite lacks FTS5', () => {
  const db = new Database(':memory:');
  let unavailable = 0;
  try {
    runMigrations({
      exec(sql) {
        if (/^CREATE VIRTUAL TABLE IF NOT EXISTS (messages|summaries)_fts USING fts5\b/i.test(sql)) {
          unavailable++;
          throw new Error('no such module: fts5');
        }
        db.exec(sql);
      },
    });
    expect(unavailable).toBe(2);
    db.exec("INSERT INTO conversations (conversation_id, agent_id, platform, created_at, updated_at) VALUES ('c', 'a', 'test', 'now', 'now')");
    db.exec("INSERT INTO messages (message_id, conversation_id, seq, role, content, created_at) VALUES ('m', 'c', 1, 'user', 'hello', 'now')");
    expect(db.query('SELECT content FROM messages WHERE message_id = ?').get('m')).toEqual({ content: 'hello' });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'message_parts'").get()).toEqual({ name: 'message_parts' });
  } finally {
    db.close();
  }
});

test('FTS schema failures other than an unavailable module propagate', () => {
  const db = new Database(':memory:');
  try {
    expect(() => runMigrations({
      exec(sql) {
        if (/^CREATE VIRTUAL TABLE/i.test(sql)) throw new Error('database or disk is full');
        db.exec(sql);
      },
    })).toThrow('database or disk is full');
  } finally {
    db.close();
  }
});

test('an unavailable-module error in core schema is not suppressed', () => {
  expect(() => runMigrations({
    exec() { throw new Error('no such module: fts5'); },
  })).toThrow('no such module: fts5');
});
