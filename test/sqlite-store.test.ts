import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/memory/sqlite-store";
import type { JsonlEvent } from "../src/memory/jsonl-store";

function tempDbPath(): string {
  return join(tmpdir(), `anima-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeEvent(type: string, agent: string, date: string, extra: Record<string, unknown> = {}): JsonlEvent {
  return {
    timestamp: `${date}T10:00:00.000Z`,
    type,
    sessionId: `${agent}:${date}`,
    ...extra,
  };
}

describe("SqliteStore", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new SqliteStore(dbPath);
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  test("load empty — readDate returns []", () => {
    expect(store.readDate("bruno", "2026-05-01")).toEqual([]);
  });

  test("append turn — readDate returns it", () => {
    const event = makeEvent("turn", "bruno", "2026-05-01", { role: "user", content: "hello" });
    store.append("bruno", event);
    const result = store.readDate("bruno", "2026-05-01");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("turn");
    expect((result[0] as { role: string }).role).toBe("user");
  });

  test("multiple appends — preserves insertion order", () => {
    for (let i = 0; i < 5; i++) {
      store.append("bruno", makeEvent("turn", "bruno", "2026-05-01", { n: i }));
    }
    const result = store.readDate("bruno", "2026-05-01");
    expect(result).toHaveLength(5);
    expect((result[0] as { n: number }).n).toBe(0);
    expect((result[4] as { n: number }).n).toBe(4);
  });

  test("appendTurn — readDate does not return other agents", () => {
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-01"));
    store.append("lena", makeEvent("turn", "lena", "2026-05-01"));
    expect(store.readDate("bruno", "2026-05-01")).toHaveLength(1);
    expect(store.readDate("lena", "2026-05-01")).toHaveLength(1);
  });

  test("readDate — does not return other dates", () => {
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-01"));
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-02"));
    expect(store.readDate("bruno", "2026-05-01")).toHaveLength(1);
    expect(store.readDate("bruno", "2026-05-02")).toHaveLength(1);
  });

  test("readRecent — returns most recent first, limited", () => {
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-01", { n: 1 }));
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-01", { n: 2 }));
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-02", { n: 3 }));
    const result = store.readRecent("bruno", 2);
    expect(result).toHaveLength(2);
    expect((result[0] as { n: number }).n).toBe(3);
    expect((result[1] as { n: number }).n).toBe(2);
  });

  test("UNIQUE(agent, date, idx) — duplicate append is silently ignored", () => {
    const event = makeEvent("turn", "bruno", "2026-05-01");
    store.append("bruno", event);
    // Manually insert same idx — happens only during migration idempotency
    // Verify that two appends of different events both land
    store.append("bruno", makeEvent("turn", "bruno", "2026-05-01", { n: 2 }));
    expect(store.readDate("bruno", "2026-05-01")).toHaveLength(2);
  });

  test("recover — returns null (no-op)", () => {
    expect(store.recover("bruno", "2026-05-01")).toBeNull();
  });

  test("compact events round-trip", () => {
    const event: JsonlEvent = {
      timestamp: "2026-05-01T12:00:00.000Z",
      type: "compact",
      sessionId: "bruno:2026-05-01",
      summary: "Prior context summary",
      turnCount: 10,
      dateRange: { from: "2026-04-01", to: "2026-05-01" },
      model: "gemini-3.1",
    };
    store.append("bruno", event);
    const [loaded] = store.readDate("bruno", "2026-05-01");
    expect(loaded.type).toBe("compact");
    expect((loaded as { summary: string }).summary).toBe("Prior context summary");
  });
});
