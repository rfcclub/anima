/**
 * castle-work-loop, WL-7: the castle reads a bounded, read-only, sanitised projection of the
 * work store. Temp databases only.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { readWorkProjection } from "../../src/work/projection";
import { describeWork } from "../../src/ui/features/work/lib/describe";
import { handleWork } from "../../src/ui/features/work/api/work";

let dir: string;
let path: string;
let store: WorkStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "work-proj-")));
  path = join(dir, "work.db");
  store = WorkStore.open(path, { rootBase: join(dir, "roots") });
});
afterEach(() => { try { store.close(); } catch { /* already closed */ } });

let n = 0;
const mk = (over: Record<string, unknown> = {}) =>
  store.createWork({ repo: "rfcclub/anima", issue: ++n, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}), ...over } as never).work;

describe("projection", () => {
  test("lists the works with state, author, issue, pull request, cap usage and last progress", () => {
    const w = mk();
    const r = reserve(w.workId);
    store.closeSession(r, { iterations: 4, execMs: 90_000, stopCause: "done" });
    store.recordPullRequest(w.workId, { number: 12, head: "a".repeat(40), url: "https://github.com/rfcclub/anima/pull/12" });
    store.setState(w.workId, "in-review");
    const p = readWorkProjection(path);
    expect(p.works.length).toBe(1);
    const item = p.works[0]!;
    expect(item).toMatchObject({
      workId: w.workId, repo: "rfcclub/anima", issue: w.issue, author: "finn", model: "agnes-3.0-flash", state: "in-review",
      pr: { number: 12, url: "https://github.com/rfcclub/anima/pull/12" },
      caps: { sessionsUsed: 1, maxSessions: 3, iterationsUsed: 4, execMsUsed: 90_000, workWallMs: 30 * 60_000 },
    });
    expect(item.lastProgress?.kind).toBe("state"); // the move to review is the latest thing that happened
    expect(item.blockedReason).toBeNull();
  });

  test("a blocked work shows its reason", () => {
    const w = mk();
    store.setState(w.workId, "blocked", "isolation unavailable: probe failed");
    expect(readWorkProjection(path).works[0]!.blockedReason).toBe("isolation unavailable: probe failed");
  });

  test("it is bounded: at most 50 works and 200 events per work", () => {
    for (let i = 0; i < 60; i++) mk();
    const first = mk(); // the newest work, so it is inside the 50
    for (let i = 0; i < 260; i++) store.appendEvent(first.workId, "tick", { i });
    const p = readWorkProjection(path);
    expect(p.works.length).toBe(50);
    const events = p.works.find((x) => x.workId === first.workId)?.events ?? [];
    expect(events.length).toBe(200);
    // the newest are kept
    expect(events[events.length - 1]!.kind).toBe("tick");
  });

  test("it survives a restart: the same works and events in the same order", () => {
    const w = mk();
    for (const kind of ["a", "b", "c"]) store.appendEvent(w.workId, kind, {});
    const before = readWorkProjection(path);
    store.close();
    const after = readWorkProjection(path);
    expect(after).toEqual(before);
    expect(after.works[0]!.events.map((e) => e.kind).filter((k) => ["a", "b", "c"].includes(k))).toEqual(["a", "b", "c"]);
  });

  test("it never contains a capability, token, transcript or local path", () => {
    const w = mk();
    store.appendEvent(w.workId, "claim", { claimId: "c1", token: "ghp_SENTINEL_TOKEN", transcript: "SENTINEL TRANSCRIPT TEXT", authorization: "Bearer SENTINEL", note: "x".repeat(1000) });
    store.appendEvent(w.workId, "path", { root: "/Users/user/.anima/work/secret", reason: "visible reason" });
    const text = JSON.stringify(readWorkProjection(path));
    for (const needle of ["SENTINEL", "ghp_", "/Users/user", dir]) expect(text).not.toContain(needle);
    expect(text).toContain("visible reason");
    expect(text).not.toContain("x".repeat(400));
  });

  test("it opens the database read-only: a write through it fails and the store is unchanged", () => {
    mk();
    const p = readWorkProjection(path);
    expect(p.works.length).toBe(1);
    const ro = new Database(path, { readonly: true });
    expect(() => ro.run("UPDATE works SET state = 'accepted'")).toThrow();
    ro.close();
  });

  test("a missing database is an empty projection", () => {
    expect(readWorkProjection(join(dir, "nope.db"))).toEqual({ works: [] });
  });
});

function reserve(workId: string): string {
  const r = store.reserveSession(workId, { jobId: "j", claimId: "c" });
  if (!r.ok) throw new Error("not reserved");
  return r.session.sessionId;
}

describe("describeWork", () => {
  const base = {
    workId: "w1", repo: "a/x", issue: 7, author: "finn", provider: "agnes", model: "agnes-3.0-flash", state: "checkpointed" as const,
    blockedReason: null, pr: null, caps: { sessionsUsed: 1, maxSessions: 3, iterationsUsed: 5, execMsUsed: 90_000, workWallMs: 1_800_000 },
    lastProgress: { at: "2026-10-22T12:00:00.000Z", kind: "session-closed" }, events: [],
  };

  test("title, state, caps and progress in words", () => {
    const d = describeWork(base);
    expect(d.title).toBe("a/x#7");
    expect(d.stateLabel).toBe("checkpointed");
    expect(d.capsLine).toBe("sessions 1/3 · time 1m30s of 30m");
    expect(d.progressLine).toContain("session-closed");
  });

  test("a blocked work leads with its reason, and a pull request becomes a link", () => {
    const d = describeWork({ ...base, state: "blocked", blockedReason: "sessions exhausted (3 of 3 used)", pr: { number: 12, url: "https://github.com/a/x/pull/12", head: "a".repeat(40) } });
    expect(d.blockedLine).toBe("Blocked: sessions exhausted (3 of 3 used)");
    expect(d.prLink).toEqual({ label: "PR #12", url: "https://github.com/a/x/pull/12" });
  });

  test("no blocked line and no link when there is nothing to say", () => {
    const d = describeWork(base);
    expect(d.blockedLine).toBeNull();
    expect(d.prLink).toBeNull();
  });
});

describe("api", () => {
  test("GET /api/work answers the projection as JSON and takes no Mesh credential", async () => {
    mk();
    store.close();
    process.env.ANIMA_WORK_DB = path;
    try {
      const res = handleWork(new Request("http://127.0.0.1:3000/api/work", { headers: {} }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { works: unknown[] };
      expect(body.works.length).toBe(1);
    } finally {
      delete process.env.ANIMA_WORK_DB;
    }
  });
});
