/**
 * Read-only GitHub access for the reconciler, through the `gh` CLI (anima #135). GitHub is the evidence for a
 * work: this adapter only reads, and it refuses a repository or branch that is not a plain name before it
 * builds a request from it.
 */

import type { GhRunner } from "../mesh-jobs/github";
import type { PullRequestInfo, ReviewCommentInfo, ReviewInfo, WorkGitHub } from "./evidence";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function checkRepo(repo: string): void {
  if (!REPO.test(repo)) throw new RangeError(`not a repository name: ${JSON.stringify(repo)}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // `--paginate --jq '.[]'` prints one object per line
    return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
}

/** `gh api --paginate --jq '.[]'` emits no lines, one JSON object, or multiple JSON lines. */
function parseList(text: string): any[] {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return [];
  try {
    const items = lines.map((line) => JSON.parse(line));
    return items.length === 1 && Array.isArray(items[0]) ? items[0] : items;
  } catch {
    // Preserve support for a single pretty-printed JSON document.
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}

function toPr(raw: any, repo: string): PullRequestInfo {
  return {
    repo: String(raw.base?.repo?.full_name ?? repo),
    number: Number(raw.number),
    url: String(raw.html_url),
    state: raw.state === "open" ? "open" : "closed",
    merged: raw.merged_at !== null && raw.merged_at !== undefined,
    headSha: String(raw.head?.sha ?? ""),
    headRef: String(raw.head?.ref ?? ""),
    baseRef: String(raw.base?.ref ?? ""),
    body: String(raw.body ?? ""),
    authorLogin: String(raw.user?.login ?? ""),
    ...(typeof raw.draft === "boolean" ? { draft: raw.draft } : {}),
    ...((typeof raw.mergeable === "boolean" || raw.mergeable === null) ? { mergeable: raw.mergeable } : {}),
  };
}

export function ghWorkGitHub(run: GhRunner): WorkGitHub {
  return {
    async findPullRequest(repo, headBranch) {
      checkRepo(repo);
      if (!BRANCH.test(headBranch) || headBranch.includes("..")) throw new RangeError(`not a branch name: ${JSON.stringify(headBranch)}`);
      const owner = repo.split("/")[0]!;
      const list = parseJson(await run(["api", `repos/${repo}/pulls?head=${owner}:${headBranch}&state=all&per_page=5`])) as any[];
      return list.length > 0 ? toPr(list[0], repo) : null;
    },

    async pullRequest(repo, number) {
      checkRepo(repo);
      if (!Number.isInteger(number) || number <= 0) throw new RangeError(`not a pull request number: ${number}`);
      // GitHub's REST pull object includes `mergeable` (true | false | null) by default; toPr preserves all three.
      return toPr(parseJson(await run(["api", `repos/${repo}/pulls/${number}`])), repo);
    },

    async reviews(repo, number): Promise<ReviewInfo[]> {
      checkRepo(repo);
      if (!Number.isInteger(number) || number <= 0) throw new RangeError(`not a pull request number: ${number}`);
      const out = await run(["api", `repos/${repo}/pulls/${number}/reviews?per_page=100`, "--paginate", "--jq", ".[]"]);
      const list = parseList(out);
      return list
        // a pending review has no submitted_at and is not a review yet
        .filter((r) => typeof r.submitted_at === "string" && typeof r.commit_id === "string")
        .map((r): ReviewInfo => ({
          id: Number(r.id), state: r.state, commitId: String(r.commit_id), authorLogin: String(r.user?.login ?? ""),
          authorType: String(r.user?.type ?? ""), url: String(r.html_url ?? ""), submittedAt: String(r.submitted_at), body: String(r.body ?? ""),
        }));
    },

    async reviewComments(repo, number): Promise<ReviewCommentInfo[]> {
      checkRepo(repo);
      if (!Number.isInteger(number) || number <= 0) throw new RangeError(`not a pull request number: ${number}`);
      const out = await run(["api", `repos/${repo}/pulls/${number}/comments?per_page=100`, "--paginate", "--jq", ".[]"]);
      const list = parseList(out);
      return list.filter((comment) => Number.isSafeInteger(comment.pull_request_review_id) &&
        typeof comment.commit_id === "string" && typeof comment.user?.login === "string").map((comment) => ({
        reviewId: comment.pull_request_review_id,
        commitId: comment.commit_id,
        authorLogin: comment.user.login,
        path: String(comment.path ?? ""),
        line: Number.isSafeInteger(comment.line) ? comment.line : null,
        body: String(comment.body ?? ""),
      }));
    },

    async checks(repo, number) {
      checkRepo(repo);
      if (!Number.isInteger(number) || number <= 0) throw new RangeError(`not a pull request number: ${number}`);
      const parsed = JSON.parse(await run(["pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup"])) as {
        statusCheckRollup?: Array<Record<string, unknown>>;
      };
      const list = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
      return list.map((entry) => ({
        name: String(entry.name ?? entry.context ?? entry.workflow ?? "check"),
        state: String(entry.conclusion ?? entry.state ?? entry.status ?? "UNKNOWN"),
      }));
    },

    async unresolvedThreads(repo, number) {
      checkRepo(repo);
      if (!Number.isInteger(number) || number <= 0) throw new RangeError(`not a pull request number: ${number}`);
      const [owner, name] = repo.split("/") as [string, string];
      let cursor: string | null = null;
      let unresolved = 0;
      // The merge gate fails closed; a truncated thread list must never look like zero unresolved threads.
      for (let page = 0; page < 20; page++) {
        const query = cursor
          ? "query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}"
          : "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}";
        const args = [
          "api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`,
        ];
        if (cursor) args.push("-f", `cursor=${cursor}`);
        const out = await run(args);
        const threads = (JSON.parse(out) as any)?.data?.repository?.pullRequest?.reviewThreads;
        if (!Array.isArray(threads?.nodes) || typeof threads?.pageInfo?.hasNextPage !== "boolean") {
          throw new Error("GitHub returned an incomplete review-thread snapshot");
        }
        unresolved += threads.nodes.filter((thread: { isResolved?: boolean }) => thread?.isResolved !== true).length;
        if (!threads.pageInfo.hasNextPage) return unresolved;
        cursor = String(threads.pageInfo.endCursor ?? "");
        if (!cursor) throw new Error("GitHub returned an incomplete review-thread page cursor");
      }
      throw new Error("review threads exceeded the pagination cap; refusing to guess the unresolved count");
    },

    async merge(repo, number, head) {
      checkRepo(repo);
      if (!Number.isInteger(number) || number <= 0) throw new RangeError(`not a pull request number: ${number}`);
      if (!/^[0-9a-f]{40}$/i.test(head)) throw new RangeError(`not a commit SHA: ${JSON.stringify(head)}`);
      // The repository decides the strategy; a hardcoded --merge fails forever on a squash-only repository.
      const caps = JSON.parse(await run(["api", `repos/${repo}`])) as {
        allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean;
      };
      const method = caps.allow_merge_commit ? "--merge"
        : caps.allow_squash_merge ? "--squash"
        : caps.allow_rebase_merge ? "--rebase"
        : null;
      if (!method) throw new Error(`${repo} allows no merge strategy`);
      await run(["pr", "merge", String(number), "--repo", repo, method, "--match-head-commit", head]);
    },
  };
}
