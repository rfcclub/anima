/**
 * The working lane (rfcclub/anima#420, work-adapter-trial): one sequential loop where a worker registers,
 * the lane pulls the worker's next job, and the worker leaves when it has none. It is an asynchronous loop
 * in the service process, like the scheduled dream job, and needs no worker thread: nothing here blocks,
 * and the loop is one at a time.
 *
 * A job that throws does not end the lane: the failure is recorded and the lane pulls the worker's next job.
 * A lane that dies is restarted from outside (the orchestrator); this module only runs and reports.
 *
 * The lane also loads the author's substrate view for the programming activity, once per work session, so
 * that a work session gets the view of a programmer rather than the agent's everyday view. The view is
 * read-only task context: nothing in it can change tools, rules or approvals. If it cannot be loaded the
 * session stops with a named reason instead of continuing without it.
 */

import type { SubstrateAdapter } from "../substrate/substrate-adapter";
import type { DefaultSubstrateViewLayer } from "../substrate/default-view-layer";
import type { ResolvedCartridgeRetrieval, SubstrateView } from "../substrate/substrate-view";

/** The activity a work session runs as. Every other activity (the agent's everyday one) keeps its own view. */
export const WORK_LANE_ACTIVITY = "programming";

/** The named reason a session stops with when its substrate view could not be loaded. */
export const SUBSTRATE_VIEW_UNAVAILABLE = "substrate-view-unavailable";

export class SubstrateViewUnavailable extends Error {
  readonly reason = SUBSTRATE_VIEW_UNAVAILABLE;
  constructor(cause: unknown) {
    super(`${SUBSTRATE_VIEW_UNAVAILABLE}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SubstrateViewUnavailable";
  }
}

/** What the lane hands the prompt: the retrieved blocks and the scopes they cover. */
export interface LaneView {
  activity: string;
  /** The scopes the view covers, in the order the layer reported them. */
  scopes: string[];
  /** The retrieved content, as markdown sections; empty when the view has no blocks. */
  text: string;
  /** The layer's estimate of the view's tokens. */
  estimatedTokens: number;
}

/** The retrieval policies of the programming activity's cartridges, resolved against what the substrate has. */
export function programmingPolicies(
  adapter: SubstrateAdapter,
  scopes: string[] = ["project", "episode"],
): ResolvedCartridgeRetrieval[] {
  const available = new Set(adapter.listScopes().map((scope) => scope.name));
  const included = scopes.filter((scope) => available.has(scope));
  const missing = scopes.filter((scope) => !available.has(scope));
  return [{
    cartridgeId: WORK_LANE_ACTIVITY,
    scopesIncluded: included,
    scopesMissing: missing,
    scopesDegraded: [],
    fallbackActions: Object.fromEntries(missing.map((scope) => [scope, "continue_with_warning" as const])),
    blocked: false,
  }];
}

/**
 * Build the author's view for one activity. A layer or adapter failure is not swallowed: it becomes a
 * `SubstrateViewUnavailable`, which the session turns into a named stop.
 */
export async function buildLaneView(input: {
  layer: Pick<DefaultSubstrateViewLayer, "buildView">;
  adapter: SubstrateAdapter;
  agentId: string;
  activity?: string;
  policies?: ResolvedCartridgeRetrieval[];
  defaultScopes?: string[];
  maxTokens?: number;
}): Promise<LaneView> {
  const activity = input.activity ?? WORK_LANE_ACTIVITY;
  try {
    const view: SubstrateView = await input.layer.buildView({
      adapter: input.adapter,
      agentDefaults: { agentId: input.agentId, ...(input.defaultScopes ? { defaultScopes: input.defaultScopes } : {}) },
      cartridgePolicies: input.policies ?? programmingPolicies(input.adapter),
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    });
    const text = view.results
      .filter((result) => result.status === "ok" && result.content.length > 0)
      .map((result) => `### ${result.scopesMatched[0] ?? "context"}\n\n${result.content}`)
      .join("\n\n");
    return { activity, scopes: view.scopesCovered, text, estimatedTokens: view.estimatedTokens };
  } catch (error) {
    throw new SubstrateViewUnavailable(error);
  }
}

/** A job a worker hands to the lane; running it is the worker's session. */
export interface LaneJob<T> {
  run(signal: AbortSignal): Promise<T>;
}

/** A registered worker: the lane pulls its next job until it has none, and then the worker leaves the lane. */
export interface LaneWorker<T> {
  readonly name: string;
  next(): Promise<LaneJob<T> | null>;
}

export interface LaneFailure {
  worker: string;
  reason: string;
}

export interface LaneResult<T> {
  completed: T[];
  failures: LaneFailure[];
}

/**
 * Run the lane: one sequential loop over the registered workers. Each worker is asked for its next job until it
 * returns null (it leaves the lane); a job that throws is recorded and the lane continues with the next one.
 * A signal stops the lane between jobs.
 */
export async function runLane<T>(
  workers: LaneWorker<T>[],
  signal?: AbortSignal,
  onProgress?: (event: { type: "job-completed" | "job-failed" | "worker-left"; worker: string; reason?: string }) => void,
): Promise<LaneResult<T>> {
  const completed: T[] = [];
  const failures: LaneFailure[] = [];
  for (const worker of workers) {
    while (!signal?.aborted) {
      const job = await worker.next();
      if (job === null) {
        onProgress?.({ type: "worker-left", worker: worker.name });
        break;
      }
      try {
        completed.push(await job.run(signal ?? new AbortController().signal));
        onProgress?.({ type: "job-completed", worker: worker.name });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ worker: worker.name, reason });
        onProgress?.({ type: "job-failed", worker: worker.name, reason });
      }
    }
  }
  return { completed, failures };
}
