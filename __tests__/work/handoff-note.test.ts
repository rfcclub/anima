import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectHandoffNote } from "../../src/work/handoff-note";
import { loadWorkConfig } from "../../src/work/config";
import { WorkStore } from "../../src/work/store";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "handoff-note-"))); mkdirSync(join(root, "tmp")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a whitespace-only note is not a usable handoff", () => {
  writeFileSync(join(root, "tmp", "AGENT_HANDOFF_s1.md"), "  \n\t \n");
  const note = inspectHandoffNote(root, "s1");
  expect("problem" in note && note.problem).toMatch(/empty/);
});

test("a note with content is usable", () => {
  writeFileSync(join(root, "tmp", "AGENT_HANDOFF_s1.md"), "Done: x");
  expect(inspectHandoffNote(root, "s1")).toEqual({ text: "Done: x" });
});

test("crash recovery charges the working deadline plus the handoff grace", () => {
  const store = WorkStore.open(":memory:", { rootBase: root });
  try {
    const work = store.createWork({ repo: "example/repo", issue: 1, approvedDigest: "a".repeat(12), config: loadWorkConfig({ caps: { sessionWallMs: 1000 } }) }).work;
    const reserved = store.reserveSession(work.workId, { jobId: "j", claimId: "c" }, "loop", 500);
    if (!reserved.ok) throw new Error(reserved.reason);
    store.recoverOpenSessions();
    expect(store.getWork(work.workId)!.execMsUsed).toBe(1500);
    expect(store.getSession(reserved.session.sessionId)!.execMs).toBe(1500);
  } finally { store.close(); }
});
