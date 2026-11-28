/**
 * Assembles the work loop's pieces from the `work` config block (anima #135). Every outside dependency comes in
 * through `deps`, so the assembly is testable with fakes; `src/mesh-jobs/start.ts` supplies the real ones.
 */

import type { MeshJobsWorkConfig } from "../mesh-jobs/config";
import type { WorkJobHandler } from "../mesh-jobs/consumer";
import type { GitHubReader } from "../mesh-jobs/consumer";
import type { ConsumerLog } from "../mesh-jobs/consumer";
import { createWorkHandler, type SessionExecutor, type StopCause } from "./consumer";
import { loadWorkConfig } from "./config";
import { readReviews, type WorkGitHub } from "./evidence";
import { Reconciler, type MeshEnqueuer } from "./reconciler";
import type { StopRecord, WorkRecord, WorkStore } from "./store";
import { checkContinuation, createStopRecorder, recordInterruptedStops, type TreeRead } from "./stops";

export interface WorkRuntimeDeps {
  store: WorkStore;
  executor: SessionExecutor;
  github: GitHubReader;
  workGithub: WorkGitHub;
  enqueuer: MeshEnqueuer;
  heartbeatMs: number;
  /**
   * Read-only git on a work tree (production: the sandboxed tree-git). With it the handler writes a stop record for
   * every session end and recovery writes interrupted records (rfcclub/anima#238 AC-8). Absent keeps the old behavior.
   */
  treeRead?: TreeRead;
  onTrustedStop?: (work: WorkRecord, stop: StopRecord) => void;
  /** Host-side publish safety net; absent keeps the old behavior. */
  publishFallback?: (input: {
    work: WorkRecord;
    kind: "start-work" | "revise";
    stopCause: StopCause;
    guard?: () => void;
    settledGuard?: () => Promise<void>;
  }) => Promise<{ published: boolean; reason?: string }>;
  log: ConsumerLog;
  now?: () => number;
}

export interface WorkRuntime {
  handler: WorkJobHandler;
  reconciler: Reconciler;
}

export function buildWorkRuntime(config: MeshJobsWorkConfig, deps: WorkRuntimeDeps): WorkRuntime {
  // A process that died mid-session leaves it open. Charge it in full before anything new can start.
  const recovered = deps.store.recoverOpenSessions();
  if (recovered.length > 0) deps.log("info", "work sessions left open by a restart were charged in full", { sessions: recovered.length });
  if (deps.treeRead) {
    const interrupted = recordInterruptedStops(deps.store);
    if (interrupted.length > 0) deps.log("info", "interrupted sessions recorded after a restart", { sessions: interrupted.length });
  }

  const reconciler = new Reconciler({
    store: deps.store,
    github: deps.workGithub,
    mesh: deps.enqueuer,
    config: {
      base: config.base,
      ...(config.repoBases ? { repoBases: config.repoBases } : {}),
      authorActor: config.authorActor,
      authorMeshIds: [config.authorMeshId, ...(config.extraAuthors ?? []).map((extra) => extra.meshId)],
      ...((config.extraAuthors ?? []).length > 0 ? {
        authorMeshIdByAgent: {
          [config.author]: config.authorMeshId,
          ...Object.fromEntries((config.extraAuthors ?? []).map((extra) => [extra.agent, extra.meshId])),
        },
      } : {}),
      reviewers: config.reviewers,
      externalReviewers: config.externalReviewers,
      retryBackoffMs: config.releaseBackoffMs * 2,
    },
    now: deps.now,
    log: deps.log,
  });

  const recordStop = deps.treeRead ? createStopRecorder({ store: deps.store, read: deps.treeRead }) : undefined;
  const handler = createWorkHandler({
    store: deps.store,
    executor: deps.executor,
    github: deps.github,
    heartbeatMs: deps.heartbeatMs,
    collectEvidence: (workId, options) => reconciler.collectEvidence(workId, options),
    findPublishedPr: async (repo, branch) => (await deps.workGithub.findPullRequest(repo, branch)) !== null,
    validateRevision: validateRevisionFeedback(deps.workGithub, config, deps.store),
    ...(deps.publishFallback ? { publishFallback: deps.publishFallback } : {}),
    ...(recordStop ? { recordStop: (input) => {
      const stop = recordStop(input);
      if (stop.trusted) deps.onTrustedStop?.(input.work, stop);
      return stop;
    } } : {}),
    ...(deps.treeRead ? { continuation: (work: WorkRecord) => checkContinuation(deps.store, work, deps.treeRead!) } : {}),
    authors: (config.extraAuthors ?? []).map((extra) => extra.agent),
    maxConcurrentWorks: config.maxConcurrentWorks,
    config: loadWorkConfig({
      author: config.author,
      externalAdapter: config.externalAdapter,
      ...(config.provider && config.model ? { provider: config.provider, model: config.model } : {}),
      ...(config.caps !== undefined ? { caps: config.caps } : {}),
    }),
    now: deps.now,
    log: deps.log,
  });

  return { handler, reconciler };
}

function authorizedExtraReviewers(
  work: { workId?: string; prHead: string | null },
  store?: Pick<WorkStore, "listEvents">,
): string[] {
  const events = work.workId && work.prHead && store ? store.listEvents(work.workId) : [];
  const recovery = events.filter((event) => event.kind === "operator-recovery").at(-1);
  const authorization = recovery && events.filter((event) => {
    const detail = event.detail as { head?: unknown; recoverySeq?: unknown };
    return event.kind === "operator-revise-retry" && event.seq > recovery.seq &&
      detail.recoverySeq === recovery.seq && detail.head === work.prHead;
  }).at(-1);
  const extra = (authorization?.detail as { reviewers?: unknown } | undefined)?.reviewers;
  return Array.isArray(extra) ? extra.filter((login): login is string => typeof login === "string") : [];
}

/** Refuse an obsolete request before reserving a session, including any explicitly selected reviewer. */
export function validateRevisionFeedback(
  github: WorkGitHub,
  config: Pick<MeshJobsWorkConfig, "authorActor" | "reviewers"> & { externalReviewers?: string[] },
  store?: Pick<WorkStore, "listEvents">,
): (work: WorkRecord) => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async (work) => {
    if (work.prNumber === null || !work.prHead) return { ok: false, reason: "work has no recorded PR head" };
    const extra = authorizedExtraReviewers(work, store);
    const reading = readReviews(await github.reviews(work.repo, work.prNumber), {
      head: work.prHead, authorActor: config.authorActor, reviewerLogins: [...config.reviewers.map((r) => r.login), ...(config.externalReviewers ?? []), ...extra],
    });
    const standing = new Set(reading.standingChanges.map((review) => review.authorLogin.toLowerCase()));
    if (standing.size === 0 || extra.some((reviewer) => !standing.has(reviewer.toLowerCase()))) {
      return { ok: false, reason: "requested review no longer stands on this head" };
    }
    return { ok: true };
  };
}

/** What the independent reviewers asked for on the work's current head: the brief for a revise session. */
export function reviewFeedback(
  github: WorkGitHub,
  config: Pick<MeshJobsWorkConfig, "authorActor" | "reviewers"> & { externalReviewers?: string[] },
  store?: Pick<WorkStore, "listEvents">,
): (work: { workId?: string; repo: string; prNumber: number | null; prHead: string | null }) => Promise<string> {
  return async (work) => {
    if (work.prNumber === null || !work.prHead) return "";
    const reviewers = authorizedExtraReviewers(work, store);
    const reading = readReviews(await github.reviews(work.repo, work.prNumber), {
      head: work.prHead, authorActor: config.authorActor, reviewerLogins: [...config.reviewers.map((r) => r.login), ...(config.externalReviewers ?? []), ...reviewers],
    });
    const comments = github.reviewComments ? await github.reviewComments(work.repo, work.prNumber) : [];
    const entries = reading.standingChanges.map((review) => {
      const inline = comments.filter((comment) => comment.reviewId === review.id &&
        comment.commitId.toLowerCase() === work.prHead!.toLowerCase() &&
        comment.authorLogin.toLowerCase() === review.authorLogin.toLowerCase());
      const visible = inline.slice(0, 25).map((comment) => {
        const body = comment.body.slice(0, 8_000);
        const suffix = comment.body.length > body.length ? "\n[inline comment truncated]" : "";
        return `${comment.path}${comment.line === null ? "" : `:${comment.line}`}:\n${body}${suffix}`;
      });
      if (inline.length > visible.length) visible.push(`[${inline.length - visible.length} additional inline comments omitted]`);
      return `${review.authorLogin}:\n${(review.body ?? "").trim() || "(changes requested without text)"}${visible.length ? `\n\n${visible.join("\n\n")}` : ""}`;
    });
    return entries.join("\n\n");
  };
}
