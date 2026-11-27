import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";

// A missing implementation is reported by an assertion so the initial RED is executable evidence.
let implementation: Record<string, any> = {};
try { implementation = await import("../../src/work/progress-guard"); } catch { /* initial RED */ }

const stores: WorkStore[] = [];
const dirs: string[] = [];
const call = (path = "src/a.ts") => ({ id: "call", name: "read", arguments: JSON.stringify({ path }) });
const hash = (letter: string) => letter.repeat(64);
const response = (result = "same") => ({ call: call(), result, iteration: 1, completed: true });

function setup() {
  const store = WorkStore.open(":memory:"); stores.push(store);
  const work = store.createWork({ repo: "example/project", issue: 1, approvedDigest: "123456789abc", config: loadWorkConfig({}) }).work;
  const reserved = store.reserveSession(work.workId, { jobId: "job-1", claimId: "lease-1" });
  if (!reserved.ok) throw new Error("reservation failed");
  return { store, work, session: reserved.session, signal: new AbortController().signal };
}
function guard(input: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
  expect(typeof implementation.createProgressGuard).toBe("function");
  return implementation.createProgressGuard({
    store: input.store, workId: input.work.workId, sessionId: input.session.sessionId,
    claimId: input.session.claimId, generation: input.session.generation, signal: input.signal,
    state: async () => hash("a"), ...extra,
  });
}
function details(input: ReturnType<typeof setup>) {
  return input.store.listEvents(input.work.workId).filter((event) => event.kind === "progress-guard").map((event) => event.detail as Record<string, unknown>);
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("review regressions", () => {
  for (const reset of ["changed", "unknown"] as const) {
    test(`review-reset: ${reset} requires a new warning before stop`, async () => {
      const input = setup(); let state: string | null = hash("a");
      const g = guard(input, { enforce: true, state: async () => state });
      for (let i = 1; i <= 3; i++) await g.observe({ ...response(), iteration: i });
      if (reset === "unknown") state = null;
      await g.observe({ ...response("changed"), iteration: 4 });
      state = hash("a");
      let sample: any;
      for (let i = 5; i <= (reset === "unknown" ? 7 : 6); i++) {
        sample = await g.observe({ ...response("changed"), iteration: i });
      }
      expect(sample).toMatchObject({ classification: "unchanged", wouldAction: "warn", action: "warn" });
    });
  }

  test("review-budget: exhausted observation budget reports unknown instead of taking more snapshots", async () => {
    const input = setup(); let time = 0; let snapshots = 0;
    const g = guard(input, {
      observationBudgetMs: 50, now: () => time,
      state: async () => { snapshots++; time += 30; return hash("a"); },
    });
    const samples = [];
    for (let i = 1; i <= 6; i++) samples.push(await g.observe({ ...response(), iteration: i }));
    expect(snapshots).toBeLessThanOrEqual(2);
    expect(samples.at(-1)).toMatchObject({ classification: "unknown", action: "none" });
  });

  test("review-budget: a slow observation cannot run past the remaining session budget", async () => {
    const input = setup();
    const g = guard(input, {
      observationBudgetMs: 20,
      state: async () => { await Bun.sleep(250); return hash("a"); },
    });
    const start = performance.now();
    const sample = await g.observe(response());
    expect(performance.now() - start).toBeLessThan(200);
    expect(sample).toMatchObject({ classification: "unknown", action: "none" });
  });

  test("review-budget: expiry aborts the snapshot and never intervenes", async () => {
    const input = setup(); let cancelled = false;
    const g = guard(input, { enforce: true, observationBudgetMs: 20,
      state: async (signal: AbortSignal) => new Promise<string | null>((resolve) => {
        signal.addEventListener("abort", () => { cancelled = true; resolve(null); }, { once: true });
      }),
    });
    expect(await g.observe(response())).toMatchObject({ classification: "unknown", action: "none" });
    expect(cancelled).toBe(true);
  });
});

describe("progress-aware repeat guard", () => {
  test("classifies unchanged repeats without storing raw arguments or results", async () => {
    const input = setup(); const g = guard(input);
    expect((await g.observe(response("secret-result"))).classification).toBe("first");
    expect(await g.observe(response("secret-result"))).toMatchObject({ classification: "unchanged", streak: 1 });
    const text = JSON.stringify(details(input));
    expect(text).not.toContain("secret-result");
    expect(text).not.toContain("src/a.ts");
    expect(details(input).map((event) => event.classification)).toEqual(["first", "unchanged"]);
  });

  test("changed result and changed observable state reset the unchanged streak", async () => {
    const input = setup(); let state = hash("a"); const g = guard(input, { state: async () => state });
    await g.observe(response()); await g.observe(response());
    expect(await g.observe(response("new result"))).toMatchObject({ classification: "changed", streak: 0 });
    await g.observe(response("new result")); state = hash("b");
    expect(await g.observe(response("new result"))).toMatchObject({ classification: "changed", streak: 0 });
  });

  test("compares the same work across distinct sessions", async () => {
    const input = setup(); await guard(input).observe(response());
    input.store.closeSession(input.session.sessionId, { iterations: 1, execMs: 1, stopCause: "max_reached" });
    const next = input.store.reserveSession(input.work.workId, { jobId: "job-2", claimId: "lease-2" });
    if (!next.ok) throw new Error("replacement reservation failed");
    const later = { ...input, session: next.session };
    expect(await guard(later).observe(response())).toMatchObject({ classification: "unchanged", streak: 1 });
  });

  test("unknown observations never assert an intervention", async () => {
    const input = setup(); const g = guard(input, { state: async () => null, enforce: true });
    for (let i = 0; i < 5; i++) {
      expect(await g.observe({ ...response(), iteration: i + 1 })).toMatchObject({ classification: "unknown", wouldAction: "none", action: "none" });
    }
  });

  test("regression: unknown invalidates only its advisory cache entry across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "progress-regression-")); dirs.push(dir);
    const path = join(dir, "work.db");
    let store = WorkStore.open(path); stores.push(store);
    const firstWork = store.createWork({ repo: "example/project", issue: 1, approvedDigest: "123456789abc", config: loadWorkConfig({}) }).work;
    const otherWork = store.createWork({ repo: "example/project", issue: 2, approvedDigest: "123456789abc", config: loadWorkConfig({}) }).work;
    const first = store.reserveSession(firstWork.workId, { jobId: "job-1", claimId: "lease-1" });
    const other = store.reserveSession(otherWork.workId, { jobId: "job-2", claimId: "lease-2" });
    if (!first.ok || !other.ok) throw new Error("reservation failed");
    const signal = new AbortController().signal;
    const observe = (workId: string, session: typeof first.session, callHash: string, known: boolean) =>
      store.observeProgress({
        workId, sessionId: session.sessionId, claimId: session.claimId, generation: session.generation, signal, callHash,
        resultHash: known ? hash("d") : null, stateHash: known ? hash("e") : null,
      });
    observe(firstWork.workId, first.session, hash("a"), true);
    observe(firstWork.workId, first.session, hash("b"), true);
    observe(otherWork.workId, other.session, hash("a"), true);
    expect(observe(firstWork.workId, first.session, hash("a"), false).classification).toBe("unknown");
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT result_hash, state_hash FROM work_progress_observations WHERE work_id = ? AND call_hash = ?")
      .get(firstWork.workId, hash("a"))).toEqual({ result_hash: null, state_hash: null });
    expect((db.query("SELECT COUNT(*) AS count FROM work_progress_observations").get() as { count: number }).count).toBe(3);
    db.close();
    stores.pop(); store.close();
    store = WorkStore.open(path); stores.push(store);
    expect(observe(firstWork.workId, first.session, hash("a"), true).classification).toBe("first");
    expect(observe(firstWork.workId, first.session, hash("b"), true)).toMatchObject({ classification: "unchanged", streak: 1 });
    expect(observe(otherWork.workId, other.session, hash("a"), true)).toMatchObject({ classification: "unchanged", streak: 1 });
  });

  test("designated polling records a prospective false positive without enforcement", async () => {
    const input = setup(); const g = guard(input, { pollingReadPaths: ["ci/status.txt"], enforce: true });
    let sample: any;
    for (let i = 0; i < 4; i++) sample = await g.observe({ ...response(), call: call("ci/status.txt"), iteration: i + 1 });
    expect(sample).toMatchObject({ classification: "polling", falsePositive: true, action: "none" });
    expect(["warn", "stop"]).toContain(sample.wouldAction);
  });

  test("regression: an exact CI polling command remains allowed with enforcement", async () => {
    const input = setup();
    const g = guard(input, { pollingCommands: ["gh pr checks 123"], enforce: true });
    let sample: any;
    for (let i = 0; i < 4; i++) {
      sample = await g.observe({
        ...response(), call: { id: "call", name: "bash", arguments: JSON.stringify({ command: "gh pr checks 123" }) },
        iteration: i + 1,
      });
    }
    expect(sample).toMatchObject({ classification: "polling", falsePositive: true, action: "none" });
    expect(["warn", "stop"]).toContain(sample.wouldAction);
    for (let i = 0; i < 4; i++) {
      sample = await g.observe({
        ...response(), call: { id: "call", name: "bash", arguments: JSON.stringify({ command: "gh pr checks 124" }) },
        iteration: i + 1,
      });
    }
    expect(sample).toMatchObject({ classification: "unchanged", action: "stop" });
  });

  test("stale and duplicate owners are distinct and cannot change current history", async () => {
    const input = setup(); const current = guard(input); await current.observe(response());
    const stale = guard(input, { generation: input.session.generation - 1 });
    const duplicate = guard(input, { claimId: "wrong-lease" });
    expect((await stale.observe(response())).classification).toBe("stale");
    expect((await duplicate.observe(response())).classification).toBe("duplicate_worker");
    expect(await current.observe(response())).toMatchObject({ classification: "unchanged", streak: 1 });
  });

  test("observe-only records would-be interventions without warning or stop", async () => {
    for (const setting of [undefined, false]) {
      const input = setup(); const g = guard(input, { enforce: setting }); const samples = [];
      for (let i = 0; i < 5; i++) samples.push(await g.observe({ ...response(), iteration: i + 1 }));
      expect(samples.some((sample) => sample.wouldAction === "warn")).toBe(true);
      expect(samples.some((sample) => sample.wouldAction === "stop")).toBe(true);
      expect(samples.every((sample) => sample.action === "none")).toBe(true);
    }
  });

  test("enforcement warns before a stop on a later turn", async () => {
    const input = setup(); const g = guard(input, { enforce: true }); const samples = [];
    for (let i = 0; i < 4; i++) samples.push(await g.observe({ ...response(), iteration: i + 1 }));
    expect(samples[2]).toMatchObject({ wouldAction: "warn", action: "warn" });
    expect(samples[3]).toMatchObject({ wouldAction: "stop", action: "stop" });
  });

  test("repeats in a single turn cannot stop before the warning is delivered", async () => {
    const input = setup(); const g = guard(input, { enforce: true }); const samples = [];
    for (let i = 0; i < 5; i++) samples.push(await g.observe({ ...response(), iteration: 1 }));
    expect(samples.some((sample) => sample.action === "warn")).toBe(true);
    expect(samples.every((sample) => sample.action !== "stop")).toBe(true);
    expect((await g.observe({ ...response(), iteration: 2 })).action).toBe("stop");
  });
});
