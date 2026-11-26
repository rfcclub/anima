import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadWorkConfig } from "../../src/work/config";
import { WorkStore, type WorkRecord } from "../../src/work/store";

type ContinuationInput = {
  workId: string; root: string; generation: number; sessionId: string;
  jobType: "start-work" | "revise"; state: "checkpointed" | "blocked";
};
type ContinuationStore = WorkStore & { continueAfterLimit(input: ContinuationInput): WorkRecord | null };
let store: WorkStore;

beforeEach(() => { store = WorkStore.open(":memory:"); });
afterEach(() => store.close());

function stopped(over: { trusted?: boolean; cessation?: "proven" | "unproven"; interrupted?: boolean; stopCause?: string; sessionCause?: string; stop?: boolean } = {}) {
  const work = store.createWork({ repo: "example/repo", issue: 7, approvedDigest: "a".repeat(12),
    config: loadWorkConfig({ caps: { maxSessions: 1, sessionWallMs: 1000, workWallMs: 1000 } }) }).work;
  const reserved = store.reserveSession(work.workId, { jobId: "job", claimId: "claim" });
  if (!reserved.ok) throw new Error(reserved.reason);
  const session = reserved.session;
  store.closeSession(session.sessionId, { iterations: 1, execMs: 1000, stopCause: over.sessionCause ?? "deadline" });
  if (over.stop !== false) store.recordStop({ sessionId: session.sessionId, workId: work.workId, adapter: "loop",
    stopCause: over.stopCause ?? "deadline", cessation: over.cessation ?? "proven", cessationCheck: null,
    head: "a".repeat(40), status: "", evidence: "unavailable", trusted: over.trusted ?? true, interrupted: over.interrupted ?? false });
  return { work: store.getWork(work.workId)!, session };
}

function continueWork(work: WorkRecord, sessionId: string, over: Partial<ContinuationInput> = {}) {
  const method = (store as ContinuationStore).continueAfterLimit;
  expect(typeof method).toBe("function");
  return method.call(store, { workId: work.workId, root: work.root, generation: work.generation, sessionId,
    jobType: "start-work", state: "checkpointed", ...over });
}

describe("Slice 1 continuation transaction", () => {
  test("Slice 1 grants the original allowance only once for a trusted stopped session", () => {
    const { work, session } = stopped();
    const continued = continueWork(work, session.sessionId)!;
    expect(continued).toMatchObject({ state: "checkpointed", caps: { maxSessions: 2, workWallMs: 2000, maxContinuations: 2 } });
    const events = store.listEvents(work.workId).filter((event) => event.kind === "limit-continuation");
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ n: 1, sessionId: session.sessionId, stopCause: "deadline", previousCaps: work.caps,
      baseCaps: work.caps, caps: continued.caps });
    expect(continueWork(continued, session.sessionId)).toBeNull();
    expect(store.listEvents(work.workId).filter((event) => event.kind === "limit-continuation")).toHaveLength(1);
  });

  test.each([
    { trusted: false }, { cessation: "unproven" as const }, { interrupted: true },
    { stop: false }, { stopCause: "done" }, { stopCause: "max_reached", sessionCause: "deadline" },
  ])("Slice 1 refuses a stop that is not trusted and proven: %j", (over) => {
    const { work, session } = stopped(over);
    const before = store.listEvents(work.workId);
    expect(continueWork(work, session.sessionId)).toBeNull();
    expect(store.getWork(work.workId)).toEqual(work);
    expect(store.listEvents(work.workId)).toEqual(before);
  });

  test("Slice 1 refuses stale generation, wrong state, wrong root and revise", () => {
    const { work, session } = stopped();
    const before = store.listEvents(work.workId);
    for (const over of [{ generation: work.generation + 1 }, { root: `${work.root}-other` },
      { state: "blocked" as const }, { jobType: "revise" as const }]) {
      expect(continueWork(work, session.sessionId, over)).toBeNull();
    }
    expect(store.getWork(work.workId)).toEqual(work);
    expect(store.listEvents(work.workId)).toEqual(before);
  });
});

describe("Slice 1 continuation refusal boundaries", () => {
  test("Slice 1 a block for an unrelated reason cannot be reversed by an earlier limit stop", () => {
    const { work, session } = stopped();
    store.setState(work.workId, "blocked", "approval changed");
    const blocked = store.getWork(work.workId)!;
    const events = store.listEvents(work.workId);
    expect(continueWork(blocked, session.sessionId, { state: "blocked" })).toBeNull();
    expect(store.getWork(work.workId)).toEqual(blocked);
    expect(store.listEvents(work.workId)).toEqual(events);
  });

  test("Slice 1 two grants use the first allowance and a third stop cannot receive another", () => {
    const { work, session } = stopped();
    let current = continueWork(work, session.sessionId)!;
    for (let n = 2; n <= 3; n++) {
      const next = store.reserveSession(work.workId, { jobId: "job", claimId: `claim-${n}` });
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(next.reason);
      store.closeSession(next.session.sessionId, { iterations: 1, execMs: 1000, stopCause: "max_reached" });
      store.recordStop({ sessionId: next.session.sessionId, workId: work.workId, adapter: "loop", stopCause: "max_reached",
        cessation: "proven", cessationCheck: null, head: "a".repeat(40), status: "", evidence: "unavailable", trusted: true, interrupted: false });
      current = store.getWork(work.workId)!;
      const result = continueWork(current, next.session.sessionId);
      if (n === 2) {
        expect(result).toMatchObject({ caps: { maxSessions: 3, workWallMs: 3000 } });
        current = result!;
      } else expect(result).toBeNull();
    }
    expect(store.listEvents(work.workId).filter((event) => event.kind === "limit-continuation")).toHaveLength(2);
  });
});
