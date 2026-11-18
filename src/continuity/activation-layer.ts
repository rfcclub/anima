import { join } from "node:path";
import { ActivationStore } from "./activation-store";
import { ActivationBudget } from "./activation-budget";
import { ActivationExecutor } from "./activation-executor";
import { ActivationBroker, type ClaimedActivation } from "./activation-broker";
import { JsonlGardenEventStore } from "../garden/event-store";
import { createGardenEvent } from "../garden/events";
import type { ActivationMode } from "./activation-config";
import type { ActivationCandidate } from "./activation-candidate";

export interface ActivationLayer {
  store: ActivationStore;
  budget: ActivationBudget;
  executor: ActivationExecutor;
  broker: ActivationBroker;
  /**
   * Completes the broker's due-timer -> dispatch wiring once a dispatch
   * runner exists. Circular dependency preserved from the original
   * castle-activation-broker code: MeshActivationRuntime needs the broker to
   * construct, but the broker's armTimer needs something to call when its
   * due-timer fires — so the caller constructs the broker first (via this
   * factory), builds its runtime from it, then calls setDispatchRunner.
   */
  setDispatchRunner(run: () => Promise<unknown>): void;
}

export interface BuildActivationLayerOptions {
  activationMode: ActivationMode;
  roomsDir: string;
  log(level: "info" | "error", msg: string, fields: Record<string, unknown>): void;
}

let sharedLayer: ActivationLayer | null = null;

/**
 * castle-reflection-activation-wiring: single shared ActivationStore +
 * ActivationBudget + ActivationExecutor + ActivationBroker, constructed once
 * and reused by both ReflectionScheduler (executor: "reflection" candidates)
 * and MeshActivationRuntime (executor: "mesh-session" candidates), so both
 * compete fairly for the same budget/lease pool through one due queue.
 * Previously each subsystem either built its own broker (mesh) or received a
 * permanently-empty static stub (reflection) — this closes that gap.
 *
 * off/shadow mode returns null — unchanged behavior, no broker exists.
 */
export function getOrCreateActivationLayer(options: BuildActivationLayerOptions): ActivationLayer | null {
  if (options.activationMode !== "gate" && options.activationMode !== "enforce") return null;
  if (sharedLayer) return sharedLayer;

  const { activationMode, roomsDir, log } = options;
  const store = new ActivationStore(join(roomsDir, "_shared", "memory.db"));
  const budget = new ActivationBudget(store, { colonyDailyLimit: 200, agentDailyLimit: 40 });
  const executor = new ActivationExecutor(store);
  const gardenEvents = new JsonlGardenEventStore(join(roomsDir, "_shared", "garden", "events.jsonl"));

  const runtimeLabel = (candidate: ActivationCandidate): "hub" | "mesh" => (candidate.executor === "reflection" ? "hub" : "mesh");

  const appendActivationEvent = (
    type: "ACTIVATION_LEASED" | "ACTIVATION_COMPLETED",
    claim: Extract<ClaimedActivation, { ok: true }>,
    effectRef?: string,
  ) => {
    void gardenEvents.append(createGardenEvent({
      id: `activation:${type}:${claim.leaseId}`,
      type,
      timestamp: new Date().toISOString(),
      agentId: claim.candidate.agentId,
      instanceId: claim.candidate.agentId,
      runtime: runtimeLabel(claim.candidate),
      project: "castle",
      payload: type === "ACTIVATION_LEASED" ? {
        candidateKey: claim.candidate.key!, sourceRef: claim.candidate.sourceRef, reasonRef: claim.candidate.reasonRef,
        occurrenceKey: claim.candidate.occurrenceKey, leaseId: claim.leaseId, costUnits: claim.grant.units,
      } : {
        candidateKey: claim.candidate.key!, sourceRef: claim.candidate.sourceRef, reasonRef: claim.candidate.reasonRef,
        occurrenceKey: claim.candidate.occurrenceKey, leaseId: claim.leaseId, settledUnits: claim.grant.units,
        producedEventIds: [effectRef ?? "unknown-effect"],
      },
    })).catch((error) => log("error", "activation audit event failed", {
      type, leaseId: claim.leaseId, error: error instanceof Error ? error.message : String(error),
    }));
  };

  const appendActivationRelease = (candidate: ActivationCandidate, leaseId: string) => {
    void gardenEvents.append(createGardenEvent({
      id: `activation:ACTIVATION_RELEASED:${leaseId}`,
      type: "ACTIVATION_RELEASED",
      timestamp: new Date().toISOString(),
      agentId: candidate.agentId,
      instanceId: candidate.agentId,
      runtime: runtimeLabel(candidate),
      project: "castle",
      payload: {
        candidateKey: candidate.key!, sourceRef: candidate.sourceRef, reasonRef: candidate.reasonRef,
        occurrenceKey: candidate.occurrenceKey, leaseId,
      },
    })).catch((error) => log("error", "activation release audit event failed", {
      leaseId, error: error instanceof Error ? error.message : String(error),
    }));
  };

  let dispatchRunner: (() => Promise<unknown>) | undefined;
  let dueTimer: ReturnType<typeof setTimeout> | undefined;
  const broker = new ActivationBroker({
    armTimer: (dueAt) => {
      if (dueTimer) clearTimeout(dueTimer);
      if (dueAt === null) return;
      dueTimer = setTimeout(() => {
        void dispatchRunner?.().catch((error) => {
          log("error", "broker due execution failed", {
            dueAt, error: error instanceof Error ? error.message : String(error),
          });
        });
      }, Math.max(0, dueAt - Date.now()));
    },
    mode: activationMode,
    store,
    budget,
    executor,
    onLeased: (claim) => appendActivationEvent("ACTIVATION_LEASED", claim),
    onCompleted: (claim, effectRef) => appendActivationEvent("ACTIVATION_COMPLETED", claim, effectRef),
    onReleased: ({ candidate, leaseId }) => appendActivationRelease(candidate, leaseId),
  });

  sharedLayer = {
    store, budget, executor, broker,
    setDispatchRunner: (run) => { dispatchRunner = run; },
  };
  return sharedLayer;
}

/** Test-only: clears the module-level singleton so each test starts fresh. */
export function __resetActivationLayer(): void {
  sharedLayer = null;
}
