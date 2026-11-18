import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store";
import { SessionManager } from "../src/session/manager";

let tempDir: string;
let dbPath: string;
let store: SessionStore;
let manager: SessionManager;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-session-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(tempDir, "sessions.db");
  store = new SessionStore(dbPath);
  manager = new SessionManager({ store, maxTokens: 2500 }); // ~10k chars threshold
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("openSession creates a new session", () => {
  const session = manager.openSession("bruno", "telegram");

  expect(session.id).toBeTruthy();
  expect(session.agent).toBe("bruno");
  expect(session.channel).toBe("telegram");
  expect(session.ended).toBeNull();
});

test("openSession returns existing active session", () => {
  const s1 = manager.openSession("bruno", "telegram");
  const s2 = manager.openSession("bruno", "telegram");

  expect(s1.id).toBe(s2.id);
});

test("appendTurn and getTurns work correctly", () => {
  const session = manager.openSession("bruno", "telegram");

  manager.appendTurn(session.id, "user", "hello");
  manager.appendTurn(session.id, "assistant", "hello back");

  const turns = manager.getTurns(session.id);
  expect(turns.length).toBe(2);
  expect(turns[0].role).toBe("user");
  expect(turns[0].content).toBe("hello");
  expect(turns[1].role).toBe("assistant");
  expect(turns[1].content).toBe("hello back");
});

test("closeSession ends the session", () => {
  const session = manager.openSession("bruno", "telegram");
  manager.closeSession("bruno", "telegram");

  const retrieved = store.getSession(session.id);
  expect(retrieved).not.toBeNull();
  expect(retrieved!.ended).not.toBeNull();
});

test("resetSession deletes all turns", () => {
  const session = manager.openSession("bruno", "telegram");

  manager.appendTurn(session.id, "user", "hello");
  manager.appendTurn(session.id, "assistant", "back");

  expect(manager.getTurns(session.id).length).toBe(2);

  manager.resetSession(session.id);
  expect(manager.getTurns(session.id).length).toBe(0);
});

test("checkCompaction returns needed above threshold", () => {
  const session = manager.openSession("bruno", "telegram");

  // maxTokens = 2500, softThreshold = 0.70 => 1750 tokens = 7000 chars
  // hardThreshold = 0.85 => 2125 tokens = 8500 chars
  // Add turns that exceed soft but not hard threshold
  const longContent = "x".repeat(2500); // 3 turns * 2500 = 7500 chars = 1875 tokens (75% > 70% soft, < 85% hard)
  manager.appendTurn(session.id, "user", longContent);
  manager.appendTurn(session.id, "assistant", longContent);
  manager.appendTurn(session.id, "user", longContent);

  const result = manager.checkCompaction(session.id);
  expect(result.needed).toBe(true);
  expect(result.level).toBe("soft");
});

test("checkCompaction returns not needed below threshold", () => {
  const session = manager.openSession("bruno", "telegram");

  manager.appendTurn(session.id, "user", "short");

  const result = manager.checkCompaction(session.id);
  expect(result.needed).toBe(false);
});

test("compact deletes older turns keeping protected recent", async () => {
  const session = manager.openSession("bruno", "telegram");

  // Add 8 turns
  for (let i = 1; i <= 8; i++) {
    manager.appendTurn(session.id, i % 2 === 1 ? "user" : "assistant", `turn ${i}`);
  }

  const result = await manager.compact(session.id, "soft");
  expect(result.deleted).toBe(2); // 8 - 6 protected = 2 deleted

  const remaining = manager.getTurns(session.id);
  expect(remaining.length).toBe(6);
  expect(remaining[0].content).toBe("turn 3");
  expect(remaining[5].content).toBe("turn 8");
});

// ── Branch-aware compact ────────────────────────────────────────────────

test("compact scoped to active branch only deletes turns on that branch", async () => {
  const session = manager.openSession("bruno", "telegram");
  const main = store.getActiveBranch(session.id)!;

  const m1 = store.appendTurn(session.id, "user", "main 1", main.id);
  store.appendTurn(session.id, "assistant", "main 2", main.id);

  // Fork from m1
  const light = store.createBranch(session.id, "light", main.id, m1.id);
  for (let i = 1; i <= 10; i++) {
    store.appendTurn(session.id, i % 2 === 1 ? "user" : "assistant", `light ${i}`, light.id);
  }
  store.setActiveBranch(session.id, light.id);

  // 10 turns on light branch, keepLast=6 → delete 4
  const result = await manager.compact(session.id, "soft");
  expect(result.deleted).toBe(4);

  // Main branch turns should still be present
  const mainTurns = store.getTurnsForBranch(main.id);
  expect(mainTurns.map((t) => t.content)).toEqual(["main 1", "main 2"]);

  // Light branch: ancestors (m1) + last 6 light turns
  const lightTurns = store.getTurnsForBranch(light.id);
  expect(lightTurns.map((t) => t.content)).toEqual([
    "main 1",
    "light 5", "light 6", "light 7", "light 8", "light 9", "light 10",
  ]);
});

test("getActiveBranchTurns returns branch lineage when active branch exists", async () => {
  const session = manager.openSession("bruno", "telegram");
  const main = store.getActiveBranch(session.id)!;

  store.appendTurn(session.id, "user", "main 1", main.id);
  const m2 = store.appendTurn(session.id, "assistant", "main 2", main.id);

  const branch = store.createBranch(session.id, "explore", main.id, m2.id);
  store.appendTurn(session.id, "user", "branch 1", branch.id);
  store.setActiveBranch(session.id, branch.id);
  store.appendTurn(session.id, "assistant", "branch 2", branch.id);

  const branchTurns = manager.getActiveBranchTurns(session.id);
  expect(branchTurns.map((t) => t.content)).toEqual([
    "main 1", "main 2", "branch 1", "branch 2",
  ]);
});

test("getActiveBranchTurns falls back to flat turns when no branch", async () => {
  const session = manager.openSession("bruno", "telegram");
  // Should still work even with branches but fallback to flat
  const turns = manager.getActiveBranchTurns(session.id);
  expect(Array.isArray(turns)).toBe(true);
});

// ── onEnd hook ──────────────────────────────────────────────────────────────

test("newSession fires onEnd for existing active session", async () => {
  const calls: Array<{ sessionId: string; agent: string }> = [];
  const mgr = new SessionManager({
    store,
    onEnd: async (sessionId, agent) => {
      calls.push({ sessionId, agent });
    },
  });

  const s1 = mgr.openSession("bruno", "telegram");
  mgr.appendTurn(s1.id, "user", "hello");

  // newSession should trigger onEnd for the old session
  const s2 = mgr.newSession("bruno", "telegram");

  expect(calls.length).toBe(1);
  expect(calls[0].sessionId).toBe(s1.id);
  expect(calls[0].agent).toBe("bruno");
  expect(s2.id).not.toBe(s1.id);

  // Old session should be ended
  const ended = store.getSession(s1.id);
  expect(ended?.ended).not.toBeNull();
});

test("onEnd does not fire when no active session exists", async () => {
  const calls: Array<{ sessionId: string; agent: string }> = [];
  const mgr = new SessionManager({
    store,
    onEnd: async (sessionId, agent) => {
      calls.push({ sessionId, agent });
    },
  });

  // No active session yet, newSession should create fresh without onEnd
  const session = mgr.newSession("bruno", "telegram");
  expect(calls.length).toBe(0);
});

test("closeSession fires onEnd for active session", async () => {
  const calls: Array<{ sessionId: string; agent: string }> = [];
  const mgr = new SessionManager({
    store,
    onEnd: async (sessionId, agent) => {
      calls.push({ sessionId, agent });
    },
  });

  const session = mgr.openSession("bruno", "telegram");
  mgr.closeSession("bruno", "telegram");

  expect(calls.length).toBe(1);
  expect(calls[0].sessionId).toBe(session.id);
  expect(calls[0].agent).toBe("bruno");
});

test("onEnd errors are caught and do not propagate", async () => {
  const mgr = new SessionManager({
    store,
    onEnd: async () => {
      throw new Error("onEnd crash");
    },
  });

  const session = mgr.openSession("bruno", "telegram");
  // Should not throw
  mgr.closeSession("bruno", "telegram");

  // Session should still be ended despite onEnd error
  const ended = store.getSession(session.id);
  expect(ended?.ended).not.toBeNull();
});

test("compact on main branch does not touch fork branches", async () => {
  const session = manager.openSession("bruno", "telegram");
  const main = store.getActiveBranch(session.id)!;

  const m1 = store.appendTurn(session.id, "user", "main 1", main.id);
  store.appendTurn(session.id, "assistant", "main 2", main.id);
  store.appendTurn(session.id, "user", "main 3", main.id);
  store.appendTurn(session.id, "assistant", "main 4", main.id);
  store.appendTurn(session.id, "user", "main 5", main.id);
  store.appendTurn(session.id, "assistant", "main 6", main.id);
  store.appendTurn(session.id, "user", "main 7", main.id);
  store.appendTurn(session.id, "assistant", "main 8", main.id);

  // Fork a branch from turn 2
  const light = store.createBranch(session.id, "light", main.id, m1.id);
  store.appendTurn(session.id, "user", "light exclusive", light.id);

  // Compact on main, 8 turns, keepLast=6 → delete 2
  const result = await manager.compact(session.id, "soft");
  expect(result.deleted).toBe(2);

  // Light branch should still have its exclusive turn
  const lightTurns = store.getTurnsForBranch(light.id);
  expect(lightTurns.map((t) => t.content)).toContain("light exclusive");
});
