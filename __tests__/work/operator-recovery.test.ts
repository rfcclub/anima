import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkConfig, type WorkCaps } from "../../src/work/config";
import { WorkStore, type SessionRecord, type WorkRecord } from "../../src/work/store";
import { acquireWorkLock } from "../../src/work/supervisor";
import type { TreeRead } from "../../src/work/stops";

const HEAD = "a".repeat(40);
const WORK = "wabc1234ef0";
let root: string;
let dbPath: string;
let store: WorkStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "work-operator-recovery-"));
  dbPath = join(root, "work.db");
  store = WorkStore.open(dbPath, { rootBase: root });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function create(): WorkRecord {
  const work = store.createWork({
    repo: "test/repo", issue: 7, approvedDigest: "a".repeat(12), workId: WORK,
    config: loadWorkConfig({ caps: { maxSessions: 1 } }),
  }).work;
  mkdirSync(work.root, { recursive: true });
  return work;
}

function ended(over: { stop?: boolean; trusted?: boolean; cessation?: "proven" | "unproven"; interrupted?: boolean; cause?: string; status?: string } = {}): SessionRecord {
  const work = create();
  const reserved = store.reserveSession(work.workId, { jobId: "job", claimId: "claim" });
  if (!reserved.ok) throw new Error("reservation failed");
  store.closeSession(reserved.session.sessionId, { iterations: 3, execMs: 1000, stopCause: over.cause ?? "max_reached" });
  if (over.stop !== false) {
    store.recordStop({
      sessionId: reserved.session.sessionId, workId: work.workId, adapter: "loop",
      stopCause: over.cause ?? "max_reached", cessation: over.cessation ?? "proven", cessationCheck: null,
      head: HEAD, status: over.status ?? "", evidence: "unavailable",
      trusted: over.trusted ?? true, interrupted: over.interrupted ?? false,
    });
  }
  store.setState(work.workId, "blocked", "sessions exhausted");
  return store.getSession(reserved.session.sessionId)!;
}

const tree: TreeRead = (_path, args) => args[0] === "rev-parse" ? `${HEAD}\n` : "";

async function recover(caps: Partial<WorkCaps> = {}, read: TreeRead = tree): Promise<WorkRecord> {
  // An assertion, rather than an import error, records RED before the service exists.
  expect(existsSync(join(import.meta.dir, "../../src/work/recover.ts"))).toBe(true);
  const { recoverWork } = await import("../../src/work/recover");
  return recoverWork({ store, read }, { workId: WORK, caps, base: HEAD });
}

describe("explicit blocked-work recovery", () => {
  test("a matching trusted stop recovers atomically without resetting usage", async () => {
    ended();
    const before = store.getWork(WORK)!;
    const out = await recover({ maxSessions: 4, maxIterationsPerSession: 40 });
    const after = store.getWork(WORK)!;
    expect(out).toEqual(after);
    expect(after.state).toBe("checkpointed");
    expect(after.blockedReason).toBeNull();
    expect([after.sessionsUsed, after.iterationsUsed, after.execMsUsed, after.generation])
      .toEqual([before.sessionsUsed, before.iterationsUsed, before.execMsUsed, before.generation]);
    expect(after.caps.maxSessions).toBe(4);
    expect(after.caps.maxIterationsPerSession).toBe(40);
    const events = store.listEvents(WORK).filter(e => e.kind === "operator-recovery");
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ previousReason: "sessions exhausted", previousCaps: before.caps, caps: after.caps, base: HEAD });
    expect(store.listSessions(WORK)).toHaveLength(1);
  });

  test("work with no reserved sessions is refused because it has no checkpoint", async () => {
    create();
    store.setState(WORK, "blocked", "preflight");
    await expect(recover()).rejects.toThrow(/no session checkpoint/i);
    expect(store.listSessions(WORK)).toEqual([]);
  });

  test.each(["queued", "accepted"] as const)("refuses %s work without changing it", async (state) => {
    create();
    store.setState(WORK, state);
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    await expect(recover()).rejects.toThrow(/blocked/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test("refuses an open session even if the work row is blocked", async () => {
    create();
    const reserved = store.reserveSession(WORK, { jobId: "job", claimId: "claim" });
    expect(reserved.ok).toBe(true);
    store.setState(WORK, "blocked", "not stopped");
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    await expect(recover({ maxSessions: 2 })).rejects.toThrow(/open session/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test.each([
    ["missing", { stop: false }],
    ["untrusted", { trusted: false }],
    ["unproven", { cessation: "unproven" as const }],
    ["interrupted record", { interrupted: true }],
    ["interrupted cause", { cause: "interrupted" }],
  ])("refuses a %s latest stop", async (_name, opts) => {
    ended(opts);
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    await expect(recover({ maxSessions: 2 })).rejects.toThrow(/stop|checkpoint|cessation|interrupt/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test.each([
    ["unknown session end", "UPDATE work_sessions SET ended_unknown = 1 WHERE work_id = ?"],
    ["unknown stop cause", "UPDATE work_stops SET stop_cause = 'unknown' WHERE work_id = ?"],
    ["conflicting stop cause", "UPDATE work_stops SET stop_cause = 'done' WHERE work_id = ?"],
    ["generation mismatch", "UPDATE works SET generation = generation + 1 WHERE work_id = ?"],
    ["inconsistent session count", "UPDATE works SET sessions_used = sessions_used + 1 WHERE work_id = ?"],
  ])("refuses a %s even if a stop is marked trusted", async (_name, sql) => {
    ended();
    const db = new Database(dbPath);
    try { db.run(sql, [WORK]); } finally { db.close(); }
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    await expect(recover({ maxSessions: 3 })).rejects.toThrow(/unknown|generation|session|stop/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test("refuses a changed or unreadable tree and a dirty checkpoint whose contents cannot be verified", async () => {
    ended();
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    await expect(recover({ maxSessions: 2 }, (_p, args) => args[0] === "rev-parse" ? "b".repeat(40) : "")).rejects.toThrow(/head|checkpoint/i);
    await expect(recover({ maxSessions: 2 }, () => { throw new Error("git unavailable"); })).rejects.toThrow(/tree|read/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);

    // Equal porcelain output does not prove equal file contents.
    const db = new Database(dbPath);
    try { db.run("UPDATE work_stops SET status = '?? pending.txt' WHERE work_id = ?", [WORK]); } finally { db.close(); }
    await expect(recover({ maxSessions: 2 }, (_p, args) => args[0] === "rev-parse" ? HEAD : "?? pending.txt")).rejects.toThrow(/dirty|contents/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test("refuses a held supervisor lock", async () => {
    const work = create();
    store.setState(WORK, "blocked", "preflight");
    const lock = acquireWorkLock(work.root);
    expect(lock).not.toBeNull();
    try { await expect(recover()).rejects.toThrow(/lock|supervisor/i); } finally { lock!.release(); }
    expect(store.getWork(WORK)!.state).toBe("blocked");
  });

  test.each([
    [{ maxSessions: 1 }, /session/i],
    [{ workWallMs: 1000, sessionWallMs: 1000, maxSessions: 2 }, /time|wall/i],
    [{ maxSessions: 0 }, /cap/i],
    [{ maxSessions: 2, sessionWallMs: 2_147_483_648 }, /timer|maximum/i],
    [{ extra: 2 } as unknown as Partial<WorkCaps>, /unknown/i],
  ])("refuses invalid or spent caps %# without changing the ledger", async (caps, reason) => {
    ended();
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    await expect(recover(caps)).rejects.toThrow(reason);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test("a failed audit event rolls back state and caps", async () => {
    ended();
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    const db = new Database(dbPath);
    db.run("CREATE TRIGGER refuse_recovery BEFORE INSERT ON work_events WHEN NEW.kind = 'operator-recovery' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    try { await expect(recover({ maxSessions: 2 })).rejects.toThrow(/audit unavailable/); } finally { db.close(); }
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test("CLI parses repeated --caps but refuses work with no checkpoint", async () => {
    create();
    store.setState(WORK, "blocked", "preflight");
    const { parseRecoveryArgs } = await import("../../src/work/recover");
    expect(parseRecoveryArgs(["recover", WORK, "--base", HEAD, "--caps", "maxSessions=9", "--caps", "maxIterationsPerSession=40"]))
      .toEqual({ workId: WORK, base: HEAD, caps: { maxSessions: 9, maxIterationsPerSession: 40 } });
    const p = Bun.spawnSync({
      cmd: ["bun", "src/cli.ts", "work", "recover", WORK, "--base", HEAD, "--caps", "maxSessions=9", "--caps", "maxIterationsPerSession=40"],
      env: { ...process.env, ANIMA_WORK_DB: dbPath, ANIMA_WORK_ROOT: root, NODE_ENV: "test" },
    });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toMatch(/no session checkpoint/i);
    const work = store.getWork(WORK)!;
    expect([work.state, work.sessionsUsed]).toEqual(["blocked", 0]);
  });

  test.each([
    ["--caps", "maxSessions=not-a-number"],
    ["--caps", "unknown=3"],
    ["--caps", "maxSessions=4", "--caps", "maxSessions=9"],
    ["--unexpected"],
  ])("CLI rejects malformed options %# without changing the ledger", (...flags) => {
    create();
    store.setState(WORK, "blocked", "preflight");
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    const p = Bun.spawnSync({
      cmd: ["bun", "src/cli.ts", "work", "recover", WORK, "--base", HEAD, ...flags],
      env: { ...process.env, ANIMA_WORK_DB: dbPath, ANIMA_WORK_ROOT: root, NODE_ENV: "test" },
    });
    expect(p.exitCode).not.toBe(0);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });
});
