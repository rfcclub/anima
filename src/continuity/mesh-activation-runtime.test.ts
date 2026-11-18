import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MeshDelivery } from "colony-mesh";
import { ActivationBroker } from "./activation-broker";
import { ActivationBudget } from "./activation-budget";
import { ActivationExecutor } from "./activation-executor";
import { ActivationStore } from "./activation-store";
import { MeshActivationRuntime } from "./mesh-activation-runtime";

function delivery(role = "request"): MeshDelivery {
  return {
    delivery_id: 7, message_id: 42, recipient_id: "eli", delivery_kind: "direct", topic: null,
    available_at: "2026-07-14T00:00:00.000Z", claimed_at: null, claim_expires_at: null, claim_token: "claim",
    acked_at: null, failed_at: null, failure_reason: null, attempts: 0,
    message: { id: 42, client_msg_id: null, thread_id: null, pattern: "direct", role, from_id: "bruno", from_platform: "oc", to_platform: "anima", subject: "review", content: "please review", round: null, context_only: false, created_at: "1970-01-01T00:00:00.000Z" },
  } as MeshDelivery;
}

test("SC-060: a mesh request reaches the session executor once and only through its broker grant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-runtime-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  let sessions = 0;
  const lifecycle: string[] = [];
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new ActivationExecutor(store),
    });
    const runtime = new MeshActivationRuntime({
      store, broker, now: () => 10_000,
      onAttentionProjected: (item) => lifecycle.push(`opened:${item.state}:${item.version}`),
      onAttentionStateChanged: (item) => lifecycle.push(`changed:${item.state}:${item.version}`),
      executeSession: async ({ grant, candidate }) => {
        sessions += 1;
        expect(grant.executor).toBe("mesh-session");
        expect(candidate.sourceRef).toBe("mesh:42");
        return "session-effect";
      },
    });

    expect(runtime.ingest("eli", delivery())).toEqual({ disposition: "ack", route: "candidate" });
    expect(runtime.ingest("eli", delivery())).toEqual({ disposition: "ack", route: "candidate" });
    expect(sessions).toBe(0);
    expect(store.openAttention("eli")).toHaveLength(1);
    expect(await runtime.dispatch("eli", "mesh:42")).toEqual({ ok: true, effectRef: "session-effect", replayed: false });
    expect(await runtime.dispatch("eli", "mesh:42")).toEqual({ ok: false, reason: "empty" });
    expect(sessions).toBe(1);
    expect(store.openAttention("eli")).toEqual([]);
    expect(lifecycle).toEqual(["opened:open:1", "opened:open:2", "changed:claimed:3", "changed:acted:4", "changed:resolved:5"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a due recovered attention is dispatched by the broker queue without a second ingress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-due-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  let sessions = 0;
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new ActivationExecutor(store),
    });
    const runtime = new MeshActivationRuntime({
      store, broker, now: () => 10_000,
      executeSession: async () => { sessions += 1; return "due-effect"; },
    });
    runtime.ingest("eli", delivery());
    expect(await runtime.dispatchNext()).toEqual({ ok: true, effectRef: "due-effect", replayed: false });
    expect(sessions).toBe(1);
    expect(store.openAttention("eli")).toEqual([]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC-059: a mesh knock enters the wake-only runtime route and never runs a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-knock-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  let sessions = 0;
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store) });
    const runtime = new MeshActivationRuntime({ store, broker, now: () => 10_000, executeSession: async () => { sessions += 1; return "impossible"; } });
    expect(runtime.ingest("eli", delivery("knock"))).toEqual({ disposition: "ack", route: "wake" });
    expect(await runtime.dispatch("eli", "mesh:42")).toEqual({ ok: false, reason: "empty" });
    expect(sessions).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC-057/058: terminal mesh roles remain provider-free in the broker runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-terminal-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  let sessions = 0;
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store) });
    const runtime = new MeshActivationRuntime({ store, broker, now: () => 10_000, executeSession: async () => { sessions += 1; return "impossible"; } });
    for (const role of ["result", "response"]) {
      expect(runtime.ingest("eli", delivery(role))).toEqual({ disposition: "ack", route: "informational" });
      expect(await runtime.dispatch("eli", "mesh:42")).toEqual({ ok: false, reason: "empty" });
    }
    expect(sessions).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC-063: restart recovery resolves a durable mesh effect without a second session call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-recovery-"));
  const path = join(dir, "memory.db");
  const store = new ActivationStore(path);
  let now = 10_000;
  let sessions = 0;
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store) });
    const runtime = new MeshActivationRuntime({ store, broker, now: () => now, executeSession: async () => { sessions += 1; return "should-not-run"; } });
    runtime.ingest("eli", delivery());
    const candidate = broker.claimNext(now);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) throw new Error("missing lease");
    const item = store.openAttention("eli")[0];
    expect(store.transitionAttention(item.id, item.version, "claimed", now).ok).toBe(true);
    store.recordActivationEffect(candidate.leaseId, candidate.candidate.key!, "durable-session-effect");
    now += 6 * 60_000;
    expect(runtime.recover()).toBe(0);
    expect(store.openAttention("eli")).toEqual([]);
    expect(await runtime.dispatch("eli", "mesh:42")).toEqual({ ok: false, reason: "empty" });
    expect(sessions).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC-062: an empty recovery sweep runs no mesh session or fabricated activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-empty-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  let sessions = 0;
  try {
    const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store) });
    const runtime = new MeshActivationRuntime({ store, broker, now: () => 10_000, executeSession: async () => { sessions += 1; return "impossible"; } });
    expect(runtime.recover()).toBe(0);
    expect(await runtime.dispatch("eli", "mesh:none")).toEqual({ ok: false, reason: "empty" });
    expect(sessions).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── castle-reflection-activation-wiring SC-073d/e: end-to-end reproduction
// of the original bug, on the *shared*
// broker a reflection candidate can now be enqueued into. A stray
// out-of-band candidate left in the queue eventually reaches
// MeshActivationRuntime.dispatchNext() via the central timer, which cannot
// execute a non-mesh candidate (attentionFor() finds nothing for a
// reflection-signal sourceKind — it was never projected as attention).

test("SC-073d: without discard(), a stray reflection candidate reaches dispatchNext() and rejects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-stray-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new ActivationExecutor(store),
    });
    const runtime = new MeshActivationRuntime({
      store, broker, now: () => 10_000,
      executeSession: async () => "session-effect",
    });

    // Simulates TickRunner enqueuing its own executor="reflection" candidate
    // (ReflectionSignalCandidateSource's shape) WITHOUT calling discard() on
    // a failed claim — the pre-fix behavior.
    broker.enqueue({
      key: "bruno:reflection-signal:bruno:tick:10000", agentId: "bruno", sourceKind: "reflection-signal",
      sourceRef: "bruno", occurrenceKey: "tick:10000", sourceVersion: 10_000, dueAt: 10_000,
      urgency: 5, costClass: "T1", executor: "reflection", summary: "test", reasonRef: "bruno",
    });

    // The central timer fires and hands the earliest-due candidate to the
    // mesh runtime — the only dispatcher the shared broker's armTimer knows
    // how to call.
    await expect(runtime.dispatchNext()).rejects.toThrow("attention disappeared before broker execution");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC-073e: with discard() called on a failed claim, the same central dispatch finds nothing to do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-activation-discarded-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const broker = new ActivationBroker({
      armTimer: () => {}, store,
      budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
      executor: new ActivationExecutor(store),
    });
    const runtime = new MeshActivationRuntime({
      store, broker, now: () => 10_000,
      executeSession: async () => "session-effect",
    });

    const key = "bruno:reflection-signal:bruno:tick:10000";
    broker.enqueue({
      key, agentId: "bruno", sourceKind: "reflection-signal",
      sourceRef: "bruno", occurrenceKey: "tick:10000", sourceVersion: 10_000, dueAt: 10_000,
      urgency: 5, costClass: "T1", executor: "reflection", summary: "test", reasonRef: "bruno",
    });

    // The fix: TickRunner discards its own candidate immediately (SC-073c).
    broker.discard(key);

    const result = await runtime.dispatchNext();
    expect(result).toEqual({ ok: false, reason: "empty" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── mesh-session-result-and-retry ──────────────────────

const LONG_BODY = `Please review the PR. ${"Read the diff, then post with anima_github. ".repeat(20)}END-OF-BODY`;

function reviewDelivery(messageId = 77): MeshDelivery {
  const base = delivery();
  return {
    ...base, message_id: messageId,
    message: { ...base.message, id: messageId, thread_id: "thread-9", subject: "review PR example/repo#1", content: LONG_BODY, from_id: "bruno", from_platform: "claude" },
  } as MeshDelivery;
}

function harness(path: string, opts: { now: () => number; executeSession: any; onFailed?: any; maxAttempts?: number; retryDelayMs?: number; attemptTimeoutMs?: number }) {
  const store = new ActivationStore(path);
  const broker = new ActivationBroker({
    armTimer: () => {}, store,
    budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
    executor: new ActivationExecutor(store),
  });
  const runtime = new MeshActivationRuntime({ store, broker, ...opts } as any);
  return { store, broker, runtime };
}

function activeLeases(path: string): number {
  const { Database } = require("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT COUNT(*) AS n FROM activation_leases WHERE status = 'active'").get() as { n: number }).n; } finally { db.close(); }
}

test("MR-1 the session receives the whole request, read back from the store after reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-result-source-"));
  const path = join(dir, "memory.db");
  const first = harness(path, { now: () => 10_000, executeSession: async () => "unused" });
  first.runtime.ingest("finn", reviewDelivery());
  first.store.close();
  const seen: any[] = [];
  const second = harness(path, { now: () => 10_000, executeSession: async ({ source }: any) => { seen.push(source); return "effect"; } });
  try {
    second.runtime.recover();
    expect(await second.runtime.dispatch("finn", "mesh:77")).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sourceRef: "mesh:77", fromId: "bruno", fromPlatform: "claude", threadId: "thread-9",
      subject: "review PR example/repo#1", content: LONG_BODY,
    });
    expect(seen[0].content.length).toBeGreaterThan(400);
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MR-4 a throwing turn releases its lease, re-opens and re-queues without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-result-retry-"));
  const path = join(dir, "memory.db");
  let now = 10_000;
  let calls = 0;
  const failures: any[] = [];
  const { store, runtime } = harness(path, {
    now: () => now, maxAttempts: 3, retryDelayMs: 60_000,
    executeSession: async () => { calls++; if (calls === 1) throw new Error("The socket connection was closed unexpectedly"); return "second-attempt"; },
    onFailed: (input: any) => failures.push({ final: input.final, attempts: input.attempts }),
  });
  try {
    runtime.ingest("finn", reviewDelivery());
    expect(await runtime.dispatch("finn", "mesh:77")).toEqual({ ok: false, reason: "retrying" });
    expect(activeLeases(path)).toBe(0);
    expect(store.openAttention("finn").map((item) => item.state)).toEqual(["open"]);
    expect(failures).toEqual([{ final: false, attempts: 1 }]);
    expect(await runtime.dispatchNext()).toEqual({ ok: false, reason: "empty" });
    now += 60_000;
    expect(await runtime.dispatchNext()).toMatchObject({ ok: true, effectRef: "second-attempt" });
    expect(calls).toBe(2);
    expect(store.openAttention("finn")).toEqual([]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MR-5 the last failed attempt is reported once and leaves the item blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-result-final-"));
  const path = join(dir, "memory.db");
  let now = 10_000;
  const failures: any[] = [];
  const { store, runtime } = harness(path, {
    now: () => now, maxAttempts: 2, retryDelayMs: 1_000,
    executeSession: async () => { throw new Error("Upstream request failed: Endpoint is unavailable."); },
    onFailed: (input: any) => failures.push({ final: input.final, attempts: input.attempts, timedOut: input.timedOut, ref: input.source?.sourceRef }),
  });
  try {
    runtime.ingest("finn", reviewDelivery());
    expect(await runtime.dispatch("finn", "mesh:77")).toEqual({ ok: false, reason: "retrying" });
    now += 1_000;
    expect(await runtime.dispatchNext()).toEqual({ ok: false, reason: "failed" });
    expect(failures).toEqual([
      { final: false, attempts: 1, timedOut: false, ref: "mesh:77" },
      { final: true, attempts: 2, timedOut: false, ref: "mesh:77" },
    ]);
    expect(store.openAttention("finn")).toEqual([]);
    expect(store.getAttentionByOccurrence("finn", "mesh", "mesh:77", "mesh:77")?.state).toBe("blocked");
    expect(activeLeases(path)).toBe(0);
    now += 10_000;
    expect(await runtime.dispatchNext()).toEqual({ ok: false, reason: "empty" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MR-6 a hanging turn times out once, releases its lease and is not retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-result-timeout-"));
  const path = join(dir, "memory.db");
  let calls = 0;
  let signal: AbortSignal | undefined;
  const failures: any[] = [];
  const { store, runtime } = harness(path, {
    now: () => 10_000, maxAttempts: 3, retryDelayMs: 0, attemptTimeoutMs: 20,
    executeSession: (input: any) => { calls++; signal = input.signal; return new Promise<string>(() => {}); },
    onFailed: (input: any) => failures.push({ final: input.final, timedOut: input.timedOut }),
  });
  try {
    runtime.ingest("finn", reviewDelivery());
    expect(await runtime.dispatch("finn", "mesh:77")).toEqual({ ok: false, reason: "failed" });
    expect(signal?.aborted).toBe(true);
    expect(failures).toEqual([{ final: true, timedOut: true }]);
    expect(store.getAttentionByOccurrence("finn", "mesh", "mesh:77", "mesh:77")?.state).toBe("blocked");
    expect(activeLeases(path)).toBe(0);
    expect(await runtime.dispatchNext()).toEqual({ ok: false, reason: "empty" });
    expect(calls).toBe(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MR-7 a request claimed by a previous process within its lease TTL runs once after boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-result-boot-"));
  const path = join(dir, "memory.db");
  const old = harness(path, { now: () => 10_000, executeSession: async () => "never" });
  old.runtime.ingest("finn", reviewDelivery());
  const claimed = old.broker.claimNext(10_000);
  expect(claimed.ok).toBe(true);
  const item = old.store.openAttention("finn")[0];
  expect(old.store.transitionAttention(item.id, item.version, "claimed", 10_000).ok).toBe(true);
  old.store.close();

  let calls = 0;
  const booted = harness(path, { now: () => 20_000, executeSession: async () => { calls++; return "after-boot"; } });
  try {
    expect(booted.runtime.recover()).toBe(1);
    expect(await booted.runtime.dispatchNext()).toMatchObject({ ok: true, effectRef: "after-boot" });
    expect(calls).toBe(1);
    expect(booted.store.openAttention("finn")).toEqual([]);
    expect(activeLeases(path)).toBe(0);
  } finally {
    booted.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Requests that arrive through the agent's A2A inbox.
function a2aHarness(dir: string, executeSession: ConstructorParameters<typeof MeshActivationRuntime>[0]["executeSession"]) {
  const store = new ActivationStore(join(dir, "memory.db"));
  const broker = new ActivationBroker({
    armTimer: () => {}, store,
    budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }),
    executor: new ActivationExecutor(store),
  });
  const runtime = new MeshActivationRuntime({ store, broker, now: () => 10_000, executeSession });
  return { store, broker, runtime };
}

test("AJ-5 an inbox request is kept whole before ingress returns, and a repeated frame gives one candidate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-a2a-ingest-"));
  const body = `review example/repo#1 ${"x".repeat(1_200)}`;
  const sources: unknown[] = [];
  const { store, runtime } = a2aHarness(dir, async ({ source }) => { sources.push(source); return "done"; });
  try {
    const item = { conversationId: "conv-1", sender: "agent-claude-00000001@host-1", body };
    expect(runtime.ingestA2A("finn", item)).toEqual({ disposition: "ack", route: "candidate" });
    expect(store.getMeshSource("finn", "a2a:conv-1")).toMatchObject({
      sourceRef: "a2a:conv-1", fromId: "agent-claude-00000001@host-1", fromPlatform: "a2a", threadId: "conv-1", content: body, role: "request",
    });
    expect(runtime.ingestA2A("finn", item)).toEqual({ disposition: "ack", route: "candidate" });
    expect(store.openAttention("finn")).toHaveLength(1);
    expect(await runtime.dispatch("finn", "a2a:conv-1")).toMatchObject({ ok: true });
    expect(await runtime.dispatch("finn", "a2a:conv-1")).toEqual({ ok: false, reason: "empty" });
    expect(sources).toHaveLength(1);
    expect((sources[0] as { content: string }).content).toBe(body);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AJ-5 a store that cannot write makes ingress report retry, so the inbox cursor does not move", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-a2a-retry-"));
  const { store, runtime } = a2aHarness(dir, async () => "unused");
  try {
    store.close();
    expect(runtime.ingestA2A("finn", { conversationId: "conv-2", sender: "x@m", body: "hi" })).toEqual({ disposition: "retry", route: "candidate" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AJ-6 a request stored before a crash runs once after the next boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-a2a-crash-"));
  const before = a2aHarness(dir, async () => { throw new Error("must not run before the crash"); });
  before.runtime.ingestA2A("finn", { conversationId: "conv-3", sender: "x@m", body: "run me" });
  before.store.close();
  let runs = 0;
  const after = a2aHarness(dir, async () => { runs += 1; return "ran"; });
  try {
    expect(after.runtime.recover()).toBe(1);
    expect(await after.runtime.dispatchNext()).toMatchObject({ ok: true });
    expect(await after.runtime.dispatchNext()).toMatchObject({ ok: false });
    expect(runs).toBe(1);
  } finally {
    after.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AJ-10 a forwarded reply is stored once as a reply, opens no attention and starts no session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-a2a-reply-"));
  let runs = 0;
  const { store, runtime } = a2aHarness(dir, async () => { runs += 1; return "must not run"; });
  try {
    const reply = { conversationId: "r-1", sender: "mesh-service@local", body: "[mesh reply from e@m re conversation_id=c0]\npong", replyTo: "c0" };
    expect(runtime.ingestA2A("finn", reply)).toEqual({ disposition: "ack", route: "informational" });
    expect(runtime.ingestA2A("finn", reply)).toEqual({ disposition: "ack", route: "informational" });
    expect(store.getMeshSource("finn", "a2a:r-1")).toMatchObject({ role: "reply", content: reply.body, threadId: "r-1" });
    expect(store.openAttention("finn")).toEqual([]);
    expect(runtime.recover()).toBe(0);
    expect(await runtime.dispatchNext()).toMatchObject({ ok: false });
    expect(runs).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
