import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivationExecutor, type ExecutionInput } from "./activation-executor";
import type { BudgetGrant } from "./activation-budget";
import { ActivationStore } from "./activation-store";

const grant: BudgetGrant = { leaseId: "lease-1", agentId: "eli", executor: "reflection", costClass: "T1", units: 1, expiresAt: 1_000 };

test("SC-043 rejects a causal action without matching reason or grant", async () => {
  let calls = 0;
  const executor = new ActivationExecutor();
  expect(await executor.execute({ leaseId: "lease-1", candidateKey: "candidate-1", reasonRef: "", agentId: "eli", executor: "reflection", grant, now: 1, run: async () => `effect-${++calls}` })).toEqual({ ok: false, reason: "missing-reason" });
  expect(calls).toBe(0);
  expect(await executor.execute({ leaseId: "lease-1", candidateKey: "candidate-1", reasonRef: "mesh:1", agentId: "eli", executor: "reflection", grant: { ...grant, executor: "other" }, now: 1, run: async () => `effect-${++calls}` })).toEqual({ ok: false, reason: "invalid-grant" });
  expect(calls).toBe(0);
});

test("SC-049 returns a recorded effect on replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-executor-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  const executor = new ActivationExecutor(store);
  let calls = 0;
  const input = { leaseId: "lease-1", candidateKey: "candidate-1", reasonRef: "mesh:1", agentId: "eli", executor: "reflection", grant, now: 1, run: async () => `effect-${++calls}` };
  expect(await executor.execute(input)).toEqual({ ok: true, effectRef: "effect-1", replayed: false });
  const restarted = new ActivationExecutor(store);
  expect(await restarted.execute(input)).toEqual({ ok: true, effectRef: "effect-1", replayed: true });
  expect(calls).toBe(1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("auxiliary execution with an empty effect is rejected before persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activation-executor-empty-effect-"));
  const store = new ActivationStore(join(dir, "memory.db"));
  try {
    const executor = new ActivationExecutor(store);
    const result = await executor.execute({
      leaseId: "lease-empty",
      candidateKey: "encounter-line:empty",
      reasonRef: "encounter:e-1",
      agentId: "eli",
      executor: "encounter",
      grant: { ...grant, leaseId: "lease-empty", executor: "encounter" },
      now: 1,
      run: async () => "",
    });

    expect(result).toEqual({ ok: false, reason: "precondition-unavailable" });
    expect(store.getActivationEffect("lease-empty", "encounter-line:empty")).toBeNull();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC-044 and SC-045 satisfy a required place once before substantive work", async () => {
  const executor = new ActivationExecutor();
  const calls: string[] = [];
  const input: ExecutionInput = {
    leaseId: "lease-1", candidateKey: "work:1", reasonRef: "work:1", agentId: "eli", executor: "heavy-work",
    grant: { ...grant, executor: "heavy-work", costClass: "T2", units: 10 }, now: 1,
    requiredPlace: "workshop",
    currentPlace: () => "chamber_eli",
    moveTo: async ({ to, reasonRef }: { to: string; reasonRef: string }) => { calls.push(`move:${to}:${reasonRef}`); },
    run: async () => { calls.push("work"); return "work-effect"; },
  };
  expect(await executor.execute(input)).toEqual({ ok: true, effectRef: "work-effect", replayed: false });
  expect(calls).toEqual(["move:workshop:work:1", "work"]);

  calls.splice(0);
  expect(await new ActivationExecutor().execute({ ...input, candidateKey: "work:2", currentPlace: () => "workshop" })).toEqual({ ok: true, effectRef: "work-effect", replayed: false });
  expect(calls).toEqual(["work"]);
});

test("SC-046 and SC-047 coordinate participants once or rest explicitly without decorative fallback", async () => {
  const executor = new ActivationExecutor();
  const calls: string[] = [];
  const input: ExecutionInput = {
    leaseId: "lease-1", candidateKey: "meeting:1", reasonRef: "work:1", agentId: "eli", executor: "reflection", grant, now: 1,
    requiredParticipants: ["bruno"],
    participantsAvailable: () => new Set<string>(),
    coordinateParticipants: async (participants) => { calls.push(`coordinate:${participants.join(",")}`); return true; },
    run: async () => { calls.push("run"); return "effect"; },
  };
  expect(await executor.execute(input)).toEqual({ ok: true, effectRef: "effect", replayed: false });
  expect(calls).toEqual(["coordinate:bruno", "run"]);

  calls.splice(0);
  expect(await new ActivationExecutor().execute({ ...input, candidateKey: "meeting:2", coordinateParticipants: undefined })).toEqual({ ok: false, reason: "precondition-unavailable" });
  expect(calls).toEqual([]);
});
