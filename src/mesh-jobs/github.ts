import type { GitHubReader, PullRequestReview } from "./consumer";

/** Runs `gh <args>` and returns stdout; throws on a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

/** Read-only GitHub access through the `gh` CLI (already logged in for request-review.sh). */
export function ghReader(run: GhRunner): GitHubReader {
  return {
    async pullRequest(repo, n) {
      const pr = JSON.parse(await run(["pr", "view", String(n), "--repo", repo, "--json", "headRefOid,state,mergedAt,title,body,author"])) as {
        headRefOid: string; state: unknown; mergedAt: unknown; title: string; body: string | null; author: { login: string };
      };
      if (!["OPEN", "CLOSED", "MERGED"].includes(String(pr.state)) ||
          !(pr.mergedAt === null || (typeof pr.mergedAt === "string" && pr.mergedAt.length > 0))) {
        throw new Error("GitHub pull request state or mergedAt is missing or invalid");
      }
      return {
        headSha: pr.headRefOid, state: pr.state === "OPEN" ? "open" : "closed",
        merged: pr.state === "MERGED" || pr.mergedAt !== null,
        title: pr.title, body: pr.body ?? "", author: pr.author.login,
      };
    },
    async diff(repo, n) {
      return run(["pr", "diff", String(n), "--repo", repo]);
    },
    async issue(repo, n) {
      const issue = JSON.parse(await run(["issue", "view", String(n), "--repo", repo, "--json", "title,body"])) as { title: string; body: string | null };
      return { title: issue.title, body: issue.body ?? "" };
    },
    async issueState(repo, n) {
      const issue = JSON.parse(await run(["api", `repos/${repo}/issues/${n}`])) as {
        title: string; body: string | null; labels: Array<{ name?: string }>; user?: { login?: string };
      };
      const out = await run(["api", `repos/${repo}/issues/${n}/comments?per_page=100`, "--paginate", "--jq", ".[]"]);
      const comments = out.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as {
        id: number; body: string; user?: { login?: string }; updated_at?: string; html_url?: string;
      });
      return {
        title: String(issue.title ?? ""),
        body: String(issue.body ?? ""),
        labels: (issue.labels ?? []).map((label) => String(label.name ?? "")).filter(Boolean),
        authorLogin: String(issue.user?.login ?? ""),
        comments: comments.map((comment) => ({
          id: Number(comment.id),
          body: String(comment.body ?? ""),
          author: String(comment.user?.login ?? ""),
          updatedAt: String(comment.updated_at ?? ""),
          url: String(comment.html_url ?? ""),
        })),
      };
    },
    async reviews(repo, n) {
      const out = await run([
        "api", `repos/${repo}/pulls/${n}/reviews`, "--paginate",
        "--jq", ".[] | {commitId: .commit_id, body: .body, submittedAt: .submitted_at, url: .html_url, authorType: .user.type}",
      ]);
      return out.split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Partial<PullRequestReview> & { submittedAt: string | null })
        // A pending (unsubmitted) review has no submitted_at and is not evidence.
        .filter((review): review is PullRequestReview => typeof review.submittedAt === "string" && typeof review.commitId === "string");
    },
  };
}

/** Production runner: spawns `gh` with a timeout. */
export function spawnGh(ghPath = Bun.which("gh") ?? "/opt/homebrew/bin/gh", timeoutMs = 60_000): GhRunner {
  return async (args) => {
    const proc = Bun.spawn([ghPath, ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim().slice(0, 200)}`);
    return stdout;
  };
}
