import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store";
import { SessionManager } from "../src/session/manager";

let tempDir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(tempDir, "sessions.db");
  store = new SessionStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("creates a session", () => {
    const session = store.createSession("bruno", "telegram");
    expect(session.id).toBeTruthy();
    expect(session.agent).toBe("bruno");
    expect(session.channel).toBe("telegram");
    expect(session.started).toBeTruthy();
    expect(session.ended).toBeNull();

    const retrieved = store.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.agent).toBe("bruno");
  });

  test("schema includes branches table with constraints and indexes", () => {
    const db = (store as unknown as { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db;
    const columns = db.query("PRAGMA table_info(branches)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "session_id",
      "name",
      "parent_branch_id",
      "fork_from_turn_id",
      "created_at",
    ]);

    const uniqueIndexes = db.query("PRAGMA index_list(branches)").all() as Array<{ name: string; unique: number }>;
    expect(uniqueIndexes.some((idx) => idx.unique === 1)).toBe(true);

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain("idx_branches_session");
    expect(indexNames).toContain("idx_branches_parent");
  });

  test("schema includes nullable turns.branch_id column and index", () => {
    const db = (store as unknown as { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db;
    const columns = db.query("PRAGMA table_info(turns)").all() as Array<{ name: string; notnull: number }>;
    const branchColumn = columns.find((c) => c.name === "branch_id");
    expect(branchColumn).toBeDefined();
    expect(branchColumn!.notnull).toBe(0);

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    expect(indexes.map((idx) => idx.name)).toContain("idx_turns_branch");
  });

  test("creates branch records and rejects cross-session parents", () => {
    const first = store.createSession("bruno", "telegram");
    const second = store.createSession("eli", "ui");
    const main = store.createBranch(first.id, "main", null, null);

    const fork = store.createBranch(first.id, "fork", main.id, null);
    expect(fork.sessionId).toBe(first.id);
    expect(fork.name).toBe("fork");
    expect(fork.parentBranchId).toBe(main.id);
    expect(fork.forkFromTurnId).toBeNull();
    expect(fork.createdAt).toBeTruthy();

    expect(() => store.createBranch(second.id, "bad", main.id, null)).toThrow(/same session/);
  });

  test("lists branches for a session in creation order", () => {
    const first = store.createSession("bruno", "telegram");
    const second = store.createSession("eli", "ui");
    const main = store.createBranch(first.id, "main", null, null);
    const fork = store.createBranch(first.id, "fork", main.id, null);
    store.createBranch(second.id, "other-main", null, null);

    const branches = store.getBranches(first.id);
    expect(branches.map((branch) => branch.id)).toEqual([main.id, fork.id]);
    expect(branches.map((branch) => branch.name)).toEqual(["main", "fork"]);
  });

  test("gets the active branch for a session", () => {
    const session = store.createSession("bruno", "telegram");
    const main = store.createBranch(session.id, "main", null, null);
    const fork = store.createBranch(session.id, "fork", main.id, null);

    store.ensureMainBranch(session.id);
    expect(store.getActiveBranch(session.id)!.id).toBe(main.id);

    const db = (store as unknown as { db: { run: (sql: string, params: unknown[]) => unknown } }).db;
    db.run("UPDATE sessions SET active_branch_id = ? WHERE id = ?", [fork.id, session.id]);

    const active = store.getActiveBranch(session.id);
    expect(active).not.toBeNull();
    expect(active!.id).toBe(fork.id);
    expect(active!.name).toBe("fork");
    expect(store.getActiveBranch("missing")).toBeNull();
  });

  test("sets active branch and rejects branches from other sessions", () => {
    const first = store.createSession("bruno", "telegram");
    const second = store.createSession("eli", "ui");
    const main = store.createBranch(first.id, "main", null, null);
    const fork = store.createBranch(first.id, "fork", main.id, null);
    const other = store.createBranch(second.id, "main", null, null);

    store.setActiveBranch(first.id, fork.id);
    expect(store.getActiveBranch(first.id)!.id).toBe(fork.id);

    expect(() => store.setActiveBranch(first.id, other.id)).toThrow(/same session/);
    expect(store.getActiveBranch(first.id)!.id).toBe(fork.id);
  });

  test("deletes a leaf branch and soft-deletes only turns on that branch", () => {
    const session = store.createSession("bruno", "telegram");
    const main = store.createBranch(session.id, "main", null, null);
    const fork = store.createBranch(session.id, "fork", main.id, null);
    const mainTurn = store.appendTurn(session.id, "user", "main turn");
    const forkTurn = store.appendTurn(session.id, "assistant", "fork turn");
    const db = (store as unknown as { db: { run: (sql: string, params: unknown[]) => unknown } }).db;
    db.run("UPDATE turns SET branch_id = ? WHERE id = ?", [main.id, mainTurn.id]);
    db.run("UPDATE turns SET branch_id = ? WHERE id = ?", [fork.id, forkTurn.id]);

    store.deleteBranch(fork.id);

    expect(store.getBranches(session.id).map((branch) => branch.name)).toEqual(["main"]);
    expect(store.getTurns(session.id).map((turn) => turn.content)).toEqual(["main turn"]);
  });

  test("deleteBranch blocks when descendants exist and lists child names", () => {
    const session = store.createSession("bruno", "telegram");
    const main = store.createBranch(session.id, "main", null, null);
    store.createBranch(session.id, "child", main.id, null);

    expect(() => store.deleteBranch(main.id)).toThrow(/child/);
    expect(store.getBranches(session.id).map((branch) => branch.name)).toEqual(["main", "child"]);
  });

  test("getTurnsForBranch walks lineage chronologically with inclusive fork points", () => {
    const session = store.createSession("bruno", "telegram");
    const main = store.createBranch(session.id, "main", null, null);
    const t1 = store.appendTurn(session.id, "user", "main 1", main.id);
    const t2 = store.appendTurn(session.id, "assistant", "main 2", main.id);
    const t3 = store.appendTurn(session.id, "user", "main 3", main.id);

    const light = store.createBranch(session.id, "light", main.id, t2.id);
    const t4 = store.appendTurn(session.id, "user", "light 1", light.id);
    const t5 = store.appendTurn(session.id, "assistant", "light 2", light.id);

    const narrow = store.createBranch(session.id, "narrow", light.id, t4.id);
    const t6 = store.appendTurn(session.id, "user", "narrow 1", narrow.id);

    expect(store.getTurnsForBranch(main.id).map((turn) => turn.id)).toEqual([t1.id, t2.id, t3.id]);
    expect(store.getTurnsForBranch(light.id).map((turn) => turn.id)).toEqual([t1.id, t2.id, t4.id, t5.id]);
    expect(store.getTurnsForBranch(narrow.id).map((turn) => turn.id)).toEqual([t1.id, t2.id, t4.id, t6.id]);
  });

  test("softDeleteTurnsOnBranch compacts only turns owned by that branch", () => {
    const session = store.createSession("bruno", "telegram");
    const main = store.createBranch(session.id, "main", null, null);
    const m1 = store.appendTurn(session.id, "user", "main 1", main.id);
    const m2 = store.appendTurn(session.id, "assistant", "main 2", main.id);
    const m3 = store.appendTurn(session.id, "user", "main 3", main.id);
    const light = store.createBranch(session.id, "light", main.id, m2.id);
    const l1 = store.appendTurn(session.id, "user", "light 1", light.id);
    const l2 = store.appendTurn(session.id, "assistant", "light 2", light.id);
    const l3 = store.appendTurn(session.id, "user", "light 3", light.id);

    const deleted = store.softDeleteTurnsOnBranch(light.id, 1);

    expect(deleted).toBe(2);
    expect(store.getTurnsForBranch(main.id).map((turn) => turn.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(store.getTurnsForBranch(light.id).map((turn) => turn.id)).toEqual([m1.id, m2.id, l3.id]);
    expect(store.getTurns(session.id).map((turn) => turn.id)).toEqual([m1.id, m2.id, m3.id, l3.id]);
    expect(l1.id).toBeLessThan(l2.id);
  });

  test("getDescendantBranches returns all descendants in breadth-first order", () => {
    const session = store.createSession("bruno", "telegram");
    const main = store.createBranch(session.id, "main", null, null);
    const childA = store.createBranch(session.id, "child-a", main.id, null);
    const childB = store.createBranch(session.id, "child-b", main.id, null);
    const grandchild = store.createBranch(session.id, "grandchild", childA.id, null);

    expect(store.getDescendantBranches(main.id).map((branch) => branch.name)).toEqual(["child-a", "child-b", "grandchild"]);
    expect(store.getDescendantBranches(childB.id)).toEqual([]);
    expect(grandchild.parentBranchId).toBe(childA.id);
  });

  test("schema includes nullable sessions.active_branch_id column", () => {
    const db = (store as unknown as { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db;
    const columns = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string; notnull: number }>;
    const activeBranchColumn = columns.find((c) => c.name === "active_branch_id");
    expect(activeBranchColumn).toBeDefined();
    expect(activeBranchColumn!.notnull).toBe(0);
  });

  test("gets latest session by agent+channel", () => {
    const s1 = store.createSession("bruno", "telegram");
    store.endSession(s1.id);

    const s2 = store.createSession("bruno", "telegram");

    const latest = store.getLatestSession("bruno", "telegram");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(s2.id);
    expect(latest!.ended).toBeNull();
  });

  test("openSession creates one main branch and backfills legacy turns idempotently", () => {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });

    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE sessions (
        id      TEXT PRIMARY KEY,
        agent   TEXT NOT NULL,
        channel TEXT NOT NULL,
        started TEXT NOT NULL,
        ended   TEXT
      )
    `);
    legacy.run(`
      CREATE TABLE turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content    TEXT NOT NULL,
        ts         TEXT NOT NULL
      )
    `);
    legacy.run("INSERT INTO sessions (id, agent, channel, started) VALUES (?, ?, ?, ?)", [
      "legacy-session",
      "bruno",
      "telegram",
      "2026-05-26T00:00:00.000Z",
    ]);
    legacy.run("INSERT INTO turns (session_id, role, content, ts) VALUES (?, ?, ?, ?)", [
      "legacy-session",
      "user",
      "pre-existing turn",
      "2026-05-26T00:00:01.000Z",
    ]);
    legacy.close();

    store = new SessionStore(dbPath);
    const manager = new SessionManager({ store });
    const opened = manager.openSession("bruno", "telegram");
    expect(opened.id).toBe("legacy-session");
    manager.openSession("bruno", "telegram");

    const db = (store as unknown as { db: { query: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } } }).db;
    const branches = db.query("SELECT * FROM branches WHERE session_id = ?").all("legacy-session") as Array<{ id: number; name: string }>;
    expect(branches).toHaveLength(1);
    expect(branches[0].name).toBe("main");

    const session = db.query("SELECT active_branch_id FROM sessions WHERE id = ?").get("legacy-session") as { active_branch_id: number };
    expect(session.active_branch_id).toBe(branches[0].id);

    const turn = db.query("SELECT branch_id FROM turns WHERE session_id = ?").get("legacy-session") as { branch_id: number };
    expect(turn.branch_id).toBe(branches[0].id);
  });

  test("appends and retrieves turns", () => {
    const session = store.createSession("bruno", "telegram");

    store.appendTurn(session.id, "user", "hello");
    store.appendTurn(session.id, "assistant", "hi there");
    store.appendTurn(session.id, "user", "how are you?");

    const turns = store.getTurns(session.id);
    expect(turns.length).toBe(3);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("hello");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].content).toBe("hi there");
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toBe("how are you?");
  });

  test("ends a session", () => {
    const session = store.createSession("bruno", "telegram");
    expect(session.ended).toBeNull();

    store.endSession(session.id);

    const retrieved = store.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.ended).not.toBeNull();
  });

  test("soft deletes turns older than threshold", () => {
    const session = store.createSession("bruno", "telegram");

    // Append 4 turns
    store.appendTurn(session.id, "user", "turn 1");
    store.appendTurn(session.id, "assistant", "turn 2");
    store.appendTurn(session.id, "user", "turn 3");
    store.appendTurn(session.id, "assistant", "turn 4");

    const turns = store.getTurns(session.id);
    expect(turns.length).toBe(4);

    // Protected: last 2 turns (turns 3 and 4)
    // Cutoff: first protected turn is turn 3
    const protected_ = store.getProtectedTurns(session.id, 2);
    expect(protected_.length).toBe(2);
    const cutoffId = protected_[0].id;

    const deleted = store.softDeleteTurns(session.id, cutoffId);
    expect(deleted).toBe(2);

    const remaining = store.getTurns(session.id);
    expect(remaining.length).toBe(2);
    expect(remaining[0].content).toBe("turn 3");
    expect(remaining[1].content).toBe("turn 4");
  });

  test("protected turns returns last N", () => {
    const session = store.createSession("bruno", "telegram");

    for (let i = 1; i <= 6; i++) {
      store.appendTurn(session.id, i % 2 === 1 ? "user" : "assistant", `turn ${i}`);
    }

    const protected_ = store.getProtectedTurns(session.id, 3);
    expect(protected_.length).toBe(3);
    expect(protected_[0].content).toBe("turn 4");
    expect(protected_[1].content).toBe("turn 5");
    expect(protected_[2].content).toBe("turn 6");
  });
});

// SessionManager.checkCompaction()/compact() — previously untested anywhere
// in the codebase, and the only caller in src/cli.ts's plain `talk` command
// was unreachable dead code (sat after an early `return`). Without it, sessions
// started by `anima talk` without --loop accumulated turns forever with no
// automatic compaction ever firing.
describe("SessionManager compaction", () => {
  test("checkCompaction reports no compaction needed below the soft threshold", () => {
    const manager = new SessionManager({ store, maxTokens: 100 });
    const session = manager.openSession("bruno", "telegram");
    manager.appendTurn(session.id, "user", "short");

    expect(manager.checkCompaction(session.id)).toEqual({ needed: false });
  });

  test("checkCompaction reports soft level between the soft and hard thresholds", () => {
    const manager = new SessionManager({ store, maxTokens: 100 });
    const session = manager.openSession("bruno", "telegram");
    // maxTokens=100, ~4 chars/token: 300 chars ≈ 75 tokens ≈ 0.75 ratio (soft=0.70, hard=0.85)
    manager.appendTurn(session.id, "user", "x".repeat(300));

    const result = manager.checkCompaction(session.id);
    expect(result).toEqual({ needed: true, level: "soft" });
  });

  test("checkCompaction reports hard level above the hard threshold", () => {
    const manager = new SessionManager({ store, maxTokens: 100 });
    const session = manager.openSession("bruno", "telegram");
    // 400 chars ≈ 100 tokens ≈ 1.0 ratio, well past hard=0.85
    manager.appendTurn(session.id, "user", "x".repeat(400));

    const result = manager.checkCompaction(session.id);
    expect(result).toEqual({ needed: true, level: "hard" });
  });

  test("compact soft-deletes older turns but protects the most recent protectedRecentTurns", async () => {
    const manager = new SessionManager({ store, maxTokens: 100, compaction: { protectedRecentTurns: 2 } });
    const session = manager.openSession("bruno", "telegram");
    for (let i = 0; i < 10; i++) {
      manager.appendTurn(session.id, "user", `turn ${i}`);
    }
    expect(manager.getActiveBranchTurns(session.id)).toHaveLength(10);

    const result = await manager.compact(session.id, "hard");

    expect(result.deleted).toBe(8);
    const remaining = manager.getActiveBranchTurns(session.id);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.content)).toEqual(["turn 8", "turn 9"]);
  });
});
