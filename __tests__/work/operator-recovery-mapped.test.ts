import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkConfig } from "../../src/work/config";
import { WorkStore } from "../../src/work/store";

const WORK = "wmapped259";
const HEAD = "a".repeat(40);
let root: string;
let dbPath: string;
let store: WorkStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "work-recover-mapped-"));
  dbPath = join(root, "work.db");
  store = WorkStore.open(dbPath, { rootBase: root });
  const work = store.createWork({
    repo: "test/repo", issue: 7, approvedDigest: "a".repeat(12), workId: WORK,
    config: loadWorkConfig({ caps: { maxSessions: 1 } }),
  }).work;
  mkdirSync(work.root, { recursive: true });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function stop(options: { open?: boolean; status?: string } = {}) {
  const reservation = store.reserveSession(WORK, { jobId: "job", claimId: "claim" });
  if (!reservation.ok) throw new Error("reservation failed");
  if (!options.open) {
    store.closeSession(reservation.session.sessionId, { stopCause: "max_reached", iterations: 3, execMs: 1000 });
    store.recordStop({
      sessionId: reservation.session.sessionId, workId: WORK, adapter: "loop", stopCause: "max_reached",
      cessation: "proven", cessationCheck: null, head: HEAD, status: options.status ?? "",
      evidence: "unavailable", trusted: true, interrupted: false,
    });
  }
  store.setState(WORK, "blocked", "sessions exhausted");
}

async function service() {
  expect(existsSync(join(import.meta.dir, "../../src/work/recover.ts"))).toBe(true);
  return (await import("../../src/work/recover")).recoverWork;
}
const read = (_path: string, args: string[]) => args[0] === "rev-parse" ? HEAD : "";

describe("recovery mapped regression", () => {
  test("a trusted matching stop preserves usage and records recovery", async () => {
    stop();
    const before = store.getWork(WORK)!;
    const recover = await service();
    const after = await recover({ store, read }, { workId: WORK, caps: { maxSessions: 2 }, base: HEAD });
    expect([after.state, after.sessionsUsed, after.iterationsUsed, after.execMsUsed, after.generation])
      .toEqual(["checkpointed", before.sessionsUsed, before.iterationsUsed, before.execMsUsed, before.generation]);
    expect(store.listEvents(WORK).filter(e => e.kind === "operator-recovery")).toHaveLength(1);
  });

  test("an open session refuses recovery without ledger changes", async () => {
    stop({ open: true });
    const before = store.getWork(WORK);
    const events = store.listEvents(WORK);
    const recover = await service();
    await expect(recover({ store, read }, { workId: WORK, caps: { maxSessions: 2 }, base: HEAD })).rejects.toThrow(/open session/i);
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK)).toEqual(events);
  });

  test("a dirty checkpoint cannot establish matching contents", async () => {
    stop({ status: "?? pending.txt" });
    const recover = await service();
    await expect(recover({ store, read: (_p, args) => args[0] === "rev-parse" ? HEAD : "?? pending.txt" },
      { workId: WORK, caps: { maxSessions: 2 }, base: HEAD })).rejects.toThrow(/dirty|contents/i);
    expect(store.getWork(WORK)!.state).toBe("blocked");
  });

  test("audit failure rolls back the state and caps", async () => {
    stop();
    const before = store.getWork(WORK);
    const recover = await service();
    const db = new Database(dbPath);
    db.run("CREATE TRIGGER refuse_recovery BEFORE INSERT ON work_events WHEN NEW.kind = 'operator-recovery' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    try {
      await expect(recover({ store, read }, { workId: WORK, caps: { maxSessions: 2 }, base: HEAD })).rejects.toThrow(/audit unavailable/);
    } finally { db.close(); }
    expect(store.getWork(WORK)).toEqual(before);
    expect(store.listEvents(WORK).filter(e => e.kind === "operator-recovery")).toEqual([]);
  });
});
