import { intentRevision, type IntentTarget } from "../tools/review-budget";
import { LeaseLostError, type MeshClaim, type MeshJob, type MeshJobReport } from "./client";
import { buildIntentReviewMessage, buildReviewMessage } from "./review-message";

/** The `/jobs` calls one worker makes; `MeshJobsClient` implements it. */
export interface JobsPort {
  pending(): Promise<number>;
  claim(): Promise<MeshClaim | null>;
  getJob(jobId: string): Promise<MeshJob>;
  heartbeat(claimId: string): Promise<MeshClaim>;
  report(claimId: string, report: MeshJobReport): Promise<MeshClaim>;
  /** Hands an unfinished start-work/revise claim back (anima#135). Optional: review-only ports need none. */
  release?(claimId: string): Promise<MeshClaim>;
}

/** What a work handler decided about a claimed start-work or revise job. */
export type WorkOutcome =
  | { kind: "report"; report: MeshJobReport }
  | { kind: "release"; backoffMs?: number }
  | { kind: "lease-lost" };

/** Runs claimed start-work and revise jobs (anima#135). Review jobs never reach it. */
export interface WorkJobHandler {
  run(input: { worker: string; claim: MeshClaim; job: MeshJob; jobs: JobsPort }): Promise<WorkOutcome>;
}

/** `authorType` is GitHub's `user.type`: "Bot" for a GitHub App, "User" for a person. */
export interface PullRequestReview { commitId: string; body: string; submittedAt: string; url: string; authorType: string }

export interface IssueComment { id: number; body: string; author: string; updatedAt: string; url: string }
export interface IssueState { title: string; body: string; labels: string[]; authorLogin: string; comments: IssueComment[] }

/** Read-only GitHub access. GitHub is the evidence; the agent's own reply never is. */
export interface GitHubReader {
  pullRequest(repo: string, n: number): Promise<{
    headSha: string; state: "open" | "closed"; merged: boolean; title: string; body: string; author: string;
  }>;
  diff(repo: string, n: number): Promise<string>;
  issue(repo: string, n: number): Promise<{ title: string; body: string }>;
  reviews(repo: string, n: number): Promise<PullRequestReview[]>;
  /** Issue snapshot with comments; required for review-intent jobs. */
  issueState?(repo: string, n: number): Promise<IssueState>;
}

/** Runs one agent turn. It must stop when `signal` aborts. */
export type TurnRunner = (input: {
  agent: string; message: string; signal: AbortSignal; provider?: string; model?: string; profile?: "review"; repo?: string;
  /** Set for an intent-review turn: the issue under review, so the turn's process can enforce one verdict (#300). */
  intent?: IntentTarget;
}) => Promise<void>;

export type ConsumerLog = (level: "info" | "error", message: string, fields?: Record<string, unknown>) => void;

export interface MeshJobConsumerOptions {
  workers: Array<{ agent: string; jobs: JobsPort; provider?: string; model?: string }>;
  github: GitHubReader;
  runTurn: TurnRunner;
  heartbeatMs: number;
  turnTimeoutMs: number;
  /** Handles start-work and revise jobs. Without it such a claim is handed straight back. */
  work?: WorkJobHandler;
  /**
   * Independent reviewers allowed to run review-intent jobs, with the GitHub login each one posts as. Absent means
   * the consumer cannot handle review-intent jobs and reports them failed.
   */
  intentReviewers?: Array<{ agent: string; login: string }>;
  /** The issue label the Orca workflow applies on approval; must match the pipeline's `issueLabel`. */
  approvalLabel?: string;
  /** How long a worker leaves the queue alone after handing a claim back, so a released job is not re-claimed in a loop. Default 30 s. */
  releaseBackoffMs?: number;
  now?: () => number;
  log?: ConsumerLog;
}

type Worker = MeshJobConsumerOptions["workers"][number];

/**
 * Pull-based job consumer for ANIMA agents (rfcclub/anima#76, slice 3).
 * Each tick, an idle worker checks its pending count and claims at most one
 * job. Only review jobs on the PR's current head are run. A claim is reported
 * `done` only with a matching review on GitHub as evidence.
 */
export class MeshJobConsumer {
  private readonly busy = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: ConsumerLog;

  constructor(private readonly options: MeshJobConsumerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Resolves when every job started by this tick has finished. */
  async tick(): Promise<void> {
    await Promise.all(this.options.workers.map((worker) => this.tickWorker(worker)));
  }

  private async tickWorker(worker: Worker): Promise<void> {
    if (this.busy.has(worker.agent)) return;
    if (this.now() < (this.cooldownUntil.get(worker.agent) ?? 0)) return;
    this.busy.add(worker.agent);
    try {
      if ((await worker.jobs.pending()) <= 0) return;
      const claim = await worker.jobs.claim();
      if (!claim) return;
      const claimedAt = this.now();
      this.log("info", "mesh job claimed", { agent: worker.agent, jobId: claim.jobId, claimId: claim.id });
      await this.runClaim(worker, claim, claimedAt);
    } catch (error) {
      this.log("error", "mesh job tick failed", { agent: worker.agent, error: errorText(error) });
    } finally {
      this.busy.delete(worker.agent);
    }
  }

  private async runClaim(worker: Worker, claim: MeshClaim, claimedAt: number): Promise<void> {
    let report: MeshJobReport;
    try {
      const job = await worker.jobs.getJob(claim.jobId);
      if (job.type === "start-work" || job.type === "revise") {
        await this.runWorkClaim(worker, claim, job);
        return;
      }
      const outcome = job.type === "review-intent"
        ? await this.runIntentReview(worker, claim, job, claimedAt)
        : await this.runReview(worker, claim, job, claimedAt);
      if (outcome === "lease-lost") return;
      report = outcome;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.log("info", "mesh job lease lost", { agent: worker.agent, claimId: claim.id });
        return;
      }
      this.log("error", "mesh job failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
      report = { outcome: "failed" };
    }
    try {
      await worker.jobs.report(claim.id, report);
      this.log("info", "mesh job reported", { agent: worker.agent, claimId: claim.id, outcome: report.outcome });
    } catch (error) {
      this.log("error", "mesh job report failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
    }
  }

  private async runWorkClaim(worker: Worker, claim: MeshClaim, job: MeshJob): Promise<void> {
    if (!this.options.work) {
      this.log("info", "mesh work job handed back: work jobs are not enabled here", { agent: worker.agent, claimId: claim.id });
      await this.handBack(worker, claim);
      return;
    }
    let outcome: WorkOutcome;
    try {
      outcome = await this.options.work.run({ worker: worker.agent, claim, job, jobs: worker.jobs });
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.log("info", "mesh work lease lost", { agent: worker.agent, claimId: claim.id });
        return;
      }
      this.log("error", "mesh work job failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
      outcome = { kind: "report", report: { outcome: "failed" } };
    }
    if (outcome.kind === "lease-lost") return;
    if (outcome.kind === "release") {
      await this.handBack(worker, claim, outcome.backoffMs);
      return;
    }
    try {
      await worker.jobs.report(claim.id, outcome.report);
      this.log("info", "mesh job reported", { agent: worker.agent, claimId: claim.id, outcome: outcome.report.outcome });
    } catch (error) {
      this.log("error", "mesh job report failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
    }
  }

  /** Release the claim and stay away from the queue for the backoff. A port without `release` reports failed, as before. */
  private async handBack(worker: Worker, claim: MeshClaim, backoffMs?: number): Promise<void> {
    this.cooldownUntil.set(worker.agent, this.now() + (backoffMs ?? this.options.releaseBackoffMs ?? 30_000));
    try {
      if (worker.jobs.release) await worker.jobs.release(claim.id);
      else await worker.jobs.report(claim.id, { outcome: "failed" });
      this.log("info", "mesh job claim handed back", { agent: worker.agent, claimId: claim.id });
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      this.log("error", "mesh job release failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
    }
  }

  private async runReview(worker: Worker, claim: MeshClaim, job: MeshJob, claimedAt: number): Promise<MeshJobReport | "lease-lost"> {
    const { repo, kind, number, headSha } = job.target;
    if (job.type !== "review" || kind !== "pr" || !headSha) {
      this.log("info", "mesh job not runnable here", { agent: worker.agent, claimId: claim.id, type: job.type });
      return { outcome: "failed" };
    }
    const pr = await this.options.github.pullRequest(repo, number);
    if (!sameHead(pr.headSha, headSha)) {
      this.log("info", "mesh job head is stale", { agent: worker.agent, claimId: claim.id, jobHead: headSha, prHead: pr.headSha });
      return { outcome: "failed" };
    }
    const message = buildReviewMessage({
      agent: worker.agent, repo, pr: number, headSha, title: pr.title, author: pr.author,
      diff: await this.options.github.diff(repo, number),
      intent: await this.linkedIntent(repo, pr.body),
    });

    const leaseLost = await this.runTurnUnderLease(worker, claim, message, { profile: "review", repo });
    if (leaseLost) {
      this.log("info", "mesh job lease lost", { agent: worker.agent, claimId: claim.id });
      return "lease-lost";
    }

    const evidence = findReview(await this.options.github.reviews(repo, number), worker.agent, headSha, claimedAt);
    return evidence ? { outcome: "done", evidenceRef: evidence.url } : { outcome: "failed" };
  }

  /**
   * An intent-review job: one independent reviewer reads the issue and records the decision only through the
   * workflow-owned approval checkbox. Evidence is that checkbox comment being ticked at or after the claim; the
   * orca workflow then applies `orca:approved` and the issue dispatcher starts the work.
   */
  private async runIntentReview(worker: Worker, claim: MeshClaim, job: MeshJob, claimedAt: number): Promise<MeshJobReport | "lease-lost"> {
    const { repo, kind, number } = job.target;
    if (job.type !== "review-intent" || kind !== "issue") {
      this.log("info", "mesh job not runnable here", { agent: worker.agent, claimId: claim.id, type: job.type });
      return { outcome: "failed" };
    }
    const issueState = this.options.github.issueState;
    const reviewer = this.options.intentReviewers?.find((entry) => entry.agent === worker.agent);
    if (!issueState || !reviewer) {
      this.log("info", "intent review not available here", { agent: worker.agent, claimId: claim.id });
      return { outcome: "failed" };
    }

    const before = await issueState.call(this.options.github, repo, number);
    const issueUrl = `https://github.com/${repo}/issues/${number}`;
    const approvalLabel = this.options.approvalLabel ?? "orca:approved";
    if (before.labels.includes(approvalLabel)) return { outcome: "done", evidenceRef: issueUrl };
    // Fail closed: an issue with no author cannot prove four-eyes, and a reviewer may never approve its own intent.
    if (!before.authorLogin) {
      this.log("info", "intent review refused: the issue has no author login", {
        agent: worker.agent, claimId: claim.id, repo, issue: number,
      });
      return { outcome: "failed" };
    }
    if (before.authorLogin.toLowerCase() === reviewer.login.toLowerCase()) {
      this.log("info", "intent review refused: the reviewer authored the intent", {
        agent: worker.agent, claimId: claim.id, repo, issue: number,
      });
      return { outcome: "failed" };
    }

    const message = buildIntentReviewMessage({
      agent: worker.agent, repo, issue: number, title: before.title, body: before.body, labels: before.labels,
    });
    // One verdict per review turn (#300): the turn's process refuses a second comment or approval on this issue.
    const leaseLost = await this.runTurnUnderLease(worker, claim, message, { intent: { repo, issue: number, revision: intentRevision(before.title, before.body) } });
    if (leaseLost) return "lease-lost";

    const after = await issueState.call(this.options.github, repo, number);
    const since = Math.floor(claimedAt / 1000) * 1000;
    // The button is the workflow's own comment; a lookalike comment from anyone else is not evidence.
    const button = after.comments.find((comment) =>
      comment.body.includes("<!-- orca-approve -->") && isWorkflowBot(comment.author));
    const ticked = Boolean(button)
      && /- \[x\] Approve/i.test(button!.body)
      && Date.parse(button!.updatedAt) >= since;
    // Only the workflow's label is authority; comments can be forged by anyone with write access.
    const approvedByWorkflow = after.labels.includes(approvalLabel);
    if (!ticked || !approvedByWorkflow) {
      this.log("info", "intent review did not record an approval", {
        agent: worker.agent, claimId: claim.id, repo, issue: number, ticked, approvedByWorkflow,
      });
      return { outcome: "failed" };
    }
    return { outcome: "done", evidenceRef: button!.url };
  }

  /** Runs the turn with heartbeats and a timeout. Returns true when the lease was lost. */
  private async runTurnUnderLease(worker: Worker, claim: MeshClaim, message: string, extra?: { profile: "review"; repo: string } | { intent: IntentTarget }): Promise<boolean> {
    const controller = new AbortController();
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      worker.jobs.heartbeat(claim.id).catch((error) => {
        if (error instanceof LeaseLostError) {
          leaseLost = true;
          controller.abort();
        } else {
          this.log("error", "mesh job heartbeat failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
        }
      });
    }, this.options.heartbeatMs);
    const timeout = setTimeout(() => {
      this.log("info", "mesh job turn timed out", { agent: worker.agent, claimId: claim.id });
      controller.abort();
    }, this.options.turnTimeoutMs);
    try {
      await this.options.runTurn({
        agent: worker.agent, message, signal: controller.signal,
        ...extra,
        ...(worker.provider && worker.model ? { provider: worker.provider, model: worker.model } : {}),
      });
    } catch (error) {
      // The turn's own failure decides nothing: the evidence check on GitHub does.
      this.log("error", "mesh job turn failed", { agent: worker.agent, claimId: claim.id, error: errorText(error) });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
    return leaseLost;
  }

  private async linkedIntent(repo: string, body: string): Promise<{ number: number; title: string; body: string } | null> {
    const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body ?? "");
    if (!match) return null;
    const number = Number(match[1]);
    try {
      return { number, ...(await this.options.github.issue(repo, number)) };
    } catch {
      return null;
    }
  }
}

/** The Orca workflow posts its button and audit comments as this exact bot login. */
function isWorkflowBot(login: string): boolean {
  return login.toLowerCase() === "github-actions[bot]";
}

/** A head prefix shorter than 7 characters is too ambiguous to match anything. */
function sameHead(full: string, prefix: string): boolean {
  return prefix.length >= 7 && full.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * A review on the job's head, signed by the agent, submitted at or after the
 * claim (GitHub has 1 s precision). Signed means a first line `Reviewer: <agent>`
 * (the request-review prompt) or a line of its own `Agent: <agent>` (the colony
 * trailer convention). Agents review through GitHub Apps, so a review submitted
 * by a person is never evidence, even with a signature line.
 */
export function findReview(reviews: PullRequestReview[], agent: string, headSha: string, claimedAt: number): PullRequestReview | null {
  const since = Math.floor(claimedAt / 1000) * 1000;
  const name = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reviewerLine = new RegExp(`^\\s*Reviewer:\\s*${name}\\b`, "i");
  const agentTrailer = new RegExp(`^Agent:\\s*${name}\\s*$`, "im");
  return reviews.find((review) =>
    review.authorType === "Bot"
    && sameHead(review.commitId, headSha)
    && (reviewerLine.test(review.body) || agentTrailer.test(review.body))
    && Date.parse(review.submittedAt) >= since,
  ) ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
