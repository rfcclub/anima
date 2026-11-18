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

const NOW = Date.parse("2026-07-15T00:00:00.000Z");

function request(): MeshDelivery {
  return { delivery_id: 1, message_id: 42, recipient_id: "eli", delivery_kind: "direct", topic: null,
    available_at: "2026-07-15T00:00:00.000Z", claimed_at: null, claim_expires_at: null, claim_token: "claim",
    acked_at: null, failed_at: null, failure_reason: null, attempts: 0,
    message: { id: 42, client_msg_id: null, thread_id: null, pattern: "direct", role: "request", from_id: "bruno", from_platform: "oc", to_platform: "anima", subject: "review", content: "please review", round: null, context_only: false, created_at: "2026-07-15T00:00:00.000Z" },
  } as MeshDelivery;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "activation-broker-e2e-"));
  const store = new ActivationStore(join(dir, "shared", "memory.db"));
  const broker = new ActivationBroker({ armTimer: () => {}, store, budget: new ActivationBudget(store, { colonyDailyLimit: 20, agentDailyLimit: 10 }), executor: new ActivationExecutor(store) });
  return { dir, store, broker };
}

test("SC-061: request is durably ingested, then resolves once with one charge", async () => {
  const { dir, store, broker } = fixture();
  let executions = 0;
  try {
    const runtime = new MeshActivationRuntime({ store, broker, now: () => NOW, executeSession: async () => { executions++; return "effect-1"; } });
    expect(runtime.ingest("eli", request())).toEqual({ disposition: "ack", route: "candidate" });
    expect(await runtime.dispatchNext()).toEqual({ ok: true, effectRef: "effect-1", replayed: false });
    expect(await runtime.dispatchNext()).toEqual({ ok: false, reason: "empty" });
    expect(executions).toBe(1);
    expect(store.getBudget("2026-07-15", "agent", "eli")).toEqual({ spentUnits: 1, reservedUnits: 0 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-062: an empty day has no executor call or fabricated activity", async () => {
  const { dir, store, broker } = fixture();
  let executions = 0;
  try {
    const runtime = new MeshActivationRuntime({ store, broker, now: () => NOW, executeSession: async () => { executions++; return "impossible"; } });
    expect(runtime.recover()).toBe(0);
    expect(await runtime.dispatchNext()).toEqual({ ok: false, reason: "empty" });
    expect(executions).toBe(0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SC-063: restart recovery preserves an effect and never repeats the session", async () => {
  const { dir, store, broker } = fixture();
  let executions = 0;
  try {
    const runtime = new MeshActivationRuntime({ store, broker, now: () => NOW, executeSession: async () => { executions++; return "should-not-run"; } });
    runtime.ingest("eli", request());
    const claim = broker.claimNext(NOW);
    if (!claim.ok) throw new Error("expected lease");
    const attention = store.openAttention("eli")[0];
    store.transitionAttention(attention.id, attention.version, "claimed", NOW);
    store.recordActivationEffect(claim.leaseId, claim.candidate.key!, "effect-durable");
    expect(runtime.recover()).toBe(0);
    expect(executions).toBe(0);
    expect(store.openAttention("eli")).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
