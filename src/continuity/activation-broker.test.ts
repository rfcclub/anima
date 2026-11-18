import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivationBroker } from "./activation-broker";
import { buildCandidate, type ActivationCandidate } from "./activation-candidate";
import { ActivationStore } from "./activation-store";
import { ActivationBudget } from "./activation-budget";
import { ActivationExecutor } from "./activation-executor";
import type { ExecutionResult } from "./activation-executor";
import { AttentionCandidateSource } from "./candidate-sources";

class RejectingExecutor extends ActivationExecutor {
  override async execute(): Promise<ExecutionResult> {
    return { ok: false, reason: "precondition-unavailable" };
  }
}

function candidate(overrides: Partial<ActivationCandidate> = {}): ActivationCandidate {
  return buildCandidate({ agentId: "eli", sourceKind: "attention", sourceRef: "mesh:1", occurrenceKey: "mesh:1", sourceVersion: 1, dueAt: 100, urgency: 5, costClass: "T1", executor: "reflection", summary: "request", reasonRef: "mesh:1", ...overrides });
}

test("SC-028 maintains one earliest-due wake and coalesces a candidate", () => {
  const armed: Array<number | null> = [];
  const broker = new ActivationBroker({ armTimer: (at) => armed.push(at) });
  broker.enqueue(candidate({ dueAt: 200 }));
  broker.enqueue(candidate({ dueAt: 100 }));
  broker.enqueue(candidate({ dueAt: 50, sourceVersion: 2 }));
  expect(broker.nextDueAt()).toBe(50);
  expect(broker.pendingCount()).toBe(1);
  expect(armed).toEqual([200, 100, 50]);
});

test("SC-028 rebuilds the due queue from durable attention after restart", () => {
  const armed: Array<number | null> = [];
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-rebuild-"));
  const path = join(dir, "memory.db");
  const initial = new ActivationStore(path);
  try {
    initial.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:due", occurrenceKey: "mesh:due", kind: "request", urgency: 5, summary: "due", openedAt: 1, dueAt: 100, lastEventId: "evt-due" });
    initial.projectAttention({ agentId: "eli", sourceKind: "mesh", sourceRef: "mesh:future", occurrenceKey: "mesh:future", kind: "request", urgency: 5, summary: "future", openedAt: 1, dueAt: 200, lastEventId: "evt-future" });
  } finally { initial.close(); }
  const reopened = new ActivationStore(path);
  try {
    const broker = new ActivationBroker({ armTimer: (at) => armed.push(at) });
    expect(broker.rebuildFromSources([new AttentionCandidateSource(reopened)])).toBe(2);
    expect(broker.pendingCount()).toBe(2);
    expect(broker.nextDueAt()).toBe(100);
    expect(armed).toEqual([100]);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-024 burst updates retain one candidate with newest source version", () => {
  const broker = new ActivationBroker({ armTimer: () => {} });
  broker.enqueue(candidate({ sourceVersion: 1, dueAt: 200 }));
  broker.enqueue(candidate({ sourceVersion: 2, dueAt: 100 }));
  expect(broker.pendingCount()).toBe(1);
  expect(broker.nextDueAt()).toBe(100);
});

test("SC-055 deduplicates identical suppression audit events inside one window", async () => {
  const emitted: string[] = [];
  const broker = new ActivationBroker({
    armTimer: () => {},
    onSuppressed: ({ candidate, reason }) => { emitted.push(`${candidate.key}:${reason}`); },
  });
  const item = candidate();
  expect(await broker.recordSuppression(item, "budget", 100, 1_000)).toBe(true);
  expect(await broker.recordSuppression(item, "budget", 500, 1_000)).toBe(false);
  expect(await broker.recordSuppression(item, "budget", 1_100, 1_000)).toBe(true);
  expect(emitted).toEqual([`${item.key}:budget`, `${item.key}:budget`]);
});

test("broker status exposes bounded queue and suppression counters without candidate text", async () => {
  const broker = new ActivationBroker({ armTimer: () => {} });
  const item = candidate({ dueAt: 50 });
  broker.enqueue(item);
  await broker.recordSuppression(item, "budget", 100, 1_000);
  expect(broker.status(100)).toEqual({
    nextDueAt: 50,
    pendingCount: 1,
    dueCount: 1,
    suppressedByReason: { budget: 1 },
  });
});

test("broker persists its bounded status snapshot for the read-only report", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-status-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, mode: "enforce" });
    broker.enqueue(candidate({ dueAt: 50 }));
    expect(store.getBrokerStatus()).toEqual({
      mode: "enforce", nextDueAt: 50, pendingCount: 1, dueCount: 1, suppressedByReason: {},
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-030 event bursts re-evaluate only the affected agent", () => {
  const calls: Array<string | undefined> = [];
  const source = {
    candidates: (agentId?: string) => {
      calls.push(agentId);
      return agentId === "eli" ? [candidate()] : [];
    },
  };
  const broker = new ActivationBroker({ armTimer: () => {}, sources: [source] });
  broker.wakeAgent("eli");
  broker.wakeAgent("eli");
  expect(calls).toEqual([]);
  expect(broker.flushWakes()).toBe(1);
  expect(calls).toEqual(["eli"]);
  expect(broker.pendingCount()).toBe(1);
});

test("SC-031 quiet window defers ordinary work before lease or provider execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-quiet-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  let calls = 0;
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new ActivationExecutor(store),
      quietUntil: () => 200,
    });
    broker.enqueue(candidate({ dueAt: 100, urgency: 5 }));
    expect(await broker.dispatchNext(100, async () => `effect-${++calls}`)).toEqual({ ok: false, reason: "empty" });
    expect(calls).toBe(0);
    expect(broker.nextDueAt()).toBe(200);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-034 serves each same-priority agent before a noisy agent's second candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-fairness-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }) });
    broker.enqueue(candidate({ agentId: "eli", sourceRef: "mesh:c1", occurrenceKey: "mesh:c1" }));
    broker.enqueue(candidate({ agentId: "eli", sourceRef: "mesh:c2", occurrenceKey: "mesh:c2" }));
    broker.enqueue(candidate({ agentId: "bruno", sourceRef: "mesh:a1", occurrenceKey: "mesh:a1" }));
    broker.enqueue(candidate({ agentId: "sam", sourceRef: "mesh:v1", occurrenceKey: "mesh:v1" }));
    const served = [broker.claimNext(100), broker.claimNext(100), broker.claimNext(100), broker.claimNext(100)]
      .map((result) => result.ok ? result.candidate.agentId : result.reason);
    expect(served).toEqual(["bruno", "eli", "sam", "eli"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-035 rebuilds fairness service state after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-fairness-restart-"));
  const path = join(dir, "memory.db");
  const firstStore = new ActivationStore(path);
  try {
    const first = new ActivationBroker({ armTimer: () => {}, store: firstStore, budget: new ActivationBudget(firstStore, { colonyDailyLimit: 20, agentDailyLimit: 10 }) });
    first.enqueue(candidate({ agentId: "bruno", sourceRef: "mesh:a1", occurrenceKey: "mesh:a1" }));
    first.enqueue(candidate({ agentId: "eli", sourceRef: "mesh:c1", occurrenceKey: "mesh:c1" }));
    expect(first.claimNext(100).ok).toBe(true);
  } finally { firstStore.close(); }
  const restartedStore = new ActivationStore(path);
  try {
    const restarted = new ActivationBroker({ armTimer: () => {}, store: restartedStore, budget: new ActivationBudget(restartedStore, { colonyDailyLimit: 20, agentDailyLimit: 10 }) });
    restarted.enqueue(candidate({ agentId: "bruno", sourceRef: "mesh:a2", occurrenceKey: "mesh:a2" }));
    restarted.enqueue(candidate({ agentId: "eli", sourceRef: "mesh:c2", occurrenceKey: "mesh:c2" }));
    const selected = restarted.claimNext(100);
    expect(selected.ok && selected.candidate.agentId).toBe("eli");
  } finally { restartedStore.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-032 acquires one lease and grant before dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const budget = new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 });
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget });
    broker.enqueue(candidate());
    const first = broker.claimNext(100);
    expect(first.ok).toBe(true);
    expect(broker.claimNext(100)).toEqual({ ok: false, reason: "empty" });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("dispatch runs only through the claimed causal grant and settles its durable lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store) });
    broker.enqueue(candidate());
    expect(await broker.dispatchNext(100, async () => "effect-1")).toEqual({ ok: true, effectRef: "effect-1", replayed: false });
    expect(store.operationalStatus(100).activeLeases).toBe(0);
    expect(store.getBudget("1970-01-01", "agent", "eli")).toEqual({ spentUnits: 1, reservedUnits: 0 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed dispatch releases the claimed lease and budget reservation when no executor is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-failed-dispatch-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: () => {},
      store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
    });
    broker.enqueue(candidate());

    expect(await broker.dispatchNext(100, async () => "never")).toEqual({ ok: false, reason: "not-configured" });
    expect(store.operationalStatus(100).activeLeases).toBe(0);
    expect(store.getBudget("1970-01-01", "agent", "eli")).toEqual({ spentUnits: 0, reservedUnits: 0 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed pre-effect execution releases the claimed lease and budget reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-rejected-dispatch-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: () => {},
      store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new RejectingExecutor(),
    });
    broker.enqueue(candidate());

    expect(await broker.dispatchNext(100, async () => "never")).toEqual({ ok: false, reason: "precondition-unavailable" });
    expect(store.operationalStatus(100).activeLeases).toBe(0);
    expect(store.getBudget("1970-01-01", "agent", "eli")).toEqual({ spentUnits: 0, reservedUnits: 0 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty auxiliary effect releases the claimed lease and budget reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-empty-effect-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: () => {},
      store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new ActivationExecutor(store),
    });
    broker.enqueue(candidate({ executor: "encounter", sourceKind: "social-encounter", sourceRef: "encounter:e-1" }));

    expect(await broker.dispatchNext(100, async () => "")).toEqual({ ok: false, reason: "precondition-unavailable" });
    expect(store.operationalStatus(100).activeLeases).toBe(0);
    expect(store.getBudget("1970-01-01", "agent", "eli")).toEqual({ spentUnits: 0, reservedUnits: 0 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker emits lease and completion audit hooks from the actual execution boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-audit-hooks-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  const audit: string[] = [];
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store),
      onLeased: (claim) => { audit.push(`leased:${claim.leaseId}:${claim.grant.units}`); },
      onCompleted: (claim, effectRef) => { audit.push(`completed:${claim.leaseId}:${effectRef}`); },
    });
    broker.enqueue(candidate());
    expect(await broker.dispatchNext(100, async () => "effect-1")).toEqual({ ok: true, effectRef: "effect-1", replayed: false });
    expect(audit).toEqual([expect.stringMatching(/^leased:.+:1$/), expect.stringMatching(/^completed:.+:effect-1$/)]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("broker emits a release audit hook when a post-lease budget reservation fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-release-audit-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  const released: string[] = [];
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 0 }),
      onReleased: ({ candidate, leaseId, reason }) => { released.push(`${candidate.key}:${leaseId}:${reason}`); },
    });
    broker.enqueue(candidate());
    expect(broker.claimNext(100)).toEqual({ ok: false, reason: "agent-budget" });
    expect(released).toHaveLength(1);
    expect(released[0]).toContain(":agent-budget");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── castle-reflection-activation-wiring SC-073: a failed out-of-band claim
// (TickRunner's own enqueue+claimCandidate, not the central dispatch loop)
// must not leave a stray candidate in the shared queue for the central
// timer to later hand to MeshActivationRuntime.dispatchNext(), which cannot
// execute a non-mesh candidate (attentionFor() finds nothing, throws).

test("SC-073a: documents the leak — a failed claim leaves the candidate queued (intentional for mesh's own retry)", () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-leak-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 0 }),
    });
    broker.enqueue(candidate());
    expect(broker.claimNext(100)).toEqual({ ok: false, reason: "agent-budget" });
    expect(broker.pendingCount()).toBe(1); // still queued — this is the gap discard() closes for out-of-band callers
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-073b: discard() removes a candidate from the queue and re-arms", () => {
  const armed: Array<number | null> = [];
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-discard-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: (at) => armed.push(at), store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 0 }),
    });
    const c = candidate({ key: "bruno:reflection-signal:bruno:tick:1" });
    broker.enqueue(c);
    expect(broker.claimNext(100)).toEqual({ ok: false, reason: "agent-budget" });
    expect(broker.pendingCount()).toBe(1);

    broker.discard(c.key!);

    expect(broker.pendingCount()).toBe(0);
    expect(broker.nextDueAt()).toBeNull();
    expect(armed[armed.length - 1]).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-073c: discard() on an unknown key is a safe no-op", () => {
  const broker = new ActivationBroker({ armTimer: () => {} });
  expect(() => broker.discard("no-such-key")).not.toThrow();
  expect(broker.pendingCount()).toBe(0);
});
