/**
 * castle-work-loop, WL-11: work roots with unmerged or uncommitted work are kept until an
 * operator removes them; a clean accepted work becomes a cleanup candidate only after seven days.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { cleanupCandidates } from "../../src/work/retention";

const DAY = 86_400_000;
let store: WorkStore;
let clock: number;

beforeEach(() => {
  clock = Date.parse("2026-10-22T12:00:00Z");
  store = WorkStore.open(":memory:", { rootBase: "/w", now: () => clock });
});
afterEach(() => store.close());

let n = 0;
function accepted(): string {
  const w = store.createWork({ repo: "a/x", issue: ++n, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
  store.setState(w.workId, "accepted");
  store.appendEvent(w.workId, "accepted", { number: 12 });
  return w.workId;
}

describe("cleanupCandidates", () => {
  const clean = () => false;
  const dirty = () => true;

  test("a clean accepted work 6 days old is not a candidate; at 7 days it is", () => {
    const id = accepted();
    clock += 6 * DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: clean })).toEqual([]);
    clock += DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: clean }).map((c) => c.workId)).toEqual([id]);
  });

  test("a dirty or unmerged accepted work is never a candidate, however old", () => {
    accepted();
    clock += 400 * DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: dirty })).toEqual([]);
  });

  test("a blocked work is never a candidate, clean or not", () => {
    const w = store.createWork({ repo: "a/x", issue: 99, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
    store.setState(w.workId, "blocked", "isolation unavailable");
    clock += 400 * DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: clean })).toEqual([]);
  });

  test("works that are still running, in review or revising are never candidates", () => {
    for (const state of ["queued", "running", "checkpointed", "in-review", "revising"] as const) {
      const w = store.createWork({ repo: "a/x", issue: 200 + state.length + n++, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
      store.setState(w.workId, state);
    }
    clock += 400 * DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: clean })).toEqual([]);
  });

  test("a candidate reports its root, and listing it removes nothing: events and the work record remain", () => {
    const id = accepted();
    clock += 8 * DAY;
    const list = cleanupCandidates(store, { now: clock, isDirty: clean });
    expect(list[0]!.root).toContain(id);
    expect(store.getWork(id)).not.toBeNull();
    expect(store.listEvents(id).length).toBeGreaterThan(0);
  });

  test("an unreadable tree counts as dirty: when in doubt, keep it", () => {
    accepted();
    clock += 30 * DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: () => { throw new Error("cannot read tree"); } })).toEqual([]);
  });

  test("the age counts from the moment of acceptance, not from creation", () => {
    const w = store.createWork({ repo: "a/x", issue: 77, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
    clock += 30 * DAY; // long-running work
    store.setState(w.workId, "accepted");
    store.appendEvent(w.workId, "accepted", { number: 1 });
    clock += 2 * DAY;
    expect(cleanupCandidates(store, { now: clock, isDirty: clean })).toEqual([]);
  });
});
