import { collectReviewEvidence, type ReviewEvidenceResult } from "./evidence-bundle";
import { auditReviewEligibility, captureReviewAuditContext, type ReviewAudit } from "./eligibility";
import type { ReviewHttpDependencies } from "./http-session";

type Evidence = Extract<ReviewEvidenceResult, { ok: true }>;
export type CollectedReviewAuditResult = {
  ok: true; binding: Evidence["binding"]; audit: ReviewAudit;
  candidate: null; automaticMerge: false; unproven: string[]; requests: number; elapsedMs: number;
} | Extract<ReviewEvidenceResult, { ok: false }>
  | { ok: false; stage: "mapping"; reason: "binding_mismatch"; requests: number; elapsedMs: number };

/** Unwired read-only diagnostic. Caller owns the expected App and receipt provenance.
 * No owner, issue policy or loop state is inferred from a login, comment or author-editable label.
 */
export async function collectAndAuditReviewEvidence(
  input: unknown, dependencies: ReviewHttpDependencies, context: unknown,
  options: Parameters<typeof collectReviewEvidence>[2] = {},
): Promise<CollectedReviewAuditResult> {
  const captured = captureReviewAuditContext(context);
  if (!captured) return { ok: false, stage: "config", reason: "audit_context_invalid", requests: 0, elapsedMs: 0 };
  const evidence = await collectReviewEvidence(input, dependencies, options);
  if (!evidence.ok) return evidence;
  const { binding, observations: { branch, discussion, ci }, requests, elapsedMs } = evidence;
  // Native collectors already enforce these equalities; keep the composition boundary explicit.
  if ([branch, discussion, ci].some(s => s.repo !== binding.repo || s.number !== binding.number
    || s.headSha !== binding.headSha || s.baseSha !== binding.baseSha || s.baseBranch !== binding.baseBranch)
    || branch.authorLogin !== binding.authorLogin || ci.ci.headSha !== binding.headSha) {
    return { ok: false, stage: "mapping", reason: "binding_mismatch", requests, elapsedMs };
  }
  const audit = auditReviewEligibility({
    repo: branch.repo, number: branch.number, state: branch.state, draft: branch.draft,
    headSha: binding.headSha, baseSha: binding.baseSha,
    observedHeadSha: binding.headSha, observedBaseSha: binding.baseSha,
    authorLogin: branch.authorLogin, ownerAgents: [],
    paths: branch.paths, commits: branch.commits, reviews: discussion.reviews,
    threads: { complete: discussion.threads.complete, items: discussion.threads.items.map(t => ({ resolved: t.resolved })) },
    ci: ci.ci, issue: null, loop: null,
  }, captured);
  return { ok: true, binding, audit, candidate: null, automaticMerge: false,
    unproven: evidence.unproven, requests, elapsedMs };
}
