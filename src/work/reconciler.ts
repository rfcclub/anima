/**
 * Evidence, outbox and the review/revise cycle for castle works (anima #135, WL-4).
 *
 * `collectEvidence` is what the work handler calls when a session says it is done: it finds the pull request
 * on GitHub, checks it belongs to this work, records its head and queues the review. `tick` executes the
 * outbox and watches open pull requests. Every outward operation is keyed by work, pull request and head, and
 * the same key goes to Mesh as the idempotency key, so a crash or a lost response at any point leaves one
 * review job per head and one revise job per head.
 */

import { baseForRepo } from "./config";
import { anyCurrentChangeRequest, checksGreen, decideAcceptance, readReviews, verifyPullRequest, type WorkGitHub } from "./evidence";
import type { MeshJobDetails } from "../mesh-jobs/client";
import type { Evidence } from "./consumer";
import type { PullRequestInfo, ReviewInfo } from "./evidence";
import type { OutboxEntry, WorkRecord, WorkStore } from "./store";

/** Above start-work jobs (-10): a pull request that is waiting for its author is finished before new work starts. */
export const REVISE_PRIORITY = 0;

export interface MeshEnqueuer {
  enqueue(input: Record<string, unknown>): Promise<{ id: string }>;
  confirm(jobId: string): Promise<void>;
  /** Required only for an explicit operator retry; read with the original enqueuer's Mesh identity. */
  getJob?(jobId: string): Promise<MeshJobDetails>;
  /** Pin one capability for the read and enqueue, even if the live presence rejoins. */
  retrySession?(): {
    /** The identity bound to that same capability. Missing identity makes retry validation fail closed. */
    enqueuer?: string;
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
  /**
   * The mesh ID of each author agent. With several authors a revise job is eligible only for the author the work is
   * pinned to. Absent: every `authorMeshIds` entry is eligible, as with a single author.
   */
  authorMeshIdByAgent?: Record<string, string>;
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
    const verdict = verifyPullRequest(work, pr, { base: baseForRepo(config.repoBases, config.base, work.repo), authorActor: config.authorActor });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    // Decided by the kind of session that ran, not by the work's state: closing the session has already moved
    // the state on from `revising` by the time the evidence is collected.
    if (options.revise && work.prHead && pr.headSha.toLowerCase() === work.prHead.toLowerCase()) {
      return { ok: false, reason: "no new commit since the review that asked for changes" };
    }
    store.recordPullRequest(workId, { number: pr.number, head: pr.headSha, url: pr.url });
    this.queueReview(work, pr.number, pr.headSha);
    return { ok: true, url: pr.url };
  }

  /** Watches open pull requests and runs the outbox. Safe to run again at any time. */
  async tick(): Promise<void> {
    for (const work of this.deps.store.listWorks()) {
      if ((work.state === "in-review" || work.state === "revising") && work.prNumber !== null) {
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
    if (pr.merged || pr.state !== "open") {
      await this.settle(work, pr);
      return;
    }
    if (work.prHead && pr.headSha.toLowerCase() !== work.prHead.toLowerCase()) {
      store.recordPullRequest(work.workId, { number: pr.number, head: pr.headSha, url: pr.url });
      store.setState(work.workId, "in-review");
      this.queueReview(work, pr.number, pr.headSha);
      return;
    }
    if (work.state !== "in-review") return;
    const reviews = await github.reviews(work.repo, work.prNumber!);
    const reviewerLogins = config.reviewers.map((r) => r.login);
    const reading = readReviews(reviews, { head: pr.headSha, authorActor: config.authorActor, reviewerLogins });
    // A listed outside reviewer can ask for changes (it starts a revise) but never approves for the merge.
    const standingChanges = (config.externalReviewers?.length ?? 0) > 0
      ? readReviews(reviews, { head: pr.headSha, authorActor: config.authorActor, reviewerLogins: [...reviewerLogins, ...config.externalReviewers!] }).standingChanges
      : reading.standingChanges;
    if (standingChanges.length > 0) {
      const key = `revise:${work.workId}@${pr.headSha}`;
      const inserted = store.enqueueOutbox({
        key, workId: work.workId, purpose: "revise",
        payload: { repo: work.repo, number: pr.number, head: pr.headSha, reviews: standingChanges.map((r) => r.id) },
      });
      if (inserted) {
        store.setState(work.workId, "revising");
        store.appendEvent(work.workId, "changes-requested", { head: pr.headSha, reviews: standingChanges.map((r) => r.id) });
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

  private queueReview(work: WorkRecord, number: number, head: string): void {
    this.deps.store.enqueueOutbox({
      key: `review:${work.workId}:${number}@${head}`, workId: work.workId, purpose: "review", payload: { repo: work.repo, number, head },
    });
  }

  private async runOutbox(): Promise<void> {
    const { store } = this.deps;
    for (const entry of store.dueOutbox(this.now())) {
      try {
        await this.execute(entry);
        store.completeOutbox(entry.key);
      } catch (error) {
        store.retryOutbox(entry.key, this.now() + this.deps.config.retryBackoffMs, errorText(error));
        this.log("error", "outbox operation failed; will retry", { key: entry.key, error: errorText(error) });
      }
    }
  }

  private async execute(entry: OutboxEntry): Promise<void> {
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
    const payload = entry.payload as { repo: string; number: number; head: string; failedJobId?: string; reviewers?: string[] };
    const target = { repo: payload.repo, kind: "pr", number: payload.number, headSha: payload.head };
    const expiresAt = this.now() + DAY_MS;
    if (entry.purpose === "review") {
      await mesh.enqueue({
        type: "review", target, slots: Math.min(2, config.reviewers.length), eligible: config.reviewers.map((r) => r.meshId),
        excluded: config.authorMeshIds, expiresAt, idempotencyKey: `review:work:${work.workId}:${payload.number}@${payload.head}`,
      });
    } else if (entry.purpose === "revise") {
      const pinned = config.authorMeshIdByAgent?.[work.author];
      if (config.authorMeshIdByAgent && !pinned) throw new Error("revise refused: the work's author has no mesh ID");
      const reviseEligible = pinned ? [pinned] : config.authorMeshIds;
      const retry = entry.key.startsWith("revise-retry:");
      const session = retry ? mesh.retrySession?.() : undefined;
      if (retry && config.authorMeshIdByAgent && !session) {
        throw new Error("retry refused: the producer identity cannot be pinned");
      }
      if (session && (typeof session.enqueuer !== "string" || !session.enqueuer || session.enqueuer.trim() !== session.enqueuer)) {
        throw new Error("retry refused: the producer identity is missing");
      }
      const port = session ?? mesh;
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
        const author = reviseEligible[0];
        const matchesAuthor = (value: string) => value.toLowerCase() === author?.toLowerCase();
        const enqueuer = session?.enqueuer ?? author;
        if (reviseEligible.length !== 1 || !author || old.id !== payload.failedJobId || old.type !== "revise" ||
            !enqueuer || old.enqueuer.toLowerCase() !== enqueuer.toLowerCase() ||
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
        type: "revise", target, slots: 1, eligible: reviseEligible, priority: REVISE_PRIORITY, expiresAt,
        workRef: `${work.workId}.${work.approvedDigest.slice(0, 12)}`,
        idempotencyKey: retry ? entry.key : `revise:work:${work.workId}@${payload.head}`,
      });
    }
  }

  private log(level: "info" | "error", message: string, fields?: Record<string, unknown>): void {
    this.deps.log?.(level, message, fields);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
