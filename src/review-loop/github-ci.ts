import type { ReviewGitHubGet } from "./branch-snapshot";
import type { ReviewCiBinding } from "./ci-snapshot";
import { createReviewHttpSession, ReviewHttpError, validReviewBranch, type ReviewHttpDependencies } from "./http-session";

const ORIGIN = "https://api.github.com";
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const id = (v: string) => /^[1-9]\d{0,15}$/.test(v) && Number.isSafeInteger(Number(v));
const page = (v: string) => /^(?:[1-9]|10)$/.test(v);

/** Unwired repository-scoped CI reads. Numeric run/suite membership is proved by the collector, not this factory. */
export function createReviewGitHubCiGet(repo: string, number: number, binding: ReviewCiBinding,
  deps: ReviewHttpDependencies): ReviewGitHubGet {
  if (typeof repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || !Number.isSafeInteger(number) || number <= 0 || number > 2147483647
    || !binding || typeof binding !== "object" || Array.isArray(binding)
    || !sha(binding.headSha) || !sha(binding.baseSha) || typeof binding.baseBranch !== "string"
    || !validReviewBranch(binding.baseBranch)) throw new ReviewHttpError("config");
  const root = `/repos/${repo}`, { headSha, baseSha, baseBranch } = binding;
  const fixed = new Set([`${root}/pulls/${number}`, `${root}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    `${root}/git/trees/${baseSha}?recursive=1`]);
  const paged = [`${root}/actions/runs?head_sha=${headSha}&per_page=100&page=`,
    `${root}/commits/${headSha}/check-suites?per_page=100&page=`,
    `${root}/commits/${headSha}/status?per_page=100&page=`];
  function allowed(path: unknown): path is string {
    if (typeof path !== "string") return false;
    try {
      const url = new URL(path, ORIGIN);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname + url.search !== path) return false;
      if (fixed.has(path)) return true;
      if (paged.some(prefix => path.startsWith(prefix) && page(path.slice(prefix.length)))) return true;
      const suitePrefix = `${root}/check-suites/`, runPrefix = `${root}/actions/runs/`;
      if (path.startsWith(suitePrefix)) {
        const match = /^([1-9]\d{0,15})\/check-runs\?filter=all&per_page=100&page=([1-9]|10)$/.exec(path.slice(suitePrefix.length));
        return !!match && id(match[1]!);
      }
      if (path.startsWith(runPrefix)) {
        const match = /^([1-9]\d{0,15})\/attempts\/([1-5])\/jobs\?per_page=100&page=([1-9]|10)$/.exec(path.slice(runPrefix.length));
        return !!match && id(match[1]!);
      }
      return false;
    } catch { return false; }
  }
  return createReviewHttpSession<string>(deps, { requests: 200,
    prepare: path => allowed(path) ? { path, method: "GET" } : undefined });
}
