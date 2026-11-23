import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkConfig } from "../../src/work/config";
import { captureLimitHandoff, markLowHandoffAbort, readLimitHandoff, shouldContinueAfterLimit } from "../../src/work/production";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore, type SessionRecord, type StopRecord, type WorkRecord } from "../../src/work/store";
import { buildWorkOrder, HANDOFF_MAX_CHARS } from "../../src/work/work-order";

let root: string;
let store: WorkStore;
let work: WorkRecord;
let session: SessionRecord;
let note: string;
const text = "Done: parser. Next: run tests. Blocked: none.";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "work-handoff-")));
  store = WorkStore.open(join(root, "work.db"), { rootBase: root });
  work = store.createWork({ repo: "example/repo", issue: 1, approvedDigest: "a".repeat(12), config: loadWorkConfig({}) }).work;
  const reserved = store.reserveSession(work.workId, { jobId: "job-1", claimId: "claim-1" }, "low");
  if (!reserved.ok) throw new Error(reserved.reason);
  session = reserved.session;
  mkdirSync(join(work.root, "tmp"), { recursive: true });
  note = join(work.root, "tmp", `AGENT_HANDOFF_${session.sessionId}.md`);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function stop(trusted = true, adapter = "low"): StopRecord {
  store.closeSession(session.sessionId, { stopCause: "max_reached", iterations: 3, execMs: 42 });
  const stop = createStopRecorder({ store, read: (_tree, argv) => argv[0] === "rev-parse" ? "a".repeat(40) : "" })({
    work, session, adapter, stopCause: "max_reached", cessation: "proven", leaseHeld: trusted, generationCurrent: true,
  });
  captureLimitHandoff(store, work, stop);
  return stop;
}

const bareOrder = () => ({
  work, issue: { title: "Title", body: "Body" }, kind: "start-work" as const, tree: join(work.root, "tree"),
  budget: { maxIterations: 3, deadlineMs: 1000 },
  adapter: { adapter: "low", tools: [], network: [], skills: false, writable: [] },
});
const resumedOrder = () => buildWorkOrder({ ...bareOrder(), handoff: readLimitHandoff(store, work) });
const fallback = () => ({ work, kind: "start-work" as const, stopCause: "max_reached" as const, limitTerminal: false });

test("wh-1 covered handoff accompanies the next order and yields to continuation", () => {
  writeFileSync(note, text);
  stop();
  store.close();
  store = WorkStore.open(join(root, "work.db"), { rootBase: root });
  expect(shouldContinueAfterLimit(store, fallback())).toBe(true);
  const reserved = store.reserveSession(work.workId, { jobId: "job-1", claimId: "claim-2" }, "low");
  expect(reserved.ok).toBe(true);
  expect(resumedOrder().handoff).toEqual({ text, trust: "untrusted" });
});

test("wh-2 oversized note is omitted", () => {
  writeFileSync(note, "a".repeat(HANDOFF_MAX_CHARS + 1));
  stop();
  expect(resumedOrder().handoff).toBeUndefined();
});

test("wh-2 untrusted, changed or unsafe notes are omitted", () => {
  writeFileSync(note, text);
  const checkpoint = stop(false);
  expect(resumedOrder().handoff).toBeUndefined();
  expect(checkpoint.trusted).toBe(false);
});

test("wh-2 a same-length edit invalidates checkpoint coverage", () => {
  writeFileSync(note, text);
  stop();
  writeFileSync(note, text.replace("parser", "writer"));
  expect(resumedOrder().handoff).toBeUndefined();
});

test("wh-2 symlinks are omitted", () => {
  const other = join(root, "external-note");
  writeFileSync(other, text);
  symlinkSync(other, note);
  stop();
  expect(resumedOrder().handoff).toBeUndefined();
});

test("wh-3 absent note preserves the ordinary order and fallback", () => {
  stop();
  expect(resumedOrder()).toEqual(buildWorkOrder(bareOrder()));
  expect(shouldContinueAfterLimit(store, fallback())).toBe(false);
});

test("wh-4 exhausted allowance still takes the terminal fallback", () => {
  writeFileSync(note, text);
  stop();
  expect(shouldContinueAfterLimit(store, { ...fallback(), limitTerminal: true })).toBe(false);
});

test("wh-1 a host deadline abort with a saved note carries abort provenance", async () => {
  writeFileSync(note, text);
  const controller = new AbortController();
  controller.abort();
  const input = { work, session, signal: controller.signal } as Parameters<import("../../src/work/adapter").WorkerAdapter["run"]>[0];
  const stopped = { stopCause: "interrupted", iterations: 1, cessation: "proven" } as const;
  expect(markLowHandoffAbort(input, stopped).interruptionSource).toBe("abort");
  rmSync(note);
  expect(markLowHandoffAbort(input, stopped)).toEqual(stopped);
});


test.each(["deadline", "max_reached"] as const)("loop handoff survives a trusted %s stop", (cause) => {
  writeFileSync(note, text);
  store.closeSession(session.sessionId, { stopCause: cause, iterations: 3, execMs: 42 });
  const recorded = createStopRecorder({ store, read: (_tree, argv) => argv[0] === "rev-parse" ? "a".repeat(40) : "" })({
    work, session, adapter: "loop", stopCause: cause, cessation: "proven", leaseHeld: true, generationCurrent: true,
  });
  captureLimitHandoff(store, work, recorded);
  expect(readLimitHandoff(store, work)).toEqual({ text, covered: true });
  expect(resumedOrder().handoff).toEqual({ text, trust: "untrusted" });
  writeFileSync(note, text.replace("parser", "writer"));
  expect(readLimitHandoff(store, work)).toBeUndefined();
});

test("loop handoff refuses an unsafe or untrusted note", () => {
  const other = join(root, "external-note");
  writeFileSync(other, text);
  symlinkSync(other, note);
  store.closeSession(session.sessionId, { stopCause: "deadline", iterations: 3, execMs: 42 });
  const recorded = createStopRecorder({ store, read: (_tree, argv) => argv[0] === "rev-parse" ? "a".repeat(40) : "" })({
    work, session, adapter: "loop", stopCause: "deadline", cessation: "proven", leaseHeld: true, generationCurrent: true,
  });
  captureLimitHandoff(store, work, recorded);
  expect(readLimitHandoff(store, work)).toBeUndefined();
  rmSync(note);
  writeFileSync(note, text);
  captureLimitHandoff(store, work, { ...recorded, trusted: false });
  expect(readLimitHandoff(store, work)).toBeUndefined();
});


test("loop handoff rejects an oversized note", () => {
  writeFileSync(note, "a".repeat(HANDOFF_MAX_CHARS + 1));
  stop(true, "loop");
  expect(readLimitHandoff(store, work)).toBeUndefined();
});

test("loop handoff appearing only after its trusted stop is not covered", () => {
  stop(true, "loop");
  writeFileSync(note, text);
  expect(readLimitHandoff(store, work)).toBeUndefined();
});
