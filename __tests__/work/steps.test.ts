/**
 * castle-work-loop: in-progress step markers in the work store.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";

const stores: WorkStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const s = WorkStore.open(":memory:", { rootBase: "/w" });
  stores.push(s);
  const w = s.createWork({ repo: "a/x", issue: 1, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
  return { s, w };
}

describe("work steps", () => {
  test("a begun step is open until it ends", () => {
    const { s, w } = setup();
    const id = s.beginStep({ workId: w.workId, sessionId: "s1", seq: 1, kind: "provider" });
    expect(s.openSteps(w.workId).map((x) => x.id)).toEqual([id]);
    s.endStep(id, "completed");
    expect(s.openSteps(w.workId)).toEqual([]);
  });

  test("a step that ended unknown stays open until it is resolved", () => {
    const { s, w } = setup();
    const id = s.beginStep({ workId: w.workId, sessionId: "s1", seq: 2, kind: "provider" });
    s.endStep(id, "unknown");
    expect(s.openSteps(w.workId).length).toBe(1);
    s.resolveSteps([id]);
    expect(s.openSteps(w.workId)).toEqual([]);
  });

  test("open steps come back oldest first and only for their own work", () => {
    const { s, w } = setup();
    const other = s.createWork({ repo: "a/y", issue: 2, approvedDigest: "d2d2d2d2d2d2", config: loadWorkConfig({}) }).work;
    const a = s.beginStep({ workId: w.workId, sessionId: "s1", seq: 1, kind: "provider" });
    const b = s.beginStep({ workId: w.workId, sessionId: "s1", seq: 2, kind: "compaction" });
    s.beginStep({ workId: other.workId, sessionId: "s9", seq: 1, kind: "provider" });
    expect(s.openSteps(w.workId).map((x) => x.id)).toEqual([a, b]);
    expect(s.openSteps(other.workId).length).toBe(1);
  });

  test("ending a step twice or an unknown step is harmless", () => {
    const { s, w } = setup();
    const id = s.beginStep({ workId: w.workId, sessionId: "s1", seq: 1, kind: "provider" });
    s.endStep(id, "completed");
    s.endStep(id, "unknown"); // a late second end must not reopen a finished step
    expect(s.openSteps(w.workId)).toEqual([]);
    expect(() => s.endStep("nope", "completed")).not.toThrow();
  });

  test("steps survive closing and reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-steps-"));
    dirs.push(dir);
    const path = join(dir, "steps.db");
    const a = WorkStore.open(path, { rootBase: "/w" });
    const w = a.createWork({ repo: "a/x", issue: 1, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
    const id = a.beginStep({ workId: w.workId, sessionId: "s1", seq: 1, kind: "provider" });
    a.close();
    const b = WorkStore.open(path, { rootBase: "/w" });
    stores.push(b);
    expect(b.openSteps(w.workId).map((x) => x.id)).toEqual([id]);
  });
});
