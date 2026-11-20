/**
 * Evidence, outbox and the review/revise cycle for castle works (anima #135, WL-4).
 *
 * `collectEvidence` is what the work handler calls when a session says it is done: it finds the pull request
 * on GitHub, checks it belongs to this work, records its head and queues the review. `tick` executes the
 * outbox and watches open pull requests. Every outward operation is keyed by work, pull request and head, and
 * stable keys go to Mesh as idempotency keys, so retries do not duplicate a review or revision. A returned
 * head may need a new review key when its earlier Mesh job can no longer run.
 */

import { baseForRepo } from "./config";
import { anyCurrentChangeRequest, checksGreen, decideAcceptance, readReviews, verifyPullRequest, type WorkGitHub } from "./evidence";
import type { MeshJobDetails } from "../mesh-jobs/client";
import type { Evidence } from "./consumer";
import type { PullRequestInfo, ReviewInfo } from "./evidence";
import type { OutboxEntry, WorkRecord, WorkStore } from "./store";

export interface MeshEnqueuer {
  enqueue(input: Record<string, unknown>): Promise<{ id: string }>;
  confirm(jobId: string): Promise<void>;
  /** Required only for an explicit operator retry; read with the original enqueuer's Mesh identity. */
  getJob?(jobId: string): Promise<MeshJobDetails>;
  /** Pin one capability for the read and enqueue, even if the live presence rejoins. */
  retrySession?(): {
    getJob(jobId: string): Promise<MeshJobDetails>;
    enqueue(input: Record<string, unknown>): Promise<{ id: string }>;
  };
}

export interface ReconcilerConfig {
  /** The base branch expected when the repository has no entry in `repoBases`. */
  base: string;
  /** Per-repository base branches (anima #372); a repository without an entry uses `base`. */
  repoBases?: Record<string, string>;
  /** GitHub login the author's pull requests and reviews carry (from the trusted authors map). */
  authorActor: string;
  /** Mesh IDs of the author; excluded from review jobs and the only ones eligible for revise jobs. */
  authorMeshIds: string[];
  reviewers: Array<{ agent: string; meshId: string; login: string }>;
  /** Outside reviewers whose standing change request starts a revise; never counted as approvals. */
  externalReviewers?: string[];
  retryBackoffMs: number;
}

export interface ReconcilerDeps {
  store: WorkStore;
  github: WorkGitHub;
  mesh: MeshEnqueuer;
  config: ReconcilerConfig;
  now?: () => number;
  log?: (level: "info" | "error", message: string, fields?: Record<string, unknown>) => void;
}

const DAY_MS = 24 * 3_600_000;
const validHead = (head: unknown): head is string => typeof head === "string" && /^[a-f0-9]{40}$/i.test(head);

export class Reconciler {
  private readonly now: () => number;
  /** Head key → earliest time a merge may be attempted again after a failure. */
  private readonly mergeRetry = new Map<string, number>();

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Verified pull request evidence for a session that claims to be done; records it and queues the review. */
  async collectEvidence(workId: string, options: { revise?: boolean; guard?: () => void | Promise<void> } = {}): Promise<Evidence> {
    const { store, github, config } = this.deps;
    const work = store.getWork(workId);
    if (!work) return { ok: false, reason: "unknown work" };
    const pr = await github.findPullRequest(work.repo, work.branch);
    // A writer whose lease or generation went while GitHub answered must not record the PR or queue a review.
    await options.guard?.();
    if (!pr) return { ok: false, reason: `no pull request from branch ${work.branch}` };
    if (!validHead(pr.headSha)) return { ok: false, reason: "pull request head unavailable" };
    const verdict = verifyPullRequest(work, pr, { base: baseForRepo(config.repoBases, config.base, work.repo), authorActor: config.authorActor });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    // Decided by the kind of session that ran, not by the work's state: closing the session has already moved
    // the state on from `revising` by the time the evidence is collected.
    if (options.revise && work.prHead && pr.headSha.toLowerCase() === work.prHead.toLowerCase()) {
      return { ok: false, reason: "no new commit since the review that asked for changes" };
    }
    if (!store.recordReviewHead(work, { number: pr.number, head: pr.headSha, url: pr.url }, false)) {
      return { ok: false, reason: "work changed while reading the pull request" };
    }
    return { ok: true, url: pr.url };
  }

  /** Watches open pull requests and runs the outbox. Safe to run again at any time. */
  async tick(): Promise<void> {
    for (const work of this.deps.store.listWorks()) {
      if (work.prNumber !== null && (work.state === "in-review" || work.state === "revising" || work.state === "checkpointed")) {
        try {
          await this.observe(work);
        } catch (error) {
          this.log("error", "work observation failed", { workId: work.workId, error: errorText(error) });
        }
      }
    }
    await this.runOutbox();
  }

  private async observe(work: WorkRecord): Promise<void> {
    const { store, github, config } = this.deps;
    const pr = await github.pullRequest(work.repo, work.prNumber!);
    const current = store.getWork(work.workId);
    if (!current || current.generation !== work.generation || current.state !== work.state ||
        current.prNumber !== work.prNumber || current.prHead !== work.prHead) return;
    if (pr.number !== work.prNumber || !validHead(pr.headSha)) throw new Error("pull request head unavailable");
    if (pr.merged || pr.state !== "open") {
      if (work.state !== "checkpointed") await this.settle(work, pr);
      return;
    }
    const head = pr.headSha.toLowerCase();
    const moved = head !== work.prHead?.toLowerCase();
    if (work.state === "checkpointed" && !moved) return;
    if (!store.recordReviewHead(work, { number: pr.number, head, url: pr.url }, moved)) return;
    if (moved || work.state !== "in-review") return;
    const reviews = await github.reviews(work.repo, work.prNumber!);
    const reviewerLogins = config.reviewers.map((r) => r.login);
    const reading = readReviews(reviews, { head: pr.headSha, authorActor: config.authorActor, reviewerLogins });
    // A listed outside reviewer can ask for changes (it starts a revise) but never approves for the merge.
    const standingChanges = (config.externalReviewers?.length ?? 0) > 0
      ? readReviews(reviews, { head: pr.headSha, authorActor: config.authorActor, reviewerLogins: [...reviewerLogins, ...config.externalReviewers!] }).standingChanges
      : reading.standingChanges;
    if (standingChanges.length > 0) {
      const key = `revise:${work.workId}@${head}`;
      const inserted = store.enqueueOutbox({
        key, workId: work.workId, purpose: "revise",
        payload: { repo: work.repo, number: pr.number, head, reviews: standingChanges.map((r) => r.id) },
      });
      if (inserted) {
        store.setState(work.workId, "revising");
        store.appendEvent(work.workId, "changes-requested", { head, reviews: standingChanges.map((r) => r.id) });
      }
      return;
    }
    const externalChange = anyCurrentChangeRequest(reviews, { head: pr.headSha, authorActor: config.authorActor });
    if (externalChange) {
      this.log("info", "work merge blocked by a standing change request", {
        workId: work.workId, number: pr.number, reviewer: externalChange.authorLogin,
      });
      return;
    }
    await this.maybeMerge(work, pr, reading.approvals);
  }

  /**
   * Merges a work pull request once an independent approval is on the current head, every check is green, there
   * are no unresolved review threads and the pull request is not a draft. The merge itself is the gate: it is
   * attempted once per head per backoff window and always pinned with `--match-head-commit`. A merged pull
   * request is accepted by `settle` on the next tick.
   */
  private async maybeMerge(work: WorkRecord, pr: PullRequestInfo, approvals: ReviewInfo[]): Promise<void> {
    const { store, github } = this.deps;
    if (approvals.length === 0) return;
    if (pr.draft === true) return;
    if (pr.mergeable !== true) return; // false blocks; null/undefined means GitHub has not computed it yet
    if (!github.checks || !github.unresolvedThreads || !github.merge) return;
    const key = `${work.workId}@${pr.headSha}`;
    const retryAt = this.mergeRetry.get(key) ?? 0;
    if (this.now() < retryAt) return;
    const checks = await github.checks(work.repo, pr.number);
    if (!checksGreen(checks)) return;
    const threads = await github.unresolvedThreads(work.repo, pr.number);
    if (threads > 0) return;
    this.mergeRetry.set(key, this.now() + 5 * 60_000);
    try {
      await github.merge(work.repo, pr.number, pr.headSha);
      store.appendEvent(work.workId, "merge-requested", {
        number: pr.number, head: pr.headSha, approvals: approvals.map((r) => r.id),
      });
      this.log("info", "work pull request merge requested", { workId: work.workId, number: pr.number, head: pr.headSha });
    } catch (error) {
      this.log("error", "work pull request merge failed", { workId: work.workId, number: pr.number, error: errorText(error) });
    }
  }

  /** A merged or closed pull request: accept, flag for reconciliation, or block. Only GitHub's state counts. */
  private async settle(work: WorkRecord, pr: PullRequestInfo): Promise<void> {
    const { store, github, config } = this.deps;
    const reviews = pr.merged ? await github.reviews(work.repo, work.prNumber!) : [];
    const decision = decideAcceptance(pr, reviews, {
      head: pr.headSha, authorActor: config.authorActor, reviewerLogins: config.reviewers.map((r) => r.login),
    });
    if (decision.kind === "blocked") {
      store.setState(work.workId, "blocked", decision.reason);
      store.appendEvent(work.workId, "not-accepted", { reason: decision.reason, number: pr.number });
    } else if (decision.kind === "accepted") {
      store.setState(work.workId, "accepted");
      store.appendEvent(work.workId, "accepted", { number: pr.number, head: pr.headSha, approvals: decision.approvals.map((r) => r.id) });
      const jobIds = store.listEvents(work.workId)
        .filter((event) => event.kind === "job-reported")
        .map((event) => (event.detail as { jobId?: string }).jobId)
        .filter((id): id is string => typeof id === "string");
      // The transport jobs are confirmed only now, and a failed confirmation is retried without re-running anything.
      store.enqueueOutbox({ key: `confirm:${work.workId}`, workId: work.workId, purpose: "confirm", payload: { jobIds: [...new Set(jobIds)] } });
    }
  }

  private async runOutbox(): Promise<void> {
    const { store } = this.deps;
    for (const entry of store.dueOutbox(this.now())) {
      try {
        const status = await this.execute(entry);
        store.completeOutbox(entry.key, status ?? "done");
      } catch (error) {
        store.retryOutbox(entry.key, this.now() + this.deps.config.retryBackoffMs, errorText(error));
        this.log("error", "outbox operation failed; will retry", { key: entry.key, error: errorText(error) });
      }
    }
  }

  private async execute(entry: OutboxEntry): Promise<"superseded" | undefined> {
    const { mesh, config, store } = this.deps;
    const work = store.getWork(entry.workId);
    if (!work) return;
    if (entry.purpose === "confirm") {
      const leftToEnqueuer: string[] = [];
      for (const jobId of (entry.payload as { jobIds: string[] }).jobIds) {
        try {
          await mesh.confirm(jobId);
        } catch (error) {
          const text = errorText(error);
          // already confirmed (or never reported): nothing left to do for this job
          if (/is not reported/.test(text)) continue;
          // only the enqueuer confirms a job: one enqueued by someone else (the `mesh work` caller) is theirs to confirm
          if (/authorization failed/.test(text)) { leftToEnqueuer.push(jobId); continue; }
          throw error;
        }
      }
      if (leftToEnqueuer.length > 0) store.appendEvent(work.workId, "confirm-left-to-enqueuer", { jobIds: leftToEnqueuer });
      return;
    }
    const payload = entry.payload as {
      repo: string; number: number; head: string; failedJobId?: string; reviewers?: string[];
      previousDispatchKey?: string; dispatchKey?: string;
    };
    const retry = entry.purpose === "revise" && entry.key.startsWith("revise-retry:");
    if (!retry) {
      const pr = await this.deps.github.pullRequest(payload.repo, payload.number);
      if (pr.number !== payload.number || !validHead(pr.headSha)) throw new Error("pull request head unavailable");
      const current = store.getWork(work.workId);
      if (pr.state !== "open" || pr.merged || pr.headSha.toLowerCase() !== payload.head.toLowerCase() ||
          current?.prNumber !== payload.number || current.prHead?.toLowerCase() !== payload.head.toLowerCase()) return "superseded";
    }
    const target = { repo: payload.repo, kind: "pr", number: payload.number, headSha: payload.head };
    const expiresAt = this.now() + DAY_MS;
    if (entry.purpose === "review") {
      const input = {
        type: "review", target, slots: Math.min(2, config.reviewers.length), eligible: config.reviewers.map((r) => r.meshId),
        excluded: config.authorMeshIds, expiresAt,
      };
      if (!payload.previousDispatchKey) {
        await mesh.enqueue({ ...input, idempotencyKey: `review:work:${work.workId}:${payload.number}@${payload.head}` });
        return;
      }

      // Idempotently resolve even legacy rows that did not store the gateway job ID.
      const port = mesh.retrySession ? mesh.retrySession() : mesh;
      if (!port.getJob) throw new Error("review return deferred: prior Mesh job cannot be read");
      const candidateKey = payload.dispatchKey ?? payload.previousDispatchKey;
      const candidate = await port.enqueue({ ...input, idempotencyKey: candidateKey });
      const prior = await port.getJob(candidate.id);
      if (prior.id !== candidate.id || prior.type !== "review" || prior.target?.kind !== "pr" ||
          prior.target.repo?.toLowerCase() !== payload.repo.toLowerCase() || prior.target.number !== payload.number ||
          prior.target.headSha?.toLowerCase() !== payload.head.toLowerCase()) {
        throw new Error("review return deferred: prior Mesh job does not match the pull request");
      }
      let usable = usableReviewJob(prior, this.now());
      if (prior.state === "reported" || prior.state === "completed") {
        const reading = readReviews(await this.deps.github.reviews(payload.repo, payload.number), {
          head: payload.head, authorActor: config.authorActor, reviewerLogins: config.reviewers.map((reviewer) => reviewer.login),
        });
        usable = reading.approvals.length > 0 || reading.standingChanges.length > 0;
      }

      // The head or work may have changed while the gateway answered.
      const pr = await this.deps.github.pullRequest(payload.repo, payload.number);
      if (pr.number !== payload.number || !validHead(pr.headSha)) throw new Error("pull request head unavailable");
      const current = store.getWork(work.workId);
      if (pr.state !== "open" || pr.merged || pr.headSha.toLowerCase() !== payload.head.toLowerCase() ||
          !current || current.generation !== work.generation || current.state !== work.state ||
          current.prNumber !== payload.number || current.prHead?.toLowerCase() !== payload.head.toLowerCase()) return "superseded";
      if (usable) {
        if (!store.setPendingReviewDispatchKey(entry.key, candidateKey)) return "superseded";
        return;
      }
      const replacementKey = `review:work:${entry.key.slice("review:".length)}`;
      if (candidateKey === replacementKey) throw new Error("review return deferred: replacement job is no longer usable");
      // Persist before sending: a lost response or later head return must resolve this exact key.
      if (!store.setPendingReviewDispatchKey(entry.key, replacementKey)) return "superseded";
      await port.enqueue({ ...input, idempotencyKey: replacementKey });
    } else if (entry.purpose === "revise") {
      const port = retry && mesh.retrySession ? mesh.retrySession() : mesh;
      if (retry) {
        if (work.state !== "checkpointed" || work.repo !== payload.repo || work.prNumber !== payload.number ||
            !work.prHead || work.prHead.toLowerCase() !== payload.head.toLowerCase()) {
          throw new Error("retry refused: work state or recorded PR head changed");
        }
        const pr = await this.deps.github.pullRequest(work.repo, payload.number);
        const verdict = verifyPullRequest(work, pr, { base: baseForRepo(config.repoBases, config.base, work.repo), authorActor: config.authorActor });
        if (!verdict.ok || pr.state !== "open" || pr.merged || pr.headSha.toLowerCase() !== payload.head.toLowerCase()) {
          throw new Error("retry refused: the verified pull request or its head changed");
        }
        const extra = payload.reviewers ?? [];
        const reading = readReviews(await this.deps.github.reviews(work.repo, payload.number), {
          head: payload.head, authorActor: config.authorActor,
          reviewerLogins: [...config.reviewers.map((reviewer) => reviewer.login), ...extra],
        });
        const standing = new Set(reading.standingChanges.map((review) => review.authorLogin.toLowerCase()));
        if (standing.size === 0 || extra.some((reviewer) => !standing.has(reviewer.toLowerCase()))) {
          throw new Error("retry refused: requested review no longer stands on this head");
        }
        if (!payload.failedJobId || !port.getJob) throw new Error("retry refused: prior Mesh job cannot be read");
        const old = await port.getJob(payload.failedJobId);
        const author = config.authorMeshIds[0];
        const matchesAuthor = (value: string) => value.toLowerCase() === author?.toLowerCase();
        if (config.authorMeshIds.length !== 1 || !author || old.id !== payload.failedJobId || old.type !== "revise" ||
            !matchesAuthor(old.enqueuer) ||
            !["queued", "expired"].includes(old.state) || old.slots !== 1 ||
            old.target.repo.toLowerCase() !== work.repo.toLowerCase() || old.target.kind !== "pr" ||
            old.target.number !== payload.number || old.target.headSha?.toLowerCase() !== payload.head.toLowerCase() ||
            old.workRef !== `${work.workId}.${work.approvedDigest.slice(0, 12)}` ||
            !Array.isArray(old.eligible) || old.eligible.length !== 1 || !matchesAuthor(old.eligible[0]!) ||
            !Array.isArray(old.claims) || old.claims.some((claim) => !matchesAuthor(claim.worker) ||
              !["failed", "lost", "released"].includes(claim.state)) ||
            !old.claims.some((claim) => matchesAuthor(claim.worker) && claim.state === "failed")) {
          throw new Error("retry refused: prior job is not the failed, single-author revision");
        }
        // An operator or another supervisor can change the work while the remote checks are in flight.
        const current = store.getWork(work.workId);
        if (!current || current.state !== "checkpointed" || current.generation !== work.generation ||
            current.prHead?.toLowerCase() !== payload.head.toLowerCase() || current.prNumber !== payload.number) {
          throw new Error("retry refused: work changed during validation");
        }
      }
      await port.enqueue({
        type: "revise", target, slots: 1, eligible: config.authorMeshIds, priority: -10, expiresAt,
        workRef: `${work.workId}.${work.approvedDigest.slice(0, 12)}`,
        idempotencyKey: retry ? entry.key : `revise:work:${work.workId}@${payload.head}`,
      });
    }
  }

  private log(level: "info" | "error", message: string, fields?: Record<string, unknown>): void {
    this.deps.log?.(level, message, fields);
  }
}

/** A job with an active or claimable reviewer can still serve this head; unknown data fails closed. */
function usableReviewJob(job: MeshJobDetails, now: number): boolean {
  if (!["queued", "reported", "completed", "expired"].includes(job.state) ||
      !Number.isFinite(job.expiresAt) || !Number.isSafeInteger(job.slots) || job.slots < 1 ||
      !Array.isArray(job.eligible) ||
      !job.eligible.every((worker) => typeof worker === "string") ||
      !Array.isArray(job.excluded) || !job.excluded.every((worker) => typeof worker === "string") ||
      !Array.isArray(job.claims) || job.claims.some((claim) =>
        typeof claim.worker !== "string" || !["active", "reported", "failed", "lost", "released"].includes(claim.state))) {
    throw new Error("review return deferred: prior Mesh job has unknown state");
  }
  if (job.state === "reported" || job.state === "completed") return true;
  // Mesh reads the job and its claims separately; all slots may report between those reads.
  if (job.claims.filter((claim) => claim.state === "reported").length >= job.slots) return true;
  if (job.state === "expired" || job.expiresAt <= now) return false;
  const excluded = new Set(job.excluded.map((worker) => worker.toLowerCase()));
  const eligible = job.eligible.map((worker) => worker.toLowerCase()).filter((worker) => !excluded.has(worker));
  const active = new Set(job.claims.filter((claim) => claim.state === "active").map((claim) => claim.worker.toLowerCase()));
  if (eligible.some((worker) => active.has(worker))) return true;
  const consumed = new Set(job.claims.filter((claim) => ["active", "reported", "failed"].includes(claim.state))
    .map((claim) => claim.worker.toLowerCase()));
  return eligible.some((worker) => !consumed.has(worker));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
