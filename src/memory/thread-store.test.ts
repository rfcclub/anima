import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentThreadStore, type ToolSummaryEntry } from "./thread-store";

function tmpDb() {
  return join(tmpdir(), `thread-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch {}
  }
}

describe("PersistentThreadStore — persistence (SC-001, SC-002, SC-003)", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { cleanup(dbPath); });

  test("add + getThread round-trips correctly", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    store.add("chat-1", "eli", "user", "hello");
    store.add("chat-1", "eli", "assistant", "hi there");

    const thread = store.getThread("chat-1", "eli");
    expect(thread).toHaveLength(2);
    expect(thread[0]).toEqual({ role: "user", content: "hello", toolSummary: undefined });
    expect(thread[1]).toEqual({ role: "assistant", content: "hi there", toolSummary: undefined });
  });

  test("thread survives DB close + reopen (SC-001)", () => {
    const db1 = new Database(dbPath);
    const store1 = new PersistentThreadStore(db1);
    store1.add("chat-1", "eli", "user", "remember me");
    store1.add("chat-1", "eli", "assistant", "I will");
    db1.close();

    const db2 = new Database(dbPath);
    const store2 = new PersistentThreadStore(db2);
    const thread = store2.getThread("chat-1", "eli");
    expect(thread).toHaveLength(2);
    expect(thread[0].content).toBe("remember me");
    expect(thread[1].content).toBe("I will");
    db2.close();
  });

  test("new thread returns empty array (SC-002)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    const thread = store.getThread("chat-999", "cleo");
    expect(thread).toEqual([]);
  });

  test("clear removes all messages for channel+agent (SC-003)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    store.add("chat-1", "eli", "user", "msg1");
    store.add("chat-1", "eli", "assistant", "msg2");
    store.add("chat-1", "cleo", "user", "other agent");

    store.clear("chat-1", "eli");

    expect(store.getThread("chat-1", "eli")).toEqual([]);
    expect(store.getThread("chat-1", "cleo")).toHaveLength(1);
  });
});

describe("PersistentThreadStore — thread depth (SC-004, SC-005)", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { cleanup(dbPath); });

  test("thread holds 50 messages without loss (SC-004)", () => {
    const store = new PersistentThreadStore(new Database(dbPath), 50);
    for (let i = 0; i < 50; i++) {
      store.add("chat-1", "eli", i % 2 === 0 ? "user" : "assistant", `msg-${i}`);
    }
    const thread = store.getThread("chat-1", "eli");
    expect(thread).toHaveLength(50);
    expect(thread[0].content).toBe("msg-0");
    expect(thread[49].content).toBe("msg-49");
  });

  test("51st message triggers compaction, not silent drop (SC-004)", () => {
    const store = new PersistentThreadStore(new Database(dbPath), 50);
    for (let i = 0; i < 51; i++) {
      store.add("chat-1", "eli", i % 2 === 0 ? "user" : "assistant", `msg-${i}`);
    }
    const thread = store.getThread("chat-1", "eli");
    // After compaction: summary + remaining messages
    expect(thread.length).toBeLessThanOrEqual(50);
    expect(thread.length).toBeGreaterThan(25);
    // First message should be a summary
    expect(thread[0].content).toContain("[Previous conversation summary]");
    // Last message should be the newest
    expect(thread[thread.length - 1].content).toBe("msg-50");
  });

  test("configurable max size (SC-005)", () => {
    const store = new PersistentThreadStore(new Database(dbPath), 10);
    for (let i = 0; i < 11; i++) {
      store.add("chat-1", "eli", "user", `msg-${i}`);
    }
    const thread = store.getThread("chat-1", "eli");
    expect(thread.length).toBeLessThanOrEqual(10);
    expect(thread[0].content).toContain("[Previous conversation summary]");
  });
});

describe("PersistentThreadStore — tool summaries (SC-006, SC-007, SC-008)", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { cleanup(dbPath); });

  test("tool summary stored and returned (SC-006)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    const tools: ToolSummaryEntry[] = [
      { tool: "read_file", args: "src/main.ts", resultPreview: "import { foo } from..." },
      { tool: "read_file", args: "src/util.ts", resultPreview: "export function bar..." },
    ];
    store.add("chat-1", "eli", "assistant", "I read the files", tools);

    const thread = store.getThread("chat-1", "eli");
    expect(thread).toHaveLength(1);
    expect(thread[0].toolSummary).toHaveLength(2);
    expect(thread[0].toolSummary![0].tool).toBe("read_file");
    expect(thread[0].toolSummary![0].args).toBe("src/main.ts");
  });

  test("tool summary available in next turn context (SC-007)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    const tools: ToolSummaryEntry[] = [
      { tool: "read_file", args: "config.yaml", resultPreview: "port: 3700" },
    ];
    store.add("chat-1", "eli", "user", "read the config");
    store.add("chat-1", "eli", "assistant", "done", tools);
    store.add("chat-1", "eli", "user", "what did it say?");

    const thread = store.getThread("chat-1", "eli");
    expect(thread).toHaveLength(3);
    expect(thread[1].toolSummary).toBeDefined();
    expect(thread[1].toolSummary![0].resultPreview).toBe("port: 3700");
  });

  test("tool summary capped at 2000 chars (SC-008)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    const tools: ToolSummaryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      tool: "read_file",
      args: `file-${i}.ts`,
      resultPreview: "x".repeat(200),
    }));
    store.add("chat-1", "eli", "assistant", "read many files", tools);

    const thread = store.getThread("chat-1", "eli");
    const stored = JSON.stringify(thread[0].toolSummary);
    expect(stored.length).toBeLessThanOrEqual(2200);
  });
});

describe("PersistentThreadStore — compaction (SC-009, SC-010)", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { cleanup(dbPath); });

  test("compaction preserves context from old messages (SC-009)", () => {
    const store = new PersistentThreadStore(new Database(dbPath), 20);
    store.add("chat-1", "eli", "user", "Let's discuss the API design");
    store.add("chat-1", "eli", "assistant", "Sure. I suggest REST with pagination.");
    store.add("chat-1", "eli", "user", "What about authentication?");
    store.add("chat-1", "eli", "assistant", "OAuth 2.0 with JWT tokens.");
    for (let i = 0; i < 18; i++) {
      store.add("chat-1", "eli", i % 2 === 0 ? "user" : "assistant", `filler-${i}`);
    }
    // Trigger compaction
    store.add("chat-1", "eli", "user", "final message");

    const thread = store.getThread("chat-1", "eli");
    expect(thread[0].content).toContain("[Previous conversation summary]");
    expect(thread[0].content).toContain("API design");
  });

  test("compaction completes under 50ms (SC-010)", () => {
    const store = new PersistentThreadStore(new Database(dbPath), 50);
    for (let i = 0; i < 50; i++) {
      store.add("chat-1", "eli", i % 2 === 0 ? "user" : "assistant", `message ${i} with some content`);
    }
    const start = performance.now();
    store.add("chat-1", "eli", "user", "trigger compaction");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("PersistentThreadStore — isolation (SC-013)", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { cleanup(dbPath); });

  test("separate threads per agent in same chat (SC-013)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    store.add("chat-1", "eli", "user", "hello eli");
    store.add("chat-1", "eli", "assistant", "hi from eli");
    store.add("chat-1", "cleo", "user", "hello cleo");
    store.add("chat-1", "cleo", "assistant", "hi from cleo");

    const eliThread = store.getThread("chat-1", "eli");
    const cleoThread = store.getThread("chat-1", "cleo");

    expect(eliThread).toHaveLength(2);
    expect(cleoThread).toHaveLength(2);
    expect(eliThread[1].content).toBe("hi from eli");
    expect(cleoThread[1].content).toBe("hi from cleo");
  });

  test("separate threads per chat for same agent", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    store.add("chat-1", "eli", "user", "in chat 1");
    store.add("chat-2", "eli", "user", "in chat 2");

    expect(store.getThread("chat-1", "eli")).toHaveLength(1);
    expect(store.getThread("chat-2", "eli")).toHaveLength(1);
    expect(store.getThread("chat-1", "eli")[0].content).toBe("in chat 1");
  });
});

describe("PersistentThreadStore — performance (SC-014, SC-015)", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { cleanup(dbPath); });

  test("getThread returns within 10ms for 50 messages (SC-014)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    for (let i = 0; i < 50; i++) {
      store.add("chat-1", "eli", i % 2 === 0 ? "user" : "assistant", `msg-${i}`);
    }
    const start = performance.now();
    const thread = store.getThread("chat-1", "eli");
    const elapsed = performance.now() - start;
    expect(thread).toHaveLength(50);
    expect(elapsed).toBeLessThan(10);
  });

  test("add completes within 5ms (SC-015)", () => {
    const store = new PersistentThreadStore(new Database(dbPath));
    const start = performance.now();
    store.add("chat-1", "eli", "user", "quick write");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
  });
});
