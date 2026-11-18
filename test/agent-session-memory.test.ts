import { beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../src/agents/session";
import type { LoadedAgent } from "../src/agents/loader";
import type { MemoryAdapter, MemoryEntry, RecallOptions } from "../src/memory/adapter";
import { JsonlStore } from "../src/memory/jsonl-store";
import { ThreadStore } from "../src/memory/thread-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

let tempDir: string;
let store: JsonlStore;
let threadStore: ThreadStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-session-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlStore(tempDir);
  threadStore = new ThreadStore();
});

/* ------------------------------------------------------------------ */
/*  5.1: recall() result injected as [Memory Context] in system prompt */
/* ------------------------------------------------------------------ */
test("recall entries appended as [Memory Context] to system prompt", async () => {
  const adapter = trackingAdapter();
  adapter._recallResult = [
    { namespace: "cleo", content: "user prefers short responses", type: "fact" as const, timestamp: "2026-05-18T00:00:00Z" },
    { namespace: "cleo", content: "project uses Bun runtime", type: "fact" as const, timestamp: "2026-05-18T00:00:00Z" },
  ];

  let capturedSystem = "";
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      capturedSystem = req.system ?? "";
      return response("ok");
    }),
    log: () => {},
  });

  await session.run({
    agent: testAgent(),
    message: "hello",
    sessionId: "s1",
    memoryAdapter: adapter,
  });

  expect(capturedSystem).toContain("[Memory Context]");
  expect(capturedSystem).toContain("user prefers short responses");
  expect(capturedSystem).toContain("project uses Bun runtime");
});

/* ------------------------------------------------------------------ */
/*  5.2: Empty recall → no [Memory Context] section                    */
/* ------------------------------------------------------------------ */
test("empty recall produces no [Memory Context] in system prompt", async () => {
  const adapter = trackingAdapter();
  adapter._recallResult = [];

  let capturedSystem = "";
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      capturedSystem = req.system ?? "";
      return response("ok");
    }),
    log: () => {},
  });

  await session.run({
    agent: testAgent(),
    message: "hello",
    sessionId: "s2",
    memoryAdapter: adapter,
  });

  expect(capturedSystem).not.toContain("[Memory Context]");
});

/* ------------------------------------------------------------------ */
/*  5.3: recall() error is suppressed, session continues               */
/* ------------------------------------------------------------------ */
test("recall error is suppressed and session continues", async () => {
  const adapter = trackingAdapter();
  adapter._recallError = new Error("recall failed");

  let reachedProvider = false;
  const session = new AgentSession({
    store,
    provider: provider(async () => {
      reachedProvider = true;
      return response("ok despite error");
    }),
    log: () => {},
  });

  const result = await session.run({
    agent: testAgent(),
    message: "hello",
    sessionId: "s3",
    memoryAdapter: adapter,
  });

  expect(reachedProvider).toBe(true);
  expect(result.response.message.content).toBe("ok despite error");
});

/* ------------------------------------------------------------------ */
/*  5.4: store() called after successful response with correct content */
/* ------------------------------------------------------------------ */
test("store called with correct message exchange after response", async () => {
  const adapter = trackingAdapter();
  const session = new AgentSession({
    store,
    provider: provider(async () => response("hi back")),
    log: () => {},
  });

  await session.run({
    agent: testAgent(),
    message: "hi there",
    sessionId: "s4",
    memoryAdapter: adapter,
  });

  expect(adapter._storedEntries.length).toBe(1);
  const entry = adapter._storedEntries[0];
  expect(entry.namespace).toBe("cleo");
  expect(entry.type).toBe("message");
  expect(entry.content).toContain("User: hi there");
  expect(entry.content).toContain("Assistant: hi back");
  expect(entry.timestamp).toMatch(/\d{4}-/);
});

/* ------------------------------------------------------------------ */
/*  5.5: store() error is suppressed, result still returned            */
/* ------------------------------------------------------------------ */
test("store error is suppressed and result is still returned", async () => {
  const adapter = trackingAdapter();
  adapter._storeError = new Error("store failed");

  const session = new AgentSession({
    store,
    provider: provider(async () => response("success anyway")),
    log: () => {},
  });

  const result = await session.run({
    agent: testAgent(),
    message: "hello",
    sessionId: "s5",
    memoryAdapter: adapter,
  });

  expect(result.response.message.content).toBe("success anyway");
});

/* ------------------------------------------------------------------ */
/*  5.6: Thread turns prepended to messages when channelId + threadStore */
/* ------------------------------------------------------------------ */
test("thread turns prepended to messages with channelId and threadStore", async () => {
  // Seed the thread store with prior turns
  threadStore.add("ch-1", "cleo", "user", "earlier question");
  threadStore.add("ch-1", "cleo", "assistant", "earlier answer");

  let capturedMessages: Array<{ role: string; content: string }> = [];
  const session = new AgentSession({
    store,
    provider: provider(async (req) => {
      capturedMessages = req.messages.map((m) => ({ role: m.role, content: m.content }));
      return response("final answer");
    }),
    log: () => {},
  });

  await session.run({
    agent: testAgent(),
    message: "current question",
    sessionId: "s6",
    channelId: "ch-1",
    threadStore,
  });

  expect(capturedMessages.length).toBe(3);
  expect(capturedMessages[0]).toEqual({ role: "user", content: "earlier question" });
  expect(capturedMessages[1]).toEqual({ role: "assistant", content: "earlier answer" });
  expect(capturedMessages[2]).toEqual({ role: "user", content: "current question" });
});

/* ------------------------------------------------------------------ */
/*  5.7: Thread updated (add x2) after successful channel response     */
/* ------------------------------------------------------------------ */
test("thread updated with user and assistant after successful response", async () => {
  const session = new AgentSession({
    store,
    provider: provider(async () => response("reply")),
    log: () => {},
  });

  await session.run({
    agent: testAgent(),
    message: "say something",
    sessionId: "s7",
    channelId: "ch-2",
    threadStore,
  });

  const thread = threadStore.getThread("ch-2", "cleo");
  expect(thread.length).toBe(2);
  expect(thread[0]).toEqual({ role: "user", content: "say something" });
  expect(thread[1]).toEqual({ role: "assistant", content: "reply" });
});

/* ------------------------------------------------------------------ */
/*  5.8: Thread NOT updated when provider throws                       */
/* ------------------------------------------------------------------ */
test("thread not updated when provider throws", async () => {
  const session = new AgentSession({
    store,
    provider: provider(async () => {
      throw new Error("provider failure");
    }),
    log: () => {},
  });

  await expect(
    session.run({
      agent: testAgent(),
      message: "this will fail",
      sessionId: "s8",
      channelId: "ch-3",
      threadStore,
    }),
  ).rejects.toThrow("provider failure");

  // Thread should be empty — no turns added on failure
  const thread = threadStore.getThread("ch-3", "cleo");
  expect(thread.length).toBe(0);
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function trackingAdapter(): MemoryAdapter & { _recallResult: MemoryEntry[]; _recallError: Error | null; _storedEntries: MemoryEntry[]; _storeError: Error | null } {
  const stored: MemoryEntry[] = [];
  let recallResult: MemoryEntry[] = [];
  let recallError: Error | null = null;
  let storeError: Error | null = null;

  return {
    async store(entry: MemoryEntry): Promise<void> {
      if (storeError) throw storeError;
      stored.push(entry);
    },
    async recall(_query: string, _opts?: RecallOptions): Promise<MemoryEntry[]> {
      if (recallError) throw recallError;
      return recallResult;
    },
    get _recallResult() {
      return recallResult;
    },
    set _recallResult(v: MemoryEntry[]) {
      recallResult = v;
    },
    get _recallError() {
      return recallError;
    },
    set _recallError(v: Error | null) {
      recallError = v;
    },
    get _storedEntries() {
      return stored;
    },
    get _storeError() {
      return storeError;
    },
    set _storeError(v: Error | null) {
      storeError = v;
    },
  };
}

function provider(query?: (req: ProviderRequest) => Promise<ProviderResponse>): Provider {
  return {
    name: "claude",
    query: query ?? (async () => response("default")),
  };
}

function response(content: string): ProviderResponse {
  return {
    message: { role: "assistant", content },
  };
}

function testAgent(): LoadedAgent {
  return {
    name: "cleo",
    label: "Bodega Owner",
    roomDir: join(tempDir, "rooms", "cleo"),
    soulPath: "PREFACE.md",
    geneContent: "Core instructions.",
    soulContent: "You are Cleo.",
    sessionContextFiles: [{ path: "AGENTS.md", content: "Session context." }],
    additionalContent: [],
    config: {
      identity: { name: "cleo", label: "Bodega Owner" },
      provider: { type: "claude" },
      policy: {
        allowedRoots: [join(tempDir, "rooms", "cleo", "staging")],
        readOnlyRoots: [join(tempDir, "rooms", "cleo", "mount")],
        allowedTools: [],
      },
      session: { defaultMode: "plan", autoModeOptIn: false },
      boot: { gene: "PREFACE.md", soul: "PREFACE.md", sessionContext: [{ path: "AGENTS.md" }] },
    },
  };
}
