import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { JsonlStore, type JsonlEvent, extractDate } from "../src/memory/jsonl-store";

let store: JsonlStore;
let testAgent: string;
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `anima-jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  store = new JsonlStore(testDir);
  testAgent = "test-agent";
});

function cleanup() {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Helper factories                                                   */
/* ------------------------------------------------------------------ */

function makeEvent(
  overrides: Partial<JsonlEvent> & { timestamp?: string; type?: string; sessionId?: string },
): JsonlEvent {
  return {
    timestamp: overrides.timestamp ?? "2026-05-17T10:00:00.000Z",
    type: overrides.type ?? "test",
    sessionId: overrides.sessionId ?? "session-1",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  append + readDate                                                  */
/* ------------------------------------------------------------------ */

describe("append + readDate", () => {
  test("append one event and readDate returns it", () => {
    const event = makeEvent({ content: "hello" });
    store.append(testAgent, event);

    const events = store.readDate(testAgent, "2026-05-17");
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("hello");
    expect(events[0].sessionId).toBe("session-1");
  });

  test("readDate returns empty array when no file exists", () => {
    const events = store.readDate(testAgent, "2099-12-31");
    expect(events).toEqual([]);
  });

  test("readDate returns empty array for a date that has no events", () => {
    store.append(testAgent, makeEvent({ timestamp: "2026-05-17T10:00:00.000Z" }));
    const events = store.readDate(testAgent, "2026-05-18");
    expect(events).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Multiple appends ordered                                           */
/* ------------------------------------------------------------------ */

describe("multiple appends ordered", () => {
  test("appended events are returned in order", () => {
    store.append(testAgent, makeEvent({ timestamp: "2026-05-17T10:00:00.000Z", content: "first" }));
    store.append(testAgent, makeEvent({ timestamp: "2026-05-17T10:01:00.000Z", content: "second" }));
    store.append(testAgent, makeEvent({ timestamp: "2026-05-17T10:02:00.000Z", content: "third" }));

    const events = store.readDate(testAgent, "2026-05-17");
    expect(events).toHaveLength(3);
    expect(events[0].content).toBe("first");
    expect(events[1].content).toBe("second");
    expect(events[2].content).toBe("third");
  });

  test("append across multiple dates", () => {
    store.append(testAgent, makeEvent({ timestamp: "2026-05-17T10:00:00.000Z", content: "day1" }));
    store.append(testAgent, makeEvent({ timestamp: "2026-05-18T10:00:00.000Z", content: "day2" }));

    const day1 = store.readDate(testAgent, "2026-05-17");
    const day2 = store.readDate(testAgent, "2026-05-18");

    expect(day1).toHaveLength(1);
    expect(day1[0].content).toBe("day1");
    expect(day2).toHaveLength(1);
    expect(day2[0].content).toBe("day2");
  });
});

/* ------------------------------------------------------------------ */
/*  readRecent                                                         */
/* ------------------------------------------------------------------ */

describe("readRecent", () => {
  test("returns most recent events across files", () => {
    store.append(testAgent, makeEvent({ timestamp: "2026-05-17T10:00:00.000Z", content: "old" }));
    store.append(testAgent, makeEvent({ timestamp: "2026-05-18T10:00:00.000Z", content: "mid" }));
    store.append(testAgent, makeEvent({ timestamp: "2026-05-19T10:00:00.000Z", content: "new" }));

    const recent = store.readRecent(testAgent, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe("new");
    expect(recent[1].content).toBe("mid");
  });

  test("readRecent with count 0 returns empty", () => {
    store.append(testAgent, makeEvent({ content: "something" }));
    const recent = store.readRecent(testAgent, 0);
    expect(recent).toEqual([]);
  });

  test("readRecent returns all events when count exceeds total", () => {
    store.append(testAgent, makeEvent({ content: "a" }));
    store.append(testAgent, makeEvent({ content: "b" }));

    const recent = store.readRecent(testAgent, 100);
    expect(recent).toHaveLength(2);
  });

  test("readRecent returns empty for agent with no sessions", () => {
    const recent = store.readRecent("nonexistent", 10);
    expect(recent).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Truncated-tail recovery                                            */
/* ------------------------------------------------------------------ */

describe("recover", () => {
  test("recover does nothing on a clean file", () => {
    store.append(testAgent, makeEvent({ content: "clean" }));
    const result = store.recover(testAgent, "2026-05-17");
    expect(result).toBeNull();

    const events = store.readDate(testAgent, "2026-05-17");
    expect(events).toHaveLength(1);
  });

  test("recover discards truncated last line and logs recovery event", () => {
    // Manually write a file with a corrupted tail
    const filePath = join(testDir, "rooms", testAgent, "sessions", "2026-05-17.jsonl");
    mkdirSync(join(testDir, "rooms", testAgent, "sessions"), { recursive: true });
    writeFileSync(
      filePath,
      '{"timestamp":"2026-05-17T10:00:00Z","type":"good","sessionId":"s1"}\n{"timestamp":"2026-05-17T10:01:00Z","type","truncated',
      "utf-8",
    );

    const result = store.recover(testAgent, "2026-05-17");
    expect(result).not.toBeNull();
    expect(result!.linesDiscarded).toBe(1);
    expect(result!.agent).toBe(testAgent);
    expect(result!.date).toBe("2026-05-17");

    // Verify clean events remain and recovery event was appended
    const events = store.readDate(testAgent, "2026-05-17");
    // The good line + the recovery event
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe("good");
    expect(events[events.length - 1].type).toBe("recovery");
    expect(events[events.length - 1].reason).toBe("truncated_tail");
  });

  test("recover on nonexistent file returns null", () => {
    const result = store.recover(testAgent, "2099-01-01");
    expect(result).toBeNull();
  });

  test("recover on empty file returns null", () => {
    const filePath = join(testDir, "rooms", testAgent, "sessions", "2026-05-17.jsonl");
    mkdirSync(join(testDir, "rooms", testAgent, "sessions"), { recursive: true });
    writeFileSync(filePath, "", "utf-8");

    const result = store.recover(testAgent, "2026-05-17");
    expect(result).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Concurrent appends                                                 */
/* ------------------------------------------------------------------ */

describe("concurrent appends", () => {
  test("concurrent appends all persist", () => {
    const event = makeEvent({ timestamp: "2026-05-17T10:00:00.000Z" });
    const count = 10;

    // Synchronous appends in quick succession (Bun single-threaded execution)
    for (let i = 0; i < count; i++) {
      store.append(testAgent, {
        ...event,
        timestamp: `2026-05-17T10:00:${String(i).padStart(2, "0")}.000Z`,
        index: i,
      });
    }

    const events = store.readDate(testAgent, "2026-05-17");
    expect(events).toHaveLength(count);

    const indexes = events.map((e) => e.index as number);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("atomic write via concurrent Promise.all", async () => {
    const event = makeEvent({ timestamp: "2026-05-17T10:00:00.000Z" });
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      promises.push(
        Promise.resolve().then(() => {
          store.append(testAgent, {
            ...event,
            timestamp: `2026-05-17T10:00:${String(i).padStart(2, "0")}.000Z`,
            index: i,
          });
        }),
      );
    }

    await Promise.all(promises);

    const events = store.readDate(testAgent, "2026-05-17");
    expect(events).toHaveLength(20);
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("edge cases", () => {
  test("event requires timestamp, type, and sessionId", () => {
    const event: JsonlEvent = {
      timestamp: "2026-05-17T12:00:00.000Z",
      type: "message",
      sessionId: "sid-1",
      body: "hello",
    };
    store.append(testAgent, event);

    const events = store.readDate(testAgent, "2026-05-17");
    expect(events[0].timestamp).toBe("2026-05-17T12:00:00.000Z");
    expect(events[0].type).toBe("message");
    expect(events[0].sessionId).toBe("sid-1");
    expect(events[0].body).toBe("hello");
  });

  test("extractDate works correctly", () => {
    expect(extractDate("2026-05-17T12:00:00.000Z")).toBe("2026-05-17");
    expect(extractDate("2026-01-01T00:00:00.000Z")).toBe("2026-01-01");
    expect(extractDate("2025-12-31T23:59:59.999Z")).toBe("2025-12-31");
  });

  test("create the sessions dir on first append", () => {
    const dir = join(testDir, "rooms", testAgent, "sessions");
    expect(existsSync(dir)).toBe(false);

    store.append(testAgent, makeEvent({}));

    expect(existsSync(dir)).toBe(true);
  });

  test("JSONL file has one event per line, each valid JSON", () => {
    store.append(testAgent, makeEvent({ content: "a" }));
    store.append(testAgent, makeEvent({ content: "b" }));

    const filePath = join(testDir, "rooms", testAgent, "sessions", "2026-05-17.jsonl");
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
