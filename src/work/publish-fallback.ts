/**
 * Host-side publish fallback for the work loop.
 *
 * A work session is supposed to call the `publish` tool itself. Some models commit the change and then never
 * call it, so the work blocks with committed-but-unpublished work. After a session ends, the host checks the
 * work tree: if it is clean and has a commit that is not published (a new head for a revise, or a branch ahead
 * of base for a start-work), the host pushes the branch and, for a start-work, opens the pull request with the
 * author's identity. The reviewer gate is unchanged; this only performs the mechanical publish the model skipped.
 */

import type { StopCause } from "./consumer";
import { baseForRepo } from "./config";
import { gitWithGeneratedExcludes } from "./generated-excludes";
import type { Publisher } from "./publish";
import type { HostRunResult } from "./publish-run";
import type { WorkRecord } from "./store";

export interface PublishFallbackDeps {
  publish: Publisher;
  findPullRequest: (repo: string, branch: string) => Promise<{ number: number } | null>;
  issue: (repo: string, number: number) => Promise<{ title: string; body: string }>;
  /** The base branch used when the repository has no entry in `repoBases`. */
  base: string;
  /** Per-repository base branches (anima #372); a repository without an entry uses `base`. */
  repoBases?: Record<string, string>;
  /** Runs git in the work tree and returns stdout; must throw on a non-zero exit. */
  git: (cwd: string, args: string[]) => string;
  /** Apply the low worker's host-owned generated-file exclusions when checking cleanliness. */
  excludeGenerated?: boolean;
  /**
   * Publishes an uncommitted tree: the host judges it, commits it from its own repository and opens a draft pull
   * request (publish-host.ts). Absent means a dirty tree is declined, as before. Only a limit-terminal start-work
   * session in `deadline` or `max_reached` may use it.
   */
  hostPublish?: (input: {
    work: WorkRecord;
    stopCause: "deadline" | "max_reached";
    issue: { title: string; body: string };
    guard: () => Promise<void>;
  }) => Promise<HostRunResult>;
}

export interface PublishFallbackInput {
  work: WorkRecord;
  kind: "start-work" | "revise";
  stopCause: StopCause;
  /** The session ended the work at its time or session limit (a start-work job only). */
  limitTerminal?: boolean;
  /** Throws when this session no longer holds the work's lease or current generation; run before every write. */
  guard?: () => void;
  /**
   * The same check after the pending lease heartbeat has been answered; awaited right before every outbound write.
   * A client-side check cannot make lease ownership and a remote write atomic: a lease lost after this check and
   * before the write lands is not visible from here.
   */
  settledGuard?: () => Promise<void>;
}

export interface PublishFallbackResult {
  published: boolean;
  reason?: string;
  /** Set when the host itself committed and published: the commit, the tool output and the checks that ran. */
  host?: { sha: string; prOutput: string; checks: string[] };
  /** Set when the host pushed the branch but a pull request may not exist (SC-027). */
  hostPushed?: boolean;
  /** The host commit on the remote when `hostPushed` is true. */
  hostSha?: string;
}

/** SC-006: the tree was left uncommitted at the limit; the host judges, commits, pushes and opens the draft pull request. */
async function publishFromHost(deps: PublishFallbackDeps, input: PublishFallbackInput): Promise<PublishFallbackResult> {
  const { work } = input;
  const guard = input.guard ?? (() => {});
  // The model may already have opened the pull request (SC-025): leave it to the normal flow, never open a second one.
  if (await deps.findPullRequest(work.repo, work.branch)) return { published: false, reason: "pull request already exists" };
  const issue = await deps.issue(work.repo, work.issue);
  const result = await deps.hostPublish!({
    work,
    stopCause: input.stopCause as "deadline" | "max_reached",
    issue,
    guard: async () => { if (input.settledGuard) await input.settledGuard(); guard(); },
  });
  if (result.published) return { published: true, host: { sha: result.sha, prOutput: result.prOutput, checks: result.checks } };
  // A pushed branch without a pull request is one recorded state, whether the pull request call failed or threw.
  if (result.pushed) {
    return { published: false, reason: "pr-create-failed (branch pushed)", hostPushed: true, ...(result.sha ? { hostSha: result.sha } : {}) };
  }
  return { published: false, reason: result.reason };
}

function isOk(out: string): boolean {
  try {
    return (JSON.parse(out) as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

/**
 * Only a clean tree can be published: uncommitted work is not the host's to guess at. The commit that is checked
 * is the one the push stages (`refs/heads/<work.branch>`), and HEAD must be on that branch. The base ref is read
 * from the author's git directory, so an author who moves it only causes a skipped publish (a false negative).
 */
export async function publishCommittedWork(
  deps: PublishFallbackDeps, input: PublishFallbackInput,
): Promise<PublishFallbackResult> {
  const { work, kind } = input;
  const guard = input.guard ?? (() => {});
  const beforeWrite = async () => { if (input.settledGuard) await input.settledGuard(); guard(); };
  const tree = `${work.root}/tree`;
  const statusArgs = ["status", "--porcelain", "--untracked-files=all"];
  const status = deps.excludeGenerated
    ? gitWithGeneratedExcludes(deps.git, tree, statusArgs)
    : deps.git(tree, statusArgs);
  if (status.trim() !== "") {
    const hostMayPublish = deps.hostPublish && input.limitTerminal === true && kind === "start-work" &&
      (input.stopCause === "deadline" || input.stopCause === "max_reached");
    if (!hostMayPublish) return { published: false, reason: "working tree is not clean" };
    return publishFromHost(deps, input);
  }

  const ref = `refs/heads/${work.branch}`;
  let onBranch: string;
  try {
    onBranch = deps.git(tree, ["symbolic-ref", "-q", "HEAD"]).trim();
  } catch {
    return { published: false, reason: "HEAD is detached, not on the work branch" };
  }
  if (onBranch !== ref) return { published: false, reason: "HEAD is not on the work branch" };

  const head = deps.git(tree, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) return { published: false, reason: "work branch is not a commit SHA" };

  if (kind === "revise") {
    if (!work.prHead || head.toLowerCase() === work.prHead.toLowerCase()) {
      return { published: false, reason: "no new commit since the reviewed head" };
    }
  } else {
    // A PR may already exist (the agent pushed/opened it but evidence was not collected yet): leave it to the
    // normal flow, which collects the evidence, instead of creating a second one.
    if (await deps.findPullRequest(work.repo, work.branch)) {
      return { published: false, reason: "pull request already exists" };
    }
    const base = baseForRepo(deps.repoBases, deps.base, work.repo);
    const ahead = Number(deps.git(tree, ["rev-list", "--count", ref, "--not", base]).trim());
    if (!Number.isInteger(ahead) || ahead <= 0) return { published: false, reason: "no commit ahead of base" };
  }

  await beforeWrite();
  const pushOut = await deps.publish(work, { action: "push" }, beforeWrite);
  if (!isOk(pushOut)) return { published: false, reason: `push failed: ${pushOut.slice(0, 300)}` };

  if (kind === "start-work") {
    const issue = await deps.issue(work.repo, work.issue);
    const title = issue.title.trim().slice(0, 200) || `Work for issue #${work.issue}`;
    const body = `Closes #${work.issue}\n\nAutomated publish fallback: the session committed the change but did not call publish.`;
    await beforeWrite();
    const prOut = await deps.publish(work, { action: "open_pr", title, body }, beforeWrite);
    if (!isOk(prOut)) return { published: false, reason: `open_pr failed: ${prOut.slice(0, 300)}` };
  }
  return { published: true };
}
