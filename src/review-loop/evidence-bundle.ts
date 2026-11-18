import { collectReviewBranch, type ReviewBranchSnapshot } from "./branch-snapshot";
import { collectReviewDiscussion, type ReviewDiscussionResult } from "./discussion";
import { collectReviewCi, type ReviewCiSnapshot } from "./ci-snapshot";
import { createReviewGitHubGet } from "./github-get";
import { createReviewGitHubDiscussion } from "./github-graphql";
import { createReviewGitHubCiGet } from "./github-ci";
import { createReviewGitHubApprovalAnchor } from "./github-approval";
import { ReviewHttpError, type ReviewHttpDependencies } from "./http-session";

interface Subject { repo: string; number: number; authorLogin: string }
interface Binding extends Subject { headSha: string; baseSha: string; baseBranch: string }
type DiscussionSnapshot = Extract<ReviewDiscussionResult, { ok: true }>["snapshot"];
interface Options { signal?: AbortSignal; timeoutMs?: number; requests?: number }
type Stage = "config" | "branch" | "pre_anchor" | "discussion" | "ci" | "final_anchor";
type Transport = Pick<ReviewHttpError, "code" | "status" | "retryAfterSeconds">;
export type ReviewEvidenceResult = {
  ok: true; binding: Binding;
  observations: { branch: ReviewBranchSnapshot; discussion: DiscussionSnapshot; ci: ReviewCiSnapshot };
  candidate: null; automaticMerge: false; unproven: string[]; requests: number; elapsedMs: number;
} | { ok: false; stage: Stage; reason: string; collection?: string; transport?: Transport; requests: number; elapsedMs: number };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Read-side composition only. Matching, time-separated observations prove neither ABA absence nor authority.
 * Caller owns the expected App login, injected native fetch and credential custody. No defaults access ambient state.
 */
export async function collectReviewEvidence(
  input: unknown, dependencies: ReviewHttpDependencies, options: Options = {},
): Promise<ReviewEvidenceResult> {
  const started = performance.now();
  let stage: Stage = "config", requests = 0, transport: Transport | undefined;
  let rootReason: "aborted" | "timeout" | "request_limit" | undefined;
  const elapsed = () => Math.max(0, performance.now() - started);
  const refuse = (reason: string, collection?: string): ReviewEvidenceResult => ({
    ok: false, stage, reason: rootReason ?? reason, ...(collection ? { collection } : {}),
    ...(transport ? { transport } : {}), requests, elapsedMs: elapsed(),
  });
  let subject: Subject, fetch: ReviewHttpDependencies["fetch"], credential: ReviewHttpDependencies["credential"];
  let limits: ReviewHttpDependencies["limits"], signal: AbortSignal | undefined, timeoutMs: number, ceiling: number;
  try {
    if (!object(input) || !object(options) || !object(dependencies)) return refuse("config");
    // Capture once before the first await; later caller mutations cannot change this observation's subject or ports.
    subject = { repo: input.repo as string, number: input.number as number, authorLogin: input.authorLogin as string };
    fetch = dependencies.fetch; credential = dependencies.credential;
    const suppliedLimits = dependencies.limits;
    if (suppliedLimits !== undefined && !object(suppliedLimits)) return refuse("config");
    limits = suppliedLimits === undefined ? undefined : { ...suppliedLimits };
    signal = options.signal as AbortSignal | undefined;
    const suppliedTimeout = options.timeoutMs, suppliedRequests = options.requests;
    timeoutMs = (suppliedTimeout === undefined ? 30_000 : suppliedTimeout) as number;
    ceiling = (suppliedRequests === undefined ? 200 : suppliedRequests) as number;
    if (typeof subject.repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(subject.repo)
      || !positive(subject.number) || subject.number > 2_147_483_647
      || typeof subject.authorLogin !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}\[bot\]$/i.test(subject.authorLogin)
      || typeof fetch !== "function" || typeof credential !== "function"
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || !positive(timeoutMs) || timeoutMs > 30_000 || !positive(ceiling) || ceiling > 444
      || Reflect.ownKeys(options).some(k => typeof k !== "string" || !["signal", "timeoutMs", "requests"].includes(k))) {
      return refuse("config");
    }
  } catch { return refuse("config"); }
  const controller = new AbortController();
  const abort = () => { rootReason ??= "aborted"; controller.abort(); };
  const timer = setTimeout(() => { rootReason ??= "timeout"; controller.abort(); }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  function check(): void {
    if (elapsed() >= timeoutMs) { rootReason ??= "timeout"; controller.abort(); }
    if (controller.signal.aborted) throw new ReviewHttpError(rootReason === "timeout" ? "timeout" : "aborted");
  }
  const deps: ReviewHttpDependencies = { credential, limits, fetch: async (url, init) => {
    check();
    if (requests >= ceiling) { rootReason = "request_limit"; throw new ReviewHttpError("request_limit"); }
    requests++; // One shared counter, immediately before actual delegation, across all five native sessions.
    return fetch(url, init);
  } };
  async function observe<T>(operation: () => Promise<T>): Promise<T> {
    try { check(); const value = await operation(); check(); return value; }
    catch (error) {
      if (error instanceof ReviewHttpError) transport = { code: error.code,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) };
      throw error;
    }
  }
  function enter(next: Stage): void { check(); stage = next; transport = undefined; }
  const collectionOptions = { signal: controller.signal, timeoutMs };
  try {
    check();
    const get = createReviewGitHubGet(subject.repo, subject.number, deps);
    enter("branch");
    const branch = await collectReviewBranch((path, s) => observe(() => get(path, s)), subject.repo, subject.number, collectionOptions);
    if (!branch.ok) return refuse(branch.reason, branch.collection);
    enter("pre_anchor");
    if (branch.snapshot.authorLogin !== subject.authorLogin) return refuse("author_mismatch");
    const binding: Binding = { ...subject, headSha: branch.snapshot.headSha,
      baseSha: branch.snapshot.baseSha, baseBranch: branch.snapshot.baseBranch };
    const anchor = createReviewGitHubApprovalAnchor(subject.repo, subject.number, binding, deps);
    await observe(() => anchor(controller.signal));
    enter("discussion");
    const query = createReviewGitHubDiscussion(subject.repo, subject.number, binding.baseBranch, deps);
    const discussion = await collectReviewDiscussion(subject.repo, subject.number, binding,
      (doc, variables, s) => observe(() => query(doc, variables, s)), collectionOptions);
    if (!discussion.ok) return refuse(discussion.reason, discussion.collection);
    enter("ci");
    const ciGet = createReviewGitHubCiGet(subject.repo, subject.number, binding, deps);
    const ci = await collectReviewCi((path, s) => observe(() => ciGet(path, s)),
      subject.repo, subject.number, binding, collectionOptions);
    if (!ci.ok) return refuse(ci.reason, ci.collection);
    enter("final_anchor");
    await observe(() => anchor(controller.signal));
    return { ok: true, binding, observations: { branch: branch.snapshot, discussion: discussion.snapshot, ci: ci.snapshot },
      candidate: null, automaticMerge: false, unproven: ["issuer", "custody", "owner", "issue", "loop", "atomic_merge"],
      requests, elapsedMs: elapsed() };
  } catch (error) {
    return refuse(error instanceof ReviewHttpError ? error.code : "read_failed");
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort();
  }
}
