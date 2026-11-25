/**
 * The worker adapter seam (rfcclub/anima#238, cartridge-worker-dispatch): the executor prepares a work's
 * workspace and hands one session to an adapter, which builds and stops. Adapter #0 is today's in-process
 * loop (`loopAdapter` in executor.ts); an external task worker is a later adapter.
 */

import type { SessionRecord, WorkRecord } from "./store";
import type { StopCause } from "./consumer";
import type { Workspace } from "./workspace";

export interface WorkerAdapterInput {
  work: WorkRecord;
  session: SessionRecord;
  claim: { id: string; jobId: string };
  kind: "start-work" | "revise";
  maxIterations: number;
  deadlineMs: number;
  /** Executor start time, including workspace preparation, in the executor's clock. */
  startedAt?: number;
  /** Aborts on lease loss or deadline; the adapter must then stop and report cessation. */
  signal: AbortSignal;
  workspace: Workspace;
}

export interface WorkerAdapterResult {
  stopCause: StopCause;
  interruptionSource?: "abort" | "sigint";
  iterations: number;
  cessation: "proven" | "unproven";
  cessationCheck?: string;
  blockedReason?: string;
}

export interface WorkerAdapter {
  readonly kind: string;
  run(input: WorkerAdapterInput): Promise<WorkerAdapterResult>;
}
