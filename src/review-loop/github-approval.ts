import type { ApprovalPorts, ApprovalRequest } from "./approval-receipt";
import { createReviewGitHubGet } from "./github-get";
import { createReviewHttpSession, ReviewHttpError, validReviewBranch, type ReviewHttpDependencies } from "./http-session";

type Fields = Record<string, unknown>;
interface Binding { headSha: string; baseSha: string; baseBranch: string; authorLogin: string }
const object = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
function fixed(repo: string, number: number): void {
  if (typeof repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || !Number.isSafeInteger(number) || number <= 0) throw new ReviewHttpError("config");
}

/** One native POST, never retried. Caller supplies trusted fetch/credential; no issuer or tool registration. */
export function createReviewGitHubApprovalPost(repo: string, number: number, headSha: string,
  deps: ReviewHttpDependencies): ApprovalPorts["submitApproval"] {
  fixed(repo, number);
  if (!sha(headSha)) throw new ReviewHttpError("config");
  const post = createReviewHttpSession<ApprovalRequest>(deps, { requests: 1, prepare(input) {
    if (!object(input)) return;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 5 || !keys.every(key => typeof key === "string"
      && ["repo", "number", "event", "commit_id", "body"].includes(key))) return;
    const value = { repo: input.repo, number: input.number, event: input.event, commit_id: input.commit_id, body: input.body };
    if (value.repo !== repo || value.number !== number || value.event !== "APPROVE" || value.commit_id !== headSha
      || typeof value.body !== "string" || value.body.length > 65_536) return;
    return { method: "POST", path: `/repos/${repo}/pulls/${number}/reviews`,
      body: JSON.stringify({ event: value.event, commit_id: value.commit_id, body: value.body }) };
  } });
  return async (request, signal) => {
    try { return { status: 200, review: await post(request, signal) }; }
    catch (error) {
      // Only the engine's observed response status is definitive. Fetch-thrown errors are wrapped by the engine.
      if (error instanceof ReviewHttpError && error.status !== undefined
        && error.status >= 400 && error.status < 500 && error.status !== 408) return { status: error.status };
      throw error;
    }
  };
}

/** Fresh GET session per anchor, including its own deadline. Matching observations do not exclude ABA. */
export function createReviewGitHubApprovalAnchor(repo: string, number: number, binding: Binding,
  deps: ReviewHttpDependencies): ApprovalPorts["readAnchor"] {
  fixed(repo, number);
  if (!object(binding)) throw new ReviewHttpError("config");
  const { headSha, baseSha, baseBranch, authorLogin } = binding;
  if (!sha(headSha) || !sha(baseSha) || typeof baseBranch !== "string" || !validReviewBranch(baseBranch)
    || typeof authorLogin !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}\[bot\]$/i.test(authorLogin)) {
    throw new ReviewHttpError("config");
  }
  const root = `/repos/${repo}`;
  return async signal => {
    const get = createReviewGitHubGet(repo, number, deps);
    const p = await get(`${root}/pulls/${number}`, signal);
    if (!object(p) || p.number !== number || p.state !== "open" || p.draft !== false
      || !object(p.base) || !object(p.base.repo) || p.base.repo.full_name !== repo
      || p.base.ref !== baseBranch || p.base.sha !== baseSha
      || !object(p.head) || !object(p.head.repo) || p.head.repo.full_name !== repo || p.head.sha !== headSha
      || !object(p.user) || p.user.type !== "Bot" || p.user.login !== authorLogin) throw new ReviewHttpError("http_response");
    const r = await get(`${root}/git/ref/heads/${encodeURIComponent(baseBranch)}`, signal);
    if (!object(r) || r.ref !== `refs/heads/${baseBranch}` || !object(r.object)
      || r.object.type !== "commit" || r.object.sha !== baseSha) throw new ReviewHttpError("http_response");
    return { repo: p.base.repo.full_name, number: p.number, headSha: p.head.sha, baseSha: p.base.sha,
      baseBranch: p.base.ref, authorLogin: p.user.login, state: "OPEN", draft: p.draft, liveBaseSha: r.object.sha };
  };
}
