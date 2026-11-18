/**
 * cost-ledger-accuracy: provider_calls parent, v2 token_usage
 * detail, data-preserving migration. In-memory databases only — never ~/.anima/cost.db.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { TokenLedger } from "../../src/cost/ledger";

/** The table exactly as it was before this change. */
function legacyDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX idx_token_usage_agent ON token_usage(agent_id, created_at)");
  db.run("CREATE INDEX idx_token_usage_model ON token_usage(model, created_at)");
  db.run("CREATE INDEX idx_token_usage_session ON token_usage(session_id)");
  const insert = db.prepare(
    "INSERT INTO token_usage (id, session_id, agent_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(1, "s1", "bruno", "claude", "claude-sonnet-4-6", 1000, 200, 500, 0, "2026-09-01 10:00:00");
  insert.run(2, "s1", "eli", "gemini", "gemini-2.5-flash", 300, 50, 0, 0, "2026-09-01 11:30:00");
  insert.run(7, "s2", "bruno", "router", "glm-5.1", 40, 5, 0, 0, "2026-09-02 08:15:00");
  return db;
}

const call = (over: Record<string, unknown> = {}) => ({
  callId: "call-1",
  agentId: "bruno",
  sessionId: "s9",
  backend: "claude",
  startedAt: "2026-10-22T12:00:00.000Z",
  latencyMs: 250,
  status: "ok" as const,
  coverage: "complete" as const,
  details: [{ model: "claude-sonnet-4-6", inputTokens: 200, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0 }],
  ...over,
});

describe("migration", () => {
  test("a legacy database keeps every row's id, values and timestamps, as usage_version 1", () => {
    const db = legacyDb();
    new TokenLedger(db);
    const rows = db.query("SELECT * FROM token_usage ORDER BY id").all() as any[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 7]);
    expect(rows[0]).toMatchObject({ session_id: "s1", agent_id: "bruno", provider: "claude", model: "claude-sonnet-4-6", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 500, cache_write_tokens: 0, created_at: "2026-09-01 10:00:00", usage_version: 1, call_id: null });
    expect(rows[2]).toMatchObject({ id: 7, provider: "router", model: "glm-5.1", created_at: "2026-09-02 08:15:00", usage_version: 1 });
  });

  test("token columns become nullable and the indexes exist", () => {
    const db = legacyDb();
    new TokenLedger(db);
    const info = db.query("PRAGMA table_info(token_usage)").all() as any[];
    const col = (name: string) => info.find((c) => c.name === name);
    expect(col("input_tokens").notnull).toBe(0);
    expect(col("cache_write_tokens").notnull).toBe(0);
    expect(col("call_id")).toBeDefined();
    const indexes = (db.query("PRAGMA index_list(token_usage)").all() as any[]).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_token_usage_agent_v2", "idx_token_usage_model_v2", "idx_token_usage_session_v2", "idx_token_usage_call"]));
  });

  test("the original rows stay in token_usage_v1_backup; nothing is deleted by the migration", () => {
    const db = legacyDb();
    new TokenLedger(db);
    const backup = db.query("SELECT id, model, input_tokens, created_at FROM token_usage_v1_backup ORDER BY id").all();
    expect(backup).toEqual([
      { id: 1, model: "claude-sonnet-4-6", input_tokens: 1000, created_at: "2026-09-01 10:00:00" },
      { id: 2, model: "gemini-2.5-flash", input_tokens: 300, created_at: "2026-09-01 11:30:00" },
      { id: 7, model: "glm-5.1", input_tokens: 40, created_at: "2026-09-02 08:15:00" },
    ]);
  });

  test("a new database has no backup table", () => {
    const db = new Database(":memory:");
    new TokenLedger(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'token_usage_v1_backup'").all()).toEqual([]);
  });

  test("new ids continue after the legacy maximum", () => {
    const db = legacyDb();
    const ledger = new TokenLedger(db);
    const id = ledger.log({ sessionId: "s3", agentId: "bruno", provider: "claude", model: "m", inputTokens: 1, outputTokens: 1 });
    expect(id).toBe(8);
  });

  test("reopening a migrated database changes nothing", () => {
    const db = legacyDb();
    new TokenLedger(db);
    const before = JSON.stringify(db.query("SELECT * FROM token_usage ORDER BY id").all());
    const schemaBefore = JSON.stringify(db.query("SELECT sql FROM sqlite_master ORDER BY name").all());
    new TokenLedger(db);
    expect(JSON.stringify(db.query("SELECT * FROM token_usage ORDER BY id").all())).toBe(before);
    expect(JSON.stringify(db.query("SELECT sql FROM sqlite_master ORDER BY name").all())).toBe(schemaBefore);
  });

  test("a failing migration leaves the original table and rows untouched", () => {
    const db = legacyDb();
    db.run("CREATE TABLE token_usage_v2 (leftover TEXT)"); // makes the rebuild fail
    expect(() => new TokenLedger(db)).toThrow();
    expect((db.query("SELECT COUNT(*) AS n FROM token_usage").get() as any).n).toBe(3);
    const info = db.query("PRAGMA table_info(token_usage)").all() as any[];
    expect(info.find((c) => c.name === "input_tokens").notnull).toBe(1);
    expect(info.find((c) => c.name === "call_id")).toBeUndefined();
  });
});

describe("recordCall", () => {
  test("one call with one model writes 1 parent and 1 v2 detail linked by call_id", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    ledger.recordCall(call());
    const parents = db.query("SELECT * FROM provider_calls").all() as any[];
    expect(parents).toHaveLength(1);
    expect(parents[0]).toMatchObject({ call_id: "call-1", agent_id: "bruno", session_id: "s9", path_id: null, backend: "claude", started_at: "2026-10-22T12:00:00.000Z", latency_ms: 250, status: "ok", coverage: "complete" });
    const details = db.query("SELECT * FROM token_usage").all() as any[];
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ call_id: "call-1", usage_version: 2, agent_id: "bruno", session_id: "s9", provider: "claude", model: "claude-sonnet-4-6", input_tokens: 200, output_tokens: 100, cache_read_tokens: 800, cache_write_tokens: 0 });
  });

  test("a call with two models writes 1 parent and 2 details", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    ledger.recordCall(call({
      details: [
        { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    }));
    expect((db.query("SELECT COUNT(*) AS n FROM provider_calls").get() as any).n).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM token_usage").get() as any).n).toBe(2);
  });

  test("a later settlement of the same call_id updates in place, never duplicates", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    ledger.recordCall(call({ status: "aborted", coverage: "unknown", details: [{ model: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }] }));
    ledger.recordCall(call({ status: "ok", coverage: "complete", latencyMs: 900, details: [{ model: "unknown", inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 }] }));
    const parents = db.query("SELECT * FROM provider_calls").all() as any[];
    expect(parents).toHaveLength(1);
    expect(parents[0]).toMatchObject({ status: "ok", coverage: "complete", latency_ms: 900 });
    const details = db.query("SELECT * FROM token_usage").all() as any[];
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ input_tokens: 5, output_tokens: 6 });
  });

  test("unknown usage is stored as NULL, a measured zero as 0", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    ledger.recordCall(call({ coverage: "partial", details: [{ model: "m", inputTokens: null, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: 0 }] }));
    const d = db.query("SELECT * FROM token_usage").get() as any;
    expect(d.input_tokens).toBeNull();
    expect(d.output_tokens).toBe(0);
    expect(d.cache_read_tokens).toBeNull();
    expect(d.cache_write_tokens).toBe(0);
  });

  test("a path id is stored for a call with no session", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    ledger.recordCall(call({ sessionId: null, pathId: "compactor" }));
    expect(db.query("SELECT session_id, path_id FROM provider_calls").get()).toMatchObject({ session_id: null, path_id: "compactor" });
    expect((db.query("SELECT session_id FROM token_usage").get() as any).session_id).toBe("compactor");
  });

  test("a negative latency is rejected", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    expect(() => ledger.recordCall(call({ latencyMs: -1 }))).toThrow(/latency/i);
  });

  test("the legacy log() still writes a v1 row without a parent", () => {
    const db = new Database(":memory:");
    const ledger = new TokenLedger(db);
    ledger.log({ sessionId: "s", agentId: "a", provider: "p", model: "m", inputTokens: 3, outputTokens: 4 });
    expect(db.query("SELECT usage_version, call_id FROM token_usage").get()).toMatchObject({ usage_version: 1, call_id: null });
    expect((db.query("SELECT COUNT(*) AS n FROM provider_calls").get() as any).n).toBe(0);
  });
});
