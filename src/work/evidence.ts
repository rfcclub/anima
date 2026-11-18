/**
 * What counts as evidence for a work (anima #135, WL-4 and WL-5). GitHub is the source: nothing the model
 * says, and no URL it reports, is trusted until these checks pass against what the host read itself.
 */

import type { WorkRecord } from "./store";

export interface PullRequestInfo {
  repo: string;
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  body: string;
  authorLogin: string;
  /** GitHub's draft flag; absent means the adapter does not report it. */
  draft?: boolean;
  /** GitHub's mergeable flag; absent or null means unknown. */
  mergeable?: boolean | null;
}

export interface CheckInfo {
  name: string;
  state: string;
}

/** Green only when GitHub reported at least one successful check and every check is a pass-like conclusion. */
export function checksGreen(checks: CheckInfo[]): boolean {
  if (checks.length === 0) return false;
  if (!checks.some((check) => check.state.toUpperCase() === "SUCCESS")) return false;
  return checks.every((check) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state.toUpperCase()));
}

export interface ReviewInfo {
  id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commitId: string;
  authorLogin: string;
  authorType: string;
  url: string;
  submittedAt: string;
  /** The review text; used as the brief for a revise session. */
  body?: string;
}

export interface ReviewCommentInfo {
  reviewId: number;
  commitId: string;
  authorLogin: string;
  path: string;
  line: number | null;
  body: string;
}

/** Read-only GitHub access for the reconciler; the merge methods are optional so a read-only adapter stays valid. */
export interface WorkGitHub {
  findPullRequest(repo: string, headBranch: string): Promise<PullRequestInfo | null>;
  pullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  reviews(repo: string, number: number): Promise<ReviewInfo[]>;
  /** Inline comments on submitted PR reviews, with their review and commit IDs. */
  reviewComments?(repo: string, number: number): Promise<ReviewCommentInfo[]>;
  /** Checks reported on the current head; absent means the adapter cannot read them (auto-merge stays off). */
  checks?(repo: string, number: number): Promise<CheckInfo[]>;
  /** Unresolved review threads; absent means the adapter cannot read them (auto-merge stays off). */
  unresolvedThreads?(repo: string, number: number): Promise<number>;
  /** Merge the pull request, refusing a head that moved; absent means the adapter cannot merge. */
  merge?(repo: string, number: number, head: string): Promise<void>;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const LINK = /(?:closes|fixes|resolves)\s+#(\d+)/gi;

/** The pull request is this work's: same repository, expected base, the work branch, the approved issue, the pinned author. */
export function verifyPullRequest(work: WorkRecord, pr: PullRequestInfo, expect: { base: string; authorActor: string }): Verdict {
  if (pr.repo.toLowerCase() !== work.repo.toLowerCase()) return { ok: false, reason: `pull request is in ${pr.repo}, not ${work.repo}` };
  if (pr.state !== "open" && !pr.merged) return { ok: false, reason: `pull request #${pr.number} is ${pr.state}` };
  if (pr.baseRef !== expect.base) return { ok: false, reason: `pull request base is ${pr.baseRef}, expected ${expect.base}` };
  if (pr.headRef !== work.branch) return { ok: false, reason: `pull request head is ${pr.headRef}, expected ${work.branch}` };
  const linked = [...(pr.body ?? "").matchAll(LINK)].map((m) => Number(m[1]));
  if (!linked.includes(work.issue)) return { ok: false, reason: `pull request does not link the approved issue #${work.issue}` };
  if (pr.authorLogin.toLowerCase() !== expect.authorActor.toLowerCase()) return { ok: false, reason: `pull request author is ${pr.authorLogin}, expected ${expect.authorActor}` };
  return { ok: true };
}

export interface ReviewContext {
  head: string;
  authorActor: string;
  /** GitHub logins allowed to count as independent reviewers. */
  reviewerLogins: string[];
}

export interface ReviewReading {
  /** Independent reviewers whose latest review of this head is changes-requested. */
  standingChanges: ReviewInfo[];
  /** Independent reviewers whose latest review of this head is an approval. */
  approvals: ReviewInfo[];
  /** Reviews of other heads: history, never acted on. */
  stale: ReviewInfo[];
}

/** Latest review per independent reviewer on the current head decides; other heads are history. */
export function readReviews(reviews: ReviewInfo[], ctx: ReviewContext): ReviewReading {
  const allowed = new Set(ctx.reviewerLogins.map((login) => login.toLowerCase()));
  const author = ctx.authorActor.toLowerCase();
  const stale: ReviewInfo[] = [];
  const latest = new Map<string, ReviewInfo>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.authorLogin.toLowerCase();
    if (login === author || !allowed.has(login)) continue;
    if (!sameHead(review.commitId, ctx.head)) { stale.push(review); continue; }
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(login, review);
  }
  const standing = [...latest.values()];
  return {
    standingChanges: standing.filter((r) => r.state === "CHANGES_REQUESTED"),
    approvals: standing.filter((r) => r.state === "APPROVED"),
    stale,
  };
}

function sameHead(full: string, other: string): boolean {
  return full.toLowerCase() === other.toLowerCase();
}

/**
 * Any non-author review on the current head whose latest state is CHANGES_REQUESTED, including reviewers outside
 * the configured reviewer set (an external review bot or a human). Such a standing request blocks a merge even
 * when an independent configured reviewer approved.
 */
export function anyCurrentChangeRequest(
  reviews: ReviewInfo[], ctx: { head: string; authorActor: string },
): ReviewInfo | null {
  const author = ctx.authorActor.toLowerCase();
  const latest = new Map<string, ReviewInfo>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.authorLogin.toLowerCase();
    if (login === author) continue;
    if (!sameHead(review.commitId, ctx.head)) continue;
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(login, review);
  }
  return [...latest.values()].find((review) => review.state === "CHANGES_REQUESTED") ?? null;
}

export type Acceptance =
  | { kind: "open" }
  | { kind: "accepted"; approvals: ReviewInfo[] }
  | { kind: "blocked"; reason: string };

/**
 * Acceptance needs a merged pull request and, for the merged head, at least one approval by an independent
 * reviewer and no independent changes-requested review standing. A merge without that is flagged for
 * reconciliation, never accepted; a pull request closed without a merge blocks the work.
 */
export function decideAcceptance(pr: PullRequestInfo, reviews: ReviewInfo[], ctx: ReviewContext): Acceptance {
  if (pr.merged) {
    const reading = readReviews(reviews, ctx);
    if (reading.approvals.length >= 1 && reading.standingChanges.length === 0) return { kind: "accepted", approvals: reading.approvals };
    const why = reading.standingChanges.length > 0
      ? "merged while an independent review still asked for changes"
      : "merged without an independent approval of the merged head";
    return { kind: "blocked", reason: `${why}: needs reconciliation` };
  }
  if (pr.state === "closed") return { kind: "blocked", reason: `pull request #${pr.number} closed without merge` };
  return { kind: "open" };
}
