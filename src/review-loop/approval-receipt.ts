import { ReviewJournal, type ReviewBaseBinding, type ReviewAttempt } from "./review-journal";
import { validReviewBranch } from "./http-session";
import type { ReviewDiscussionResult } from "./discussion";

type Fields = Record<string, unknown>;
interface Subject { repo: string; number: number; headSha: string; baseSha: string; baseBranch: string; authorLogin: string }
interface Reviewer { agent: string; appLogin: string }
export interface ApprovalRequest { repo: string; number: number; event: "APPROVE"; commit_id: string; body: string }
/** Future tool layer supplies authenticated, fixed-host, byte-bounded ports. No issuer or native POST adapter here. */
export interface ApprovalPorts {
  readAnchor(signal: AbortSignal): Promise<unknown>;
  submitApproval(request: ApprovalRequest, signal: AbortSignal): Promise<unknown>;
}
export type ApprovalResult = { ok: true; attemptId: string; binding: ReviewBaseBinding }
  | { ok: false; reason: string; attemptId?: string };
const object = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const app = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,99}\[bot\]$/i.test(v);
function subject(v: unknown): v is Subject {
  return object(v) && typeof v.repo === "string" && /^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v.repo)
    && positive(v.number) && sha(v.headSha) && sha(v.baseSha) && typeof v.baseBranch === "string"
    && validReviewBranch(v.baseBranch) && app(v.authorLogin);
}
class Refusal extends Error { constructor(readonly reason: string) { super(reason); } }
export function approvalAttemptMarker(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw Error("attempt_id");
  return `<!-- anima-review-attempt:${id} -->`;
}
function anchorMatches(v: unknown, expected: Subject): boolean {
  return object(v) && v.state === "OPEN" && v.draft === false && v.liveBaseSha === expected.baseSha
    && Object.entries(expected).every(([key, value]) => v[key] === value);
}

/** Unwired APPROVE-only producer. Trusted caller snapshot/config and journal custody are not proved by this function. */
export async function produceApprovalReceipt(journal: ReviewJournal, input: unknown, reviewer: unknown, body: unknown,
  ports: ApprovalPorts, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ApprovalResult> {
  let attempt: ReviewAttempt | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  let caller: AbortSignal | undefined, abort: (() => void) | undefined;
  try {
    if (!subject(input) || !object(reviewer) || typeof reviewer.agent !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(reviewer.agent)
      || !app(reviewer.appLogin) || reviewer.appLogin.toLowerCase() === input.authorLogin.toLowerCase()
      || typeof body !== "string" || body.length > 65_000 || /(^|\n)Reviewer:|<!-- anima-review-attempt:/.test(body)
      || !(journal instanceof ReviewJournal) || !object(ports) || typeof ports.readAnchor !== "function" || typeof ports.submitApproval !== "function"
      || !object(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      || !positive(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) > 30_000) throw new Refusal("invalid_input");
    const expected: Subject = { repo: input.repo, number: input.number, headSha: input.headSha, baseSha: input.baseSha,
      baseBranch: input.baseBranch, authorLogin: input.authorLogin };
    const who: Reviewer = { agent: reviewer.agent, appLogin: reviewer.appLogin };
    const key = { repo: expected.repo, number: expected.number, headSha: expected.headSha, baseSha: expected.baseSha, appLogin: who.appLogin };
    const existing = journal.find(key);
    if (existing) return { ok: false, reason: `same_subject_${existing.state}`, attemptId: existing.id };
    controller = new AbortController();
    abort = () => controller!.abort();
    caller = options.signal;
    caller?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, options.timeoutMs ?? 30_000);
    if (caller?.aborted) abort();
    const signal = controller.signal;
    async function bounded<T>(fn: () => Promise<T>): Promise<T> {
      if (signal.aborted) throw new Refusal("aborted");
      let interrupt: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        interrupt = () => reject(new Refusal("aborted")); signal.addEventListener("abort", interrupt, { once: true });
      });
      try {
        return await Promise.race([Promise.resolve().then(() => {
          if (signal.aborted) throw new Refusal("aborted");
          return fn();
        }), cancelled]);
      } finally { if (interrupt) signal.removeEventListener("abort", interrupt); }
    }
    if (!anchorMatches(await bounded(() => ports.readAnchor(signal)), expected)) throw new Refusal("anchor_moved");
    if (signal.aborted) throw new Refusal("aborted");
    attempt = journal.reserve(key);
    if (!attempt) throw new Refusal("subject_reserved");
    const request: ApprovalRequest = { repo: expected.repo, number: expected.number, event: "APPROVE", commit_id: expected.headSha,
      body: `${body}\n\nReviewer: ${who.agent}\n${approvalAttemptMarker(attempt.id)}` };
    journal.append(attempt.id, "sending");
    const result = await bounded(() => ports.submitApproval(request, signal));
    if (object(result) && positive(result.status) && result.status >= 400 && result.status < 500 && result.status !== 408) {
      journal.append(attempt.id, "rejected"); throw new Refusal("rejected");
    }
    if (!object(result) || !positive(result.status) || result.status < 200 || result.status >= 300 || !object(result.review)
      || !positive(result.review.id) || result.review.state !== "APPROVED" || result.review.commit_id !== expected.headSha
      || !object(result.review.user) || result.review.user.type !== "Bot" || !app(result.review.user.login)
      || result.review.user.login.toLowerCase() !== who.appLogin.toLowerCase()) throw new Refusal("response_unproven");
    // This attests response Bot+login, not numeric GitHub App id or token issuer identity.
    const evidence = { reviewId: result.review.id, headSha: result.review.commit_id, appLogin: result.review.user.login };
    journal.append(attempt.id, "created", evidence);
    if (!anchorMatches(await bounded(() => ports.readAnchor(signal)), expected)) throw new Refusal("anchor_moved");
    if (signal.aborted) throw new Refusal("aborted");
    journal.append(attempt.id, "bound");
    return { ok: true, attemptId: attempt.id, binding: { ...evidence, baseSha: expected.baseSha } };
  } catch (error) {
    let reason = error instanceof Refusal ? error.reason : "port_failed";
    if (attempt) {
      try {
        const current = journal.get(attempt.id);
        if (current?.state === "sending") journal.append(attempt.id, "uncertain");
        else if (current?.state === "created") journal.append(attempt.id, "unbound");
      } catch { reason = "journal_failed"; }
    }
    return { ok: false, reason, ...(attempt ? { attemptId: attempt.id } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
    if (caller && abort) caller.removeEventListener("abort", abort);
    controller?.abort();
  }
}

/** Collector observations identify orphans diagnostically; markers NEVER create or repair a base binding. */
export function reconcileApprovalAttempt(journal: ReviewJournal, attemptId: string, observation: ReviewDiscussionResult):
  { ok: true; reviewIds: number[]; bound: false } | { ok: false; reason: string } {
  try {
    const attempt = journal.get(attemptId);
    if (!attempt || !observation.ok) throw Error();
    const s = observation.snapshot, expected = attempt.subject;
    if (s.repo.toLowerCase() !== expected.repo || s.number !== expected.number || s.headSha !== expected.headSha
      || s.baseSha !== expected.baseSha || !s.reviews.complete || !s.threads.complete || !s.comments.complete
      || !Array.isArray(s.reviews.items) || s.reviews.items.length > 10_000) throw Error();
    const ids = new Set<number>(), matches: number[] = [], marker = approvalAttemptMarker(attemptId);
    for (const review of s.reviews.items) {
      if (!positive(review.id) || ids.has(review.id) || typeof review.appLogin !== "string"
        || !/^[a-z0-9][a-z0-9-]{0,99}(?:\[bot\])?$/i.test(review.appLogin) || !sha(review.headSha)
        || typeof review.body !== "string" || review.body.length > 65_536) throw Error();
      ids.add(review.id);
      if (review.appLogin.toLowerCase() === expected.appLogin && review.headSha === expected.headSha
        && review.body.split(/\r?\n/).includes(marker)) matches.push(review.id);
    }
    return { ok: true, reviewIds: matches.sort((a, b) => a - b), bound: false };
  } catch { return { ok: false, reason: "reconciliation_unproven" }; }
}
