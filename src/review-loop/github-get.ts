import type { ReviewGitHubGet } from "./branch-snapshot";
import { createReviewHttpSession, ReviewHttpError, validReviewBranch, type ReviewHttpDependencies } from "./http-session";
export { ReviewHttpError } from "./http-session";
const ORIGIN = "https://api.github.com";
function allowed(path: unknown, root: string, pr: string): path is string {
  if (typeof path !== "string") return false;
  try {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname + url.search !== path) return false;
    if (path === pr) return true;
    for (const kind of ["files", "commits"]) {
      const prefix = `${pr}/${kind}?per_page=100&page=`;
      if (path.startsWith(prefix)) return /^(?:[1-9]|[12][0-9]|30)$/.test(path.slice(prefix.length));
    }
    const prefix = `${root}/git/ref/heads/`;
    if (!path.startsWith(prefix)) return false;
    const encoded = path.slice(prefix.length), decoded = decodeURIComponent(encoded);
    return encodeURIComponent(decoded) === encoded && validReviewBranch(decoded);
  } catch { return false; }
}
/** One sequential, poison-on-failure collection session. No tool registration, key reads, minting or retries. */
export function createReviewGitHubGet(repo: string, number: number, deps: ReviewHttpDependencies): ReviewGitHubGet {
  if (typeof repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || !Number.isSafeInteger(number) || number <= 0) throw new ReviewHttpError("config");
  const root = `/repos/${repo}`, pr = `${root}/pulls/${number}`;
  return createReviewHttpSession<string>(deps, { requests: 40,
    prepare: path => allowed(path, root, pr) ? { path, method: "GET" } : undefined });
}
