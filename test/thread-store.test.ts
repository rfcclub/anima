import { describe, expect, test } from "bun:test";
import { ThreadStore } from "../src/memory/thread-store";

/* ------------------------------------------------------------------ */
/*  Messages stored and retrieved in order                              */
/* ------------------------------------------------------------------ */

describe("ThreadStore — store and retrieve", () => {
  test("single message is returned", () => {
    const store = new ThreadStore();
    store.add("ch-1", "agent-a", "user", "hello");

    const thread = store.getThread("ch-1", "agent-a");
    expect(thread).toEqual([{ role: "user", content: "hello" }]);
  });

  test("multiple messages are returned in order", () => {
    const store = new ThreadStore();
    store.add("ch-1", "agent-a", "user", "question");
    store.add("ch-1", "agent-a", "assistant", "answer");
    store.add("ch-1", "agent-a", "user", "follow-up");

    const thread = store.getThread("ch-1", "agent-a");
    expect(thread).toHaveLength(3);
    expect(thread[0]).toEqual({ role: "user", content: "question" });
    expect(thread[1]).toEqual({ role: "assistant", content: "answer" });
    expect(thread[2]).toEqual({ role: "user", content: "follow-up" });
  });

  test("getThread returns empty for unknown thread", () => {
    const store = new ThreadStore();
    expect(store.getThread("unknown", "agent")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Window trimmed at 20 (oldest evicted)                               */
/* ------------------------------------------------------------------ */

describe("ThreadStore — 20-message window", () => {
  test("exactly 20 messages are kept", () => {
    const store = new ThreadStore();
    for (let i = 0; i < 20; i++) {
      store.add("ch-1", "agent-a", i % 2 === 0 ? "user" : "assistant", `msg-${i}`);
    }

    const thread = store.getThread("ch-1", "agent-a");
    expect(thread).toHaveLength(20);
    expect(thread[0].content).toBe("msg-0");
    expect(thread[19].content).toBe("msg-19");
  });

  test("21st message evicts oldest", () => {
    const store = new ThreadStore();
    for (let i = 0; i < 21; i++) {
      store.add("ch-1", "agent-a", "user", `msg-${i}`);
    }

    const thread = store.getThread("ch-1", "agent-a");
    expect(thread).toHaveLength(20);
    expect(thread[0].content).toBe("msg-1"); // msg-0 evicted
    expect(thread[19].content).toBe("msg-20");
  });

  test("keeps trimming as more messages arrive", () => {
    const store = new ThreadStore();
    for (let i = 0; i < 50; i++) {
      store.add("ch-1", "agent-a", "user", `msg-${i}`);
    }

    const thread = store.getThread("ch-1", "agent-a");
    expect(thread).toHaveLength(20);
    expect(thread[0].content).toBe("msg-30"); // first 30 evicted
    expect(thread[19].content).toBe("msg-49");
  });
});

/* ------------------------------------------------------------------ */
/*  Threads are isolated per (channelId, agentName)                     */
/* ------------------------------------------------------------------ */

describe("ThreadStore — thread isolation", () => {
  test("different agents in same channel are separate", () => {
    const store = new ThreadStore();
    store.add("ch-1", "agent-a", "user", "for-a");
    store.add("ch-1", "agent-b", "user", "for-b");

    expect(store.getThread("ch-1", "agent-a")).toEqual([{ role: "user", content: "for-a" }]);
    expect(store.getThread("ch-1", "agent-b")).toEqual([{ role: "user", content: "for-b" }]);
  });

  test("same agent in different channels is separate", () => {
    const store = new ThreadStore();
    store.add("ch-1", "agent-a", "user", "in-ch1");
    store.add("ch-2", "agent-a", "user", "in-ch2");

    expect(store.getThread("ch-1", "agent-a")).toEqual([{ role: "user", content: "in-ch1" }]);
    expect(store.getThread("ch-2", "agent-a")).toEqual([{ role: "user", content: "in-ch2" }]);
  });
});

/* ------------------------------------------------------------------ */
/*  clear() removes thread                                              */
/* ------------------------------------------------------------------ */

describe("ThreadStore — clear", () => {
  test("clear removes all messages in a thread", () => {
    const store = new ThreadStore();
    store.add("ch-1", "agent-a", "user", "msg-1");
    store.add("ch-1", "agent-a", "assistant", "msg-2");

    store.clear("ch-1", "agent-a");
    expect(store.getThread("ch-1", "agent-a")).toEqual([]);
  });

  test("clear does not affect other threads", () => {
    const store = new ThreadStore();
    store.add("ch-1", "agent-a", "user", "keep-this");
    store.add("ch-1", "agent-b", "user", "clear-this");

    store.clear("ch-1", "agent-b");
    expect(store.getThread("ch-1", "agent-a")).toEqual([{ role: "user", content: "keep-this" }]);
    expect(store.getThread("ch-1", "agent-b")).toEqual([]);
  });

  test("clear on nonexistent thread is a no-op", () => {
    const store = new ThreadStore();
    expect(() => store.clear("nope", "nope")).not.toThrow();
    expect(store.getThread("nope", "nope")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  LRU eviction when >100 threads                                      */
/* ------------------------------------------------------------------ */

describe("ThreadStore — LRU eviction", () => {
  test("evicts least-recently-used thread when cap exceeded", () => {
    const store = new ThreadStore();

    // Create 100 threads
    for (let i = 0; i < 100; i++) {
      store.add("ch-1", `agent-${i}`, "user", `first-msg-${i}`);
    }

    // 101st thread should evict agent-0 (oldest/least recently used)
    store.add("ch-1", "agent-100", "user", "newcomer");

    expect(store.getThread("ch-1", "agent-0")).toEqual([]); // evicted
    expect(store.getThread("ch-1", "agent-100")).toEqual([{ role: "user", content: "newcomer" }]);
  });

  test("accessing a thread refreshes its LRU position", () => {
    const store = new ThreadStore();

    // Create 100 threads
    for (let i = 0; i < 100; i++) {
      store.add("ch-1", `agent-${i}`, "user", `msg-${i}`);
    }

    // Re-access agent-0 to make it most recently used
    store.getThread("ch-1", "agent-0");

    // Now add 101st thread — agent-1 should be evicted (oldest not refreshed)
    store.add("ch-1", "agent-100", "user", "newcomer");

    expect(store.getThread("ch-1", "agent-0")).toEqual([{ role: "user", content: "msg-0" }]); // survived
    expect(store.getThread("ch-1", "agent-1")).toEqual([]); // evicted
  });

  test("total thread count never exceeds 100", () => {
    const store = new ThreadStore();

    for (let i = 0; i < 150; i++) {
      store.add("ch-1", `agent-${i}`, "user", `msg-${i}`);
    }

    // After 150 adds: agents 0-49 evicted, agents 50-149 survive (100 threads)
    expect(store.getThread("ch-1", "agent-0")).toEqual([]); // evicted
    expect(store.getThread("ch-1", "agent-49")).toEqual([]); // evicted (last evicted)
    expect(store.getThread("ch-1", "agent-50")).toEqual([{ role: "user", content: "msg-50" }]); // survives
    expect(store.getThread("ch-1", "agent-149")).toEqual([{ role: "user", content: "msg-149" }]); // survives
  });
});
