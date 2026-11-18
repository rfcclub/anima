import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { BunContextEngineImpl } from "../../src/memory/context-store";

function freshEngine(): { engine: BunContextEngineImpl; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "anima-ctx-"));
  const dbPath = join(dir, "ctx.db");
  return { engine: new BunContextEngineImpl(dbPath), dbPath };
}

function readConversation(dbPath: string, conversationId: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT conversation_id, agent_id, platform FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as { conversation_id: string; agent_id: string; platform: string } | null;
  } finally {
    db.close();
  }
}

const sampleMsg = (conversation_id: string, seq = 1, id = "m-1") => ({
  id,
  conversation_id,
  seq,
  role: "user" as const,
  content: "hello",
  created_at: new Date().toISOString(),
  token_count: 1,
});

// Regression: session.ts:435 calls ingest with the ContextEngine interface
// shape — a single IngestInput object { conversationId, message } — but the
// BunContextEngine.ingest impl historically took two args (conversationId,
// message). The object was bound as conversationId, corrupting the INSERT
// and throwing `NOT NULL constraint failed: conversations.agent_id`.
test("ingest accepts the IngestInput object shape (one arg)", async () => {
  const { engine, dbPath } = freshEngine();
  await engine.initialize("lena", "anima");
  await engine.ingest({
    conversationId: "ui:lena:obj",
    message: sampleMsg("ui:lena:obj"),
  } as Parameters<typeof engine.ingest>[0]);
  const row = readConversation(dbPath, "ui:lena:obj");
  expect(row?.agent_id).toBe("lena");
});

// Backward-compat: talk.ts:860 calls ingest with two args (conversationId,
// message). This shape must keep working.
test("ingest accepts the two-arg shape (backward-compat)", async () => {
  const { engine, dbPath } = freshEngine();
  await engine.initialize("sam", "anima");
  await engine.ingest("ui:sam:twoarg", sampleMsg("ui:sam:twoarg"));
  const row = readConversation(dbPath, "ui:sam:twoarg");
  expect(row?.agent_id).toBe("sam");
});

// Mixed usage must not collide: an object-shape ingest and a two-arg ingest
// on the same conversation id must land in the same row.
test("both shapes land in the same conversation row", async () => {
  const { engine, dbPath } = freshEngine();
  await engine.initialize("bruno", "anima");
  const convId = "ui:bruno:mixed";
  await engine.ingest({ conversationId: convId, message: sampleMsg(convId, 1, "m-1") } as Parameters<typeof engine.ingest>[0]);
  await engine.ingest(convId, { ...sampleMsg(convId, 2, "m-2"), seq: 2 });
  const row = readConversation(dbPath, convId);
  expect(row?.agent_id).toBe("bruno");
});

// No "[object Object]" conversation rows should ever be created.
test("no [object Object] conversation leaks", async () => {
  const { engine, dbPath } = freshEngine();
  await engine.initialize("pia", "anima");
  await engine.ingest({ conversationId: "ui:pia:obj", message: sampleMsg("ui:pia:obj") } as Parameters<typeof engine.ingest>[0]);
  const db = new Database(dbPath, { readonly: true });
  const leaked = db.query("SELECT conversation_id FROM conversations WHERE conversation_id = '[object Object]'").all();
  db.close();
  expect(leaked).toEqual([]);
});
