/**
 * Glue between the work store and `runLoopMode` (anima #135). The supervisor, workspace and broker
 * pieces are composed by the work consumer; this file holds the part that talks to the loop.
 */

import type { LoopHost, LoopHostStep } from "../agents/loop";
import type { RunCheckpoint } from "../agents/run-checkpoint";
import type { WorkStore } from "./store";

export type Reconciler = (steps: LoopHostStep[], context: { stale: boolean; checkpoint: RunCheckpoint | null }) => Promise<string>;

/**
 * A `LoopHost` backed by the work store. Every provider and compaction call gets a durable marker; steps
 * left open by a dead session are handed to `reconcile` (which checks the workspace, branch and GitHub)
 * and are marked verified only after it returns, so a failed reconciliation leaves them open.
 */
export function createLoopHost(
  store: WorkStore,
  workId: string,
  reconcile: Reconciler,
  session: { workSessionId: string } | null = null,
): LoopHost {
  return {
    workId,
    beginStep: (info) => store.beginStep({
      workId, sessionId: info.sessionId, seq: info.seq, kind: info.kind,
      toolName: info.toolName, workSessionId: session?.workSessionId,
    }),
    endStep: (id, outcome) => store.endStep(id, outcome),
    openSteps: () => store.openSteps(workId).map((step) => ({ id: step.id, seq: step.seq, kind: step.kind })),
    reconcile: async (steps, context) => {
      const note = await reconcile(steps, context);
      store.resolveSteps(steps.map((step) => step.id));
      store.appendEvent(workId, "steps-reconciled", { steps: steps.length, stale: context.stale });
      return note;
    },
  };
}
