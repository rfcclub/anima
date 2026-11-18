/**
 * castle-work-loop: the durable work store.
 * Temp directories only; never ~/.anima/work.db.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore, resolveWorkDbPath } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";

const dirs: string[] = [];
const stores: WorkStore[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "work-store-"));
  dirs.push(dir);
  return join(dir, "work.db");
}
function open(path = ":memory:"): WorkStore {
  const s = WorkStore.open(path);
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const config = () => loadWorkConfig({});
const base = { repo: "rfcclub/anima", issue: 7, approvedDigest: "d1d1d1d1d1d1", config: undefined as never };
const create = (s: WorkStore, over: Partial<typeof base> = {}) => s.createWork({ ...base, config: config(), ...over });

describe("identity (WL-1)", () => {
  test("the same repository, issue and digest returns the same active work", () => {
    const s = open();
    const a = create(s);
    const b = create(s);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.work.workId).toBe(a.work.workId);
    expect(s.listWorks().length).toBe(1);
  });

  test("the same issue number in two repositories gives two works with their own roots", () => {
    const s = open();
    const a = create(s, { repo: "a/x" });
    const b = create(s, { repo: "b/x" });
    expect(a.work.workId).not.toBe(b.work.workId);
    expect(a.work.root).toContain("a/x/");
    expect(b.work.root).toContain("b/x/");
  });

  test("a work records its pinned author, provider, model and materialised caps", () => {
    const s = open();
    const w = create(s).work;
    expect(w.author).toBe("finn");
    expect(w.provider).toBe("agnes");
    expect(w.model).toBe("agnes-3.0-flash");
    expect(w.caps.maxSessions).toBe(3);
    expect(w.state).toBe("queued");
    expect(w.branch).toBe(`work/7-${w.workId}`);
  });

  test("an id given by the job reference is kept", () => {
    const s = open();
    const w = create(s, { workId: "wabcdef0123" } as never).work;
    expect(w.workId).toBe("wabcdef0123");
  });

  test("a different digest while the first work is active is refused and blocks that work", () => {
    const s = open();
    const first = create(s).work;
    const second = create(s, { approvedDigest: "e2e2e2e2e2e2" });
    expect(second.created).toBe(false);
    expect(second.refused).toBe("approval changed");
    expect(s.getWork(first.workId)!.state).toBe("blocked");
    expect(s.getWork(first.workId)!.blockedReason).toContain("approval");
    expect(s.listWorks().length).toBe(1);
  });

  test("observeApproval blocks an active work whose issue digest changed and leaves a matching one alone", () => {
    const s = open();
    const w = create(s).work;
    s.observeApproval(w.workId, "d1d1d1d1d1d1");
    expect(s.getWork(w.workId)!.state).toBe("queued");
    s.observeApproval(w.workId, "ffffffffffff");
    expect(s.getWork(w.workId)!.state).toBe("blocked");
    expect(s.getWork(w.workId)!.blockedReason).toContain("approval");
  });

  test("after a work is accepted a new run of the same issue and digest gets a new work id", () => {
    const s = open();
    const a = create(s).work;
    s.setState(a.workId, "accepted");
    const b = create(s);
    expect(b.created).toBe(true);
    expect(b.work.workId).not.toBe(a.workId);
  });

  test("a blocked work still holds the slot, so no second writer starts", () => {
    const s = open();
    const a = create(s).work;
    s.setState(a.workId, "blocked", "isolation unavailable");
    const b = create(s);
    expect(b.created).toBe(false);
    expect(b.work.workId).toBe(a.workId);
  });
});

describe("sessions and caps (WL-9)", () => {
  test("three sessions are reserved and the fourth is refused with the work blocked", () => {
    const s = open();
    const w = create(s).work;
    for (let i = 1; i <= 3; i++) {
      const r = s.reserveSession(w.workId, { jobId: "j1", claimId: `c${i}` });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.session.no).toBe(i);
        s.closeSession(r.session.sessionId, { iterations: 1, execMs: 1000, stopCause: "max_reached" });
      }
    }
    const fourth = s.reserveSession(w.workId, { jobId: "j1", claimId: "c4" });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe("sessions");
    expect(s.getWork(w.workId)!.state).toBe("blocked");
    expect(s.getWork(w.workId)!.blockedReason).toContain("sessions");
    expect(s.getWork(w.workId)!.sessionsUsed).toBe(3);
  });

  test("a reservation carries the iteration limit and a deadline bounded by the remaining work time", () => {
    const s = open();
    const w = create(s).work;
    const r1 = s.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    expect(r1.ok && r1.maxIterations).toBe(5);
    expect(r1.ok && r1.deadlineMs).toBe(10 * 60_000);
    if (r1.ok) s.closeSession(r1.session.sessionId, { iterations: 5, execMs: 25 * 60_000, stopCause: "max_reached" });
    const r2 = s.reserveSession(w.workId, { jobId: "j", claimId: "c2" });
    expect(r2.ok && r2.deadlineMs).toBe(5 * 60_000);
  });

  test("when the work wall time is spent no session starts and the work is blocked", () => {
    const s = open();
    const w = create(s).work;
    const r1 = s.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    if (r1.ok) s.closeSession(r1.session.sessionId, { iterations: 5, execMs: 30 * 60_000, stopCause: "deadline" });
    const r2 = s.reserveSession(w.workId, { jobId: "j", claimId: "c2" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("time");
    expect(s.getWork(w.workId)!.state).toBe("blocked");
  });

  test("closing a session adds its iterations and time to the work counters", () => {
    const s = open();
    const w = create(s).work;
    const r = s.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    if (r.ok) s.closeSession(r.session.sessionId, { iterations: 4, execMs: 90_000, stopCause: "done" });
    const after = s.getWork(w.workId)!;
    expect(after.iterationsUsed).toBe(4);
    expect(after.execMsUsed).toBe(90_000);
  });

  test("closing a session twice counts it once", () => {
    const s = open();
    const w = create(s).work;
    const r = s.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    if (r.ok) {
      s.closeSession(r.session.sessionId, { iterations: 4, execMs: 90_000, stopCause: "done" });
      s.closeSession(r.session.sessionId, { iterations: 4, execMs: 90_000, stopCause: "done" });
    }
    expect(s.getWork(w.workId)!.iterationsUsed).toBe(4);
    expect(s.getWork(w.workId)!.execMsUsed).toBe(90_000);
  });

  test("a session reserved for an unknown or terminal work is refused", () => {
    const s = open();
    expect(s.reserveSession("nope", { jobId: "j", claimId: "c" })).toEqual({ ok: false, reason: "no-work" });
    const w = create(s).work;
    s.setState(w.workId, "accepted");
    const r = s.reserveSession(w.workId, { jobId: "j", claimId: "c" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("state");
  });
});

describe("durability across restart", () => {
  test("counters, state and events are unchanged after closing and reopening the file", () => {
    const path = tempDb();
    const a = open(path);
    const w = create(a).work;
    const r = a.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    if (r.ok) a.closeSession(r.session.sessionId, { iterations: 3, execMs: 60_000, stopCause: "max_reached" });
    a.setState(w.workId, "checkpointed");
    a.appendEvent(w.workId, "first", { n: 1 });
    a.appendEvent(w.workId, "second", { n: 2 });
    const before = a.getWork(w.workId)!;
    a.close();

    const b = open(path);
    const after = b.getWork(w.workId)!;
    expect(after.sessionsUsed).toBe(before.sessionsUsed);
    expect(after.iterationsUsed).toBe(before.iterationsUsed);
    expect(after.execMsUsed).toBe(before.execMsUsed);
    expect(after.state).toBe("checkpointed");
    const mine = (id: string, kinds: string[]) => b.listEvents(id).map((e) => e.kind).filter((k) => kinds.includes(k));
    expect(mine(w.workId, ["first", "second"])).toEqual(["first", "second"]);
    expect(b.listEvents(w.workId).map((e) => e.kind)[0]).toBe("created");
  });

  test("a session left open at restart is charged its full wall time and flagged unknown, never reset", () => {
    const path = tempDb();
    const a = open(path);
    const w = create(a).work;
    const r = a.reserveSession(w.workId, { jobId: "j", claimId: "c1" });
    expect(r.ok).toBe(true);
    a.close();

    const b = open(path);
    const recovered = b.recoverOpenSessions();
    expect(recovered.length).toBe(1);
    const after = b.getWork(w.workId)!;
    expect(after.sessionsUsed).toBe(1);
    expect(after.execMsUsed).toBe(10 * 60_000);
    expect(b.listSessions(w.workId)[0]!.endedUnknown).toBe(true);
    expect(b.recoverOpenSessions().length).toBe(0);
  });

  test("recovering after a reclaim does not give a fourth session", () => {
    const path = tempDb();
    const a = open(path);
    const w = create(a).work;
    for (let i = 0; i < 2; i++) {
      const r = a.reserveSession(w.workId, { jobId: "j", claimId: `c${i}` });
      if (r.ok) a.closeSession(r.session.sessionId, { iterations: 1, execMs: 1000, stopCause: "max_reached" });
    }
    a.reserveSession(w.workId, { jobId: "j", claimId: "c-open" }); // left open when the process dies
    a.close();
    const b = open(path);
    b.recoverOpenSessions();
    const r = b.reserveSession(w.workId, { jobId: "j", claimId: "c9" });
    expect(r.ok).toBe(false);
  });
});

describe("events", () => {
  test("a secret-looking field is redacted when the event is written", () => {
    const s = open();
    const w = create(s).work;
    s.appendEvent(w.workId, "claim", { claimId: "c1", token: "ghp_secret", nested: { authorization: "Bearer x", ok: 1 } });
    const e = s.listEvents(w.workId).find((x) => x.kind === "claim")!;
    expect(JSON.stringify(e.detail)).not.toContain("ghp_secret");
    expect(JSON.stringify(e.detail)).not.toContain("Bearer x");
    expect((e.detail as { claimId: string }).claimId).toBe("c1");
  });

  test("events keep insert order", () => {
    const s = open();
    const w = create(s).work;
    for (const k of ["a", "b", "c"]) s.appendEvent(w.workId, k, {});
    expect(s.listEvents(w.workId).map((e) => e.kind).filter((k) => ["a", "b", "c"].includes(k))).toEqual(["a", "b", "c"]);
  });
});

describe("database path", () => {
  test("ANIMA_WORK_DB wins", () => {
    expect(resolveWorkDbPath({ ANIMA_WORK_DB: "/x/y.db", NODE_ENV: "test" })).toBe("/x/y.db");
  });

  test("under NODE_ENV=test without an override the store is in memory, never the live file", () => {
    expect(resolveWorkDbPath({ NODE_ENV: "test", HOME: "/home/user" })).toBe(":memory:");
  });

  test("otherwise it is work.db under the ANIMA home", () => {
    expect(resolveWorkDbPath({ HOME: "/home/user" })).toBe("/home/user/.anima/work.db");
  });
});
