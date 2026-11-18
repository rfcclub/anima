import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionEndHandler, writeSessionSummary, formatBootstrapContent } from "../src/session/cross-session-memory";
import { SessionStore } from "../src/memory/session-store";
import type { AgentMemoryStore, AgentMemoryEntry } from "../src/memory/contract";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

// ── Fast in-memory AgentMemoryStore for testing ──────────────────────────────

class TestMemoryStore implements AgentMemoryStore {
  entries: AgentMemoryEntry[] = [];

  async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
    const stored: AgentMemoryEntry = {
      id: crypto.randomUUID(),
      ...entry,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(stored);
    return stored;
  }

  async recall(): Promise<AgentMemoryEntry[]> {
    return this.entries;
  }

  async bootstrap(): Promise<AgentMemoryEntry[]> {
    return this.entries;
  }
}

// ── Test provider that returns a canned summary ──────────────────────────────

function testProvider(responseContent?: string): Provider {
  return {
    name: "test",
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      return { message: { role: "assistant", content: responseContent ?? "Test summary of session." } };
    },
  };
}

let tempDir: string;
let dbPath: string;
let store: SessionStore;
let memoryStore: TestMemoryStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-cross-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(tempDir, "sessions.db");
  store = new SessionStore(dbPath);
  memoryStore = new TestMemoryStore();
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ── formatBootstrapContent ────────────────────────────────────────────────────

test("formatBootstrapContent formats non-empty string", () => {
  const result = formatBootstrapContent("- memory entry 1\n- memory entry 2");
  expect(result).toBe("## Bootstrap Memory\n\n- memory entry 1\n- memory entry 2");
});

test("formatBootstrapContent returns empty for undefined input", () => {
  expect(formatBootstrapContent("")).toBe("");
});

test("formatBootstrapContent returns empty for whitespace-only input", () => {
  expect(formatBootstrapContent("   \n  ")).toBe("");
});

// ── writeSessionSummary ───────────────────────────────────────────────────────

test("writeSessionSummary writes summary for non-empty turns", async () => {
  store.createSession("test-agent", "test");
  const session = store.getLatestSession("test-agent", "test")!;
  store.appendTurn(session.id, "user", "hello");
  store.appendTurn(session.id, "assistant", "hi there");
  const turns = store.getTurns(session.id);

  await writeSessionSummary(memoryStore, testProvider("Session summary here"), session.id, turns);

  expect(memoryStore.entries.length).toBe(1);
  expect(memoryStore.entries[0].content).toBe("Session summary here");
  expect(memoryStore.entries[0].tags).toContain(`session-${session.id}`);
  expect(memoryStore.entries[0].source).toBe("cross-session-memory");
});

test("writeSessionSummary skips empty turns", async () => {
  store.createSession("test-agent", "test");
  const session = store.getLatestSession("test-agent", "test")!;

  await writeSessionSummary(memoryStore, testProvider(), session.id, []);

  expect(memoryStore.entries.length).toBe(0);
});

// ── buildSessionEndHandler ────────────────────────────────────────────────────

test("buildSessionEndHandler fetches turns and writes summary", async () => {
  store.createSession("test-agent", "test");
  const session = store.getLatestSession("test-agent", "test")!;
  store.appendTurn(session.id, "user", "first message");
  store.appendTurn(session.id, "assistant", "first response");

  const handler = buildSessionEndHandler(memoryStore, testProvider("End-of-session summary"), store);
  await handler(session.id, "test-agent");

  expect(memoryStore.entries.length).toBe(1);
  expect(memoryStore.entries[0].content).toBe("End-of-session summary");
  expect(memoryStore.entries[0].tags).toContain(`session-${session.id}`);
});

test("buildSessionEndHandler does not crash when session has no turns", async () => {
  store.createSession("test-agent", "test");
  const session = store.getLatestSession("test-agent", "test")!;

  const handler = buildSessionEndHandler(memoryStore, testProvider(), store);
  // Should not throw
  await handler(session.id, "test-agent");

  expect(memoryStore.entries.length).toBe(0);
});

test("buildSessionEndHandler does not crash for unknown session ID", async () => {
  const handler = buildSessionEndHandler(memoryStore, testProvider(), store);
  // Should not throw
  await handler("nonexistent-session-id", "test-agent");
  expect(memoryStore.entries.length).toBe(0);
});
