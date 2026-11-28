import { join } from "node:path";
import { issueDigest12 } from "./approval";
import { baseForRepo } from "./config";
import { readReviews, verifyPullRequest, type WorkGitHub } from "./evidence";
import { verifyRecoveryTree } from "./recovery-tree";
import type { WorkStore } from "./store";
import type { TreeRead } from "./stops";
import { acquireWorkLock } from "./supervisor";
import type { MeshJobsWorkConfig } from "../mesh-jobs/config";

export interface RetryRevisionInput {
  workId: string;
  head: string;
  failedJobId: string;
  reviewers: string[];
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/i;

/** Request, but do not directly dispatch, a revision retry after explicit recovery. */
export async function requestRevisionRetry(deps: {
  store: WorkStore;
  read: TreeRead;
  github: WorkGitHub;
  issue: (repo: string, number: number) => Promise<{ title: string; body: string }>;
  config: Pick<MeshJobsWorkConfig, "author" | "extraAuthors" | "authorActor" | "authorMeshId" | "base" | "repoBases" | "reviewers">;
}, input: RetryRevisionInput): Promise<{ key: string; inserted: boolean }> {
  if (!FULL_SHA.test(input.head)) throw new Error("retry requires the full PR head SHA");
  if (!UUID.test(input.failedJobId)) throw new Error("retry requires the failed Mesh job UUID");
  if (input.reviewers.length > 10 || input.reviewers.some((login) => !LOGIN.test(login))) {
    throw new Error("retry reviewers must be valid GitHub logins (at most 10)");
  }
  const head = input.head.toLowerCase();
  const reviewers = [...new Set(input.reviewers.map((login) => login.toLowerCase()))].sort();
  if (reviewers.length !== input.reviewers.length) throw new Error("retry reviewer was specified more than once");
  const initial = deps.store.getWork(input.workId);
  if (!initial) throw new Error(`work ${input.workId} not found`);
  if (initial.state !== "checkpointed" || ![deps.config.author, ...(deps.config.extraAuthors ?? []).map((extra) => extra.agent)].includes(initial.author) || initial.prNumber === null ||
      initial.prHead?.toLowerCase() !== head) {
    throw new Error("retry refused: recovered work, author or recorded PR head does not match");
  }
  const lock = acquireWorkLock(initial.root);
  if (!lock) throw new Error("retry refused: another supervisor holds the work lock");
  try {
    const work = deps.store.getWork(initial.workId);
    if (!work || work.state !== "checkpointed" || work.root !== initial.root || work.generation !== initial.generation ||
        work.prNumber !== initial.prNumber || work.prHead?.toLowerCase() !== head) {
      throw new Error("retry refused: work or recorded PR head changed");
    }
    const session = deps.store.latestEndedSession(work.workId);
    const stop = session && deps.store.getStop(session.sessionId);
    if (!session || !stop || !stop.trusted || stop.cessation !== "proven" || stop.interrupted ||
        stop.head.toLowerCase() !== head || stop.status.trim() !== "") {
      throw new Error("retry refused: no matching trusted stopped checkpoint");
    }
    const tree = join(work.root, "tree");
    try {
      const actualHead = deps.read(tree, ["rev-parse", "HEAD"]).trim().toLowerCase();
      const branch = `refs/heads/${work.branch}`;
      if (actualHead !== head || deps.read(tree, ["symbolic-ref", "--quiet", "HEAD"]).trim() !== branch ||
          deps.read(tree, ["rev-parse", "--verify", `${branch}^{commit}`]).trim().toLowerCase() !== head) {
        throw new Error("head or work branch differs from checkpoint");
      }
      verifyRecoveryTree(tree, head, deps.read);
    } catch {
      throw new Error("retry refused: work tree, branch or checkpoint contents cannot be verified");
    }
    const issue = await deps.issue(work.repo, work.issue);
    if (issueDigest12(issue.body) !== work.approvedDigest.slice(0, 12)) {
      throw new Error("retry refused: issue approval digest changed");
    }
    const pr = await deps.github.pullRequest(work.repo, work.prNumber!);
    const verdict = verifyPullRequest(work, pr, { base: baseForRepo(deps.config.repoBases, deps.config.base, work.repo), authorActor: deps.config.authorActor });
    if (!verdict.ok || pr.number !== work.prNumber || pr.state !== "open" || pr.merged || pr.headSha.toLowerCase() !== head) {
      throw new Error("retry refused: pull request provenance or head changed");
    }
    const reading = readReviews(await deps.github.reviews(work.repo, pr.number), {
      head, authorActor: deps.config.authorActor,
      reviewerLogins: [...deps.config.reviewers.map((reviewer) => reviewer.login), ...reviewers],
    });
    const standing = new Set(reading.standingChanges.map((review) => review.authorLogin.toLowerCase()));
    if (standing.size === 0 || reviewers.some((reviewer) => !standing.has(reviewer))) {
      throw new Error("retry refused: requested reviewer has no standing change request on this head");
    }
    const recovery = deps.store.listEvents(work.workId).filter((event) => event.kind === "operator-recovery").at(-1);
    if (!recovery) throw new Error("retry refused: no operator recovery recorded");
    return deps.store.enqueueRecoveredRevision({
      workId: work.workId, root: work.root, generation: work.generation, number: pr.number, head,
      recoverySeq: recovery.seq, failedJobId: input.failedJobId.toLowerCase(), reviewers,
    });
  } finally {
    lock.release();
  }
}

export function parseRetryRevisionArgs(args: string[]): RetryRevisionInput {
  if (args[0] !== "retry-revise" || !args[1] || args[1].startsWith("-")) {
    throw new Error("usage: anima work retry-revise <workId> --job <failed-job-id> --head <full-sha> [--reviewer <login> ...]");
  }
  let failedJobId: string | undefined;
  let head: string | undefined;
  const reviewers: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith("-")) throw new Error(`retry option ${flag} needs a value`);
    if (flag === "--job") {
      if (failedJobId) throw new Error("duplicate --job");
      failedJobId = value;
    } else if (flag === "--head") {
      if (head) throw new Error("duplicate --head");
      head = value;
    } else if (flag === "--reviewer") reviewers.push(value);
    else throw new Error(`unknown retry option ${flag}`);
  }
  if (!failedJobId || !head) throw new Error("retry requires --job <failed-job-id> and --head <full-sha>");
  if (!FULL_SHA.test(head)) throw new Error("retry requires the full 40-character PR head SHA");
  return { workId: args[1], failedJobId, head, reviewers };
}
