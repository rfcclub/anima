/**
 * The work handler inside the job consumer (anima #135, WL-2, WL-3, WL-9).
 *
 * A claimed start-work or revise job is tied to its work through the job's work reference, runs one bounded
 * session under the exclusive workspace lock, and ends in exactly one of: handed back for the same author to
 * continue (a clean stop at a cap, a deadline, an interruption), reported failed with the work blocked (a spent
 * cap, no write boundary, an unavailable pinned model, a changed approval, a session that could not be proven
 * stopped), reported done with verified pull-request evidence, or left alone because the lease was lost.
 * Nothing the model says moves the work to review: that needs evidence the host collected.
 */

import { mkdirSync } from "node:fs";
import { LeaseLostError, type MeshClaim, type MeshJob } from "../mesh-jobs/client";
import type { GitHubReader, JobsPort, WorkJobHandler, WorkOutcome, ConsumerLog } from "../mesh-jobs/consumer";
import { issueDigest12, parseWorkRef } from "./approval";
import { loadWorkConfig, type WorkConfig } from "./config";
import type { SessionRecord, WorkRecord, WorkStore } from "./store";
import type { StopInput } from "./stops";
import { acquireWorkLock, assertCurrentGeneration, StaleGenerationError } from "./supervisor";

/** A heartbeat request got no answer within its timeout. */
class HeartbeatUnanswered extends Error {
  constructor() { super("heartbeat unanswered"); }
}

export type StopCause = "done" | "max_reached" | "interrupted" | "quota" | "provider_error" | "model_unavailable" | "deadline" | "workspace_timeout" | "blocked" | "unverified" | "question" | "worker_error";

export interface SessionResult {
  stopCause: StopCause;
  interruptionSource?: "abort" | "sigint";
  iterations: number;
  execMs: number;
  /** Whether every process of the session was proven stopped (see `stopAndProve`). */
  cessation: "proven" | "unproven";
  /** The check that failed when cessation is unproven; recorded in the stop record. */
  cessationCheck?: string;
  /** The worker's bounded, untrusted description of why it cannot proceed. */
  blockedReason?: string;
}

export interface SessionExecutor {
  /** The adapter that builds the sessions (`loop` for adapter #0); recorded with each session. */
  readonly adapterKind?: string;
  /**
   * Extra time after the deadline before the session is hard-stopped. Only an executor that stops its own work at the
   * deadline and then spends this time on the handoff task may declare it; it reports such an end as `deadline`.
   */
  readonly handoffGraceMs?: number;
  /** Whether the write boundary holds on this host. Checked before every session. */
  ready(): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Runs one session to a stop. Must stop and prove cessation when `signal` aborts. */
  runSession(input: {
    work: WorkRecord;
    session: SessionRecord;
    maxIterations: number;
    deadlineMs: number;
    signal: AbortSignal;
    claim: { id: string; jobId: string };
    /** `start-work` for the first pass, `revise` after a review asked for changes. */
    kind: "start-work" | "revise";
  }): Promise<SessionResult>;
}

export type Evidence = { ok: true; url: string } | { ok: false; reason: string };

export interface WorkHandlerDeps {
  store: WorkStore;
  executor: SessionExecutor;
  github: GitHubReader;
  heartbeatMs: number;
  /**
   * How long one heartbeat request may stay unanswered before the lease is treated as lost (fail closed). Defaults
   * to one heartbeat interval, at least 10s. Without it a request the gateway never answers would hold the
   * handler (it waits for the pending request before every decision) and stop later heartbeats.
   */
  heartbeatTimeoutMs?: number;
  /** Verifies, from GitHub, the pull request this work produced. The only way a work reaches review. */
  collectEvidence: (workId: string, options: { revise: boolean; guard?: () => void | Promise<void> }) => Promise<Evidence>;
  /** Read-only lookup; an unavailable lookup cannot establish that no PR exists. */
  findPublishedPr?: (repo: string, branch: string) => Promise<boolean>;
  /** Recheck the standing review before a revision spends a work session. */
  validateRevision?: (work: WorkRecord) => Promise<{ ok: true } | { ok: false; reason: string }>;
  config?: WorkConfig;
  /**
   * Host-side safety net for a session that committed but did not publish. It returns
   * published=true only after the host itself pushed the branch and, for a start-work, opened the PR; the normal
   * evidence check still decides. Absent keeps the old behavior.
   */
  publishFallback?: (input: {
    work: WorkRecord;
    kind: "start-work" | "revise";
    stopCause: StopCause;
    limitTerminal?: boolean;
    guard?: () => void;
    settledGuard?: () => Promise<void>;
  }) => Promise<{
    published: boolean;
    reason?: string;
    /** The host itself committed and published (publish-host.ts): recorded as a work event once the PR is verified. */
    host?: { sha: string; prOutput: string; checks: string[] };
    /** The host pushed the branch but a pull request may not exist (SC-027); confirmed here before anything is recorded. */
    hostPushed?: boolean;
    /** The host commit on the remote when `hostPushed` is true. */
    hostSha?: string;
  }>;
  /** Writes the session's stop record (rfcclub/anima#238 AC-8). Absent keeps the old behavior. */
  recordStop?: (input: StopInput) => unknown;
  /** External workers may continue only from a trusted checkpoint. */
  continuation?: (work: WorkRecord) => { ok: true } | { ok: false; reason: string };
  now?: () => number;
  log?: ConsumerLog;
}

const failed: WorkOutcome = { kind: "report", report: { outcome: "failed" } };

/** GitHub's own answer for an issue number that does not exist. Anything vaguer (a 404 for a missing permission, a missing binary, DNS) may pass and is not proof. */
const ISSUE_GONE = /could not resolve to an issue or pull request with the number/i;
/** Consecutive releases for one job after a temporary issue-lookup failure (about two hours at the default backoff) before the claim is reported failed. */
const MAX_TRANSIENT_RELEASES = 240;
const LOOKUP_RETRY_EVENT = "issue-lookup-retry";
const LOOKUP_RECOVERED_EVENT = "issue-lookup-recovered";

export function createWorkHandler(deps: WorkHandlerDeps): WorkJobHandler {
  const { store, executor } = deps;
  const config = deps.config ?? loadWorkConfig({});
  const log: ConsumerLog = deps.log ?? (() => {});

  const block = (workId: string, reason: string): WorkOutcome => {
    store.setState(workId, "blocked", reason);
    log("info", "work blocked", { workId, reason });
    return failed;
  };

  /** Consecutive temporary lookup failures recorded for this work since the last successful lookup. */
  const lookupRetries = (workId: string): number => store.countEventsSince(workId, LOOKUP_RETRY_EVENT, LOOKUP_RECOVERED_EVENT);

  return {
    async run({ worker, claim, job, jobs }): Promise<WorkOutcome> {
      const ref = parseWorkRef(job.workRef);
      if (!ref) {
        log("error", "work job has no readable work reference", { claimId: claim.id });
        return failed;
      }
      if (worker !== config.author) {
        log("info", "work job is not for this worker", { agent: worker, author: config.author, claimId: claim.id });
        return failed;
      }

      const existing = store.getWork(ref.workId);
      let work: WorkRecord;
      if (existing) {
        work = existing;
      } else {
        if (job.type === "revise") {
          log("info", "revision refused: work does not exist", { workId: ref.workId });
          return failed;
        }
        const created = store.createWork({
          repo: job.target.repo, issue: job.target.number, approvedDigest: ref.digest, config, workId: ref.workId,
        });
        if (created.refused) {
          log("info", "work refused", { reason: created.refused, workId: created.work.workId });
          return failed;
        }
        work = created.work;
      }
      if (work.author !== worker) return failed;
      const matchesRevision = (current: WorkRecord): boolean =>
        job.target.kind === "pr" && job.target.repo.toLowerCase() === current.repo.toLowerCase() &&
        job.target.number === current.prNumber && typeof job.target.headSha === "string" &&
        Boolean(current.prHead) && job.target.headSha.toLowerCase() === current.prHead!.toLowerCase() &&
        ref.digest === current.approvedDigest.slice(0, 12);
      if (job.type === "revise" && !matchesRevision(work)) {
        log("info", "revision refused: job does not match the recorded work and PR head", { workId: work.workId });
        return failed;
      }
      if (work.state === "blocked" || work.state === "accepted") {
        log("info", "work refused", { workId: work.workId, state: work.state, reason: work.blockedReason });
        return failed;
      }

      // The approval check is against the approved ISSUE, not the job target: a revise job targets the PR number.
      let issue: Awaited<ReturnType<typeof deps.github.issue>>;
      try {
        issue = await deps.github.issue(work.repo, work.issue);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (ISSUE_GONE.test(text)) {
          // The approved issue was deleted or moved: no later claim can succeed, so the work ends with the cause.
          return block(work.workId, "issue no longer exists");
        }
        // A temporary failure (network, rate limit, GitHub outage) is not a verdict on the work: hand the claim back
        // so the same job can be claimed again after the backoff, for about two hours of outage; after that the work is blocked with the cause.
        // The count is kept in the work's own events so it survives a restart of the service.
        const tries = lookupRetries(work.workId) + 1;
        if (tries <= MAX_TRANSIENT_RELEASES) {
          store.appendEvent(work.workId, LOOKUP_RETRY_EVENT, { jobId: job.id, tries });
          log("info", "issue lookup failed; releasing the claim", { workId: work.workId, tries, error: text.slice(0, 200) });
          return { kind: "release" };
        }
        log("error", "issue lookup kept failing; blocking the work", { workId: work.workId, tries, error: text.slice(0, 200) });
        // The claim is reported failed and the queue will not offer the job to this worker again, so the work must
        // not stay queued with no way to run: it is blocked with the cause and an edit of the issue starts a new one.
        return block(work.workId, "issue lookup kept failing");
      }
      if (lookupRetries(work.workId) > 0) store.appendEvent(work.workId, LOOKUP_RECOVERED_EVENT, { jobId: job.id });
      if (store.observeApproval(work.workId, issueDigest12(issue.body)) === "blocked") {
        const blocked = store.getWork(work.workId);
        log("info", "work refused", { workId: work.workId, state: "blocked", reason: blocked?.blockedReason ?? null });
        return failed;
      }

      const ready = await executor.ready();
      if (!ready.ok) return block(work.workId, ready.reason);

      mkdirSync(work.root, { recursive: true, mode: 0o700 });
      const lock = acquireWorkLock(work.root);
      if (!lock) {
        log("info", "work is being run by another supervisor", { workId: work.workId });
        return { kind: "release" };
      }
      try {
        if (job.type === "revise") {
          const pr = await deps.github.pullRequest(work.repo, job.target.number);
          const current = store.getWork(work.workId);
          if (!current || current.state === "blocked" || current.state === "accepted" ||
              !matchesRevision(current) || pr.state !== "open" || pr.merged !== false ||
              pr.headSha.toLowerCase() !== job.target.headSha!.toLowerCase()) {
            log("info", "revision refused: work or live PR state or head changed", { workId: work.workId });
            return failed;
          }
          const feedback = await deps.validateRevision?.(current);
          if (feedback && !feedback.ok) {
            log("info", "revision refused: review feedback changed", { workId: work.workId, reason: feedback.reason });
            return failed;
          }
          // The review check itself is remote: work may have changed while it was in flight.
          const checked = store.getWork(work.workId);
          if (!checked || checked.generation !== current.generation || checked.state !== current.state ||
              !matchesRevision(checked)) {
            log("info", "revision refused: work changed during feedback validation", { workId: work.workId });
            return failed;
          }
          work = checked;
        }
        return await runOne(work, claim, job, jobs, block);
      } finally {
        lock.release();
      }
    },
  };

  async function runOne(
    work: WorkRecord, claim: MeshClaim, job: MeshJob, jobs: JobsPort,
    blockWork: (workId: string, reason: string) => WorkOutcome,
  ): Promise<WorkOutcome> {
    const adapter = executor.adapterKind ?? "loop";
    if (adapter !== "loop") {
      if (config.externalAdapter !== "low") return blockWork(work.workId, "external adapter is disabled");
      const continuation = deps.continuation?.(work) ?? { ok: false as const, reason: "continuation check unavailable" };
      if (!continuation.ok) return blockWork(work.workId, continuation.reason);
    }
    const reserved = store.reserveSession(work.workId, { jobId: job.id, claimId: claim.id }, adapter, executor.handoffGraceMs ?? 0);
    if (!reserved.ok) {
      log("info", "no session reserved", { workId: work.workId, reason: reserved.reason });
      return failed;
    }

    // The stop record (AC-8) for every session end. A record that cannot be written blocks the work; the caller
    // must then stop (false), so nothing later moves the work on.
    const writeStop = (stop: { stopCause: string; cessation: "proven" | "unproven"; cessationCheck?: string }): boolean => {
      if (!deps.recordStop) return true;
      try {
        deps.recordStop({
          work, session: store.getSession(reserved.session.sessionId) ?? reserved.session, adapter, ...stop,
          leaseHeld: !leaseLost, generationCurrent: store.getWork(work.workId)?.generation === reserved.session.generation,
        });
        return true;
      } catch (error) {
        log("error", "work stop record failed", { workId: work.workId, error: error instanceof Error ? error.message : String(error) });
        blockWork(work.workId, "stop record could not be written");
        return false;
      }
    };

    const controller = new AbortController();
    let leaseLost = false;
    // One heartbeat request at a time, so answers cannot arrive out of order, and the pending one is awaited
    // (`settle`) before any decision that depends on `leaseLost`: a lost lease can arrive after the session ends.
    let inflight: Promise<void> | null = null;
    const heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? Math.max(deps.heartbeatMs, 10_000);
    const heartbeat = setInterval(() => {
      if (inflight) return;
      const request = jobs.heartbeat(claim.id);
      request.catch(() => {}); // an abandoned request that fails later is not an unhandled rejection
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unanswered = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HeartbeatUnanswered()), heartbeatTimeoutMs);
      });
      inflight = Promise.race([request, unanswered]).then(() => { inflight = null; }, (error) => {
        inflight = null;
        if (error instanceof LeaseLostError) {
          leaseLost = true;
          controller.abort();
        } else if (error instanceof HeartbeatUnanswered) {
          // Whether the lease still holds is unknown: stop writing, as for a lost lease.
          leaseLost = true;
          controller.abort();
          log("error", "work heartbeat unanswered; treating the lease as lost", { claimId: claim.id, timeoutMs: heartbeatTimeoutMs });
        } else {
          log("error", "work heartbeat failed", { claimId: claim.id, error: error instanceof Error ? error.message : String(error) });
        }
      }).finally(() => clearTimeout(timer));
    }, deps.heartbeatMs);
    const settle = async () => { while (inflight) await inflight; };
    let deadlineAborted = false;
    const deadline = setTimeout(() => {
      if (!controller.signal.aborted) {
        deadlineAborted = true;
        controller.abort();
      }
    }, reserved.deadlineMs + Math.max(0, executor.handoffGraceMs ?? 0));

    let result: SessionResult;
    try {
      result = await executor.runSession({
        work, session: reserved.session, maxIterations: reserved.maxIterations, deadlineMs: reserved.deadlineMs,
        signal: controller.signal, claim: { id: claim.id, jobId: job.id }, kind: job.type === "revise" ? "revise" : "start-work",
      });
    } catch (error) {
      // The session ended in a way nobody can describe: charge it in full, keep the work, and stay blocked.
      clearInterval(heartbeat);
      clearTimeout(deadline);
      await settle();
      store.closeSession(reserved.session.sessionId, { iterations: work.caps.maxIterationsPerSession, execMs: reserved.deadlineMs, stopCause: "executor-error" });
      const recorded = writeStop({ stopCause: "executor-error", cessation: "unproven", cessationCheck: "executor-error" });
      // Cessation is unknown, so the work stays blocked here whatever else happened; but when the lease is gone
      // (the abort may be why the executor failed) the claim is no longer ours to report on.
      const outcome = blockWork(
        work.workId,
        `session executor failed: ${error instanceof Error ? error.message : String(error)}${recorded ? "" : "; stop record could not be written"}`,
      );
      return leaseLost ? { kind: "lease-lost" } : outcome;
    }
    clearTimeout(deadline);
    await settle();
    // A timer firing alone does not prove it caused an earlier SIGINT or unknown interruption.
    // Late lease loss, stale generation and unproven cessation remain fail-closed.
    if (deadlineAborted && result.stopCause === "interrupted" && result.interruptionSource === "abort" && result.cessation === "proven" &&
        !leaseLost && store.getWork(work.workId)?.generation === reserved.session.generation) {
      result = { ...result, stopCause: "deadline" };
    }
    store.closeSession(reserved.session.sessionId, { iterations: result.iterations, execMs: result.execMs, stopCause: result.stopCause });
    const closedWork = store.getWork(work.workId);
    const limitTerminal = job.type === "start-work" &&
      (result.stopCause === "deadline" || result.stopCause === "max_reached") && Boolean(closedWork) &&
      (closedWork!.execMsUsed >= closedWork!.caps.workWallMs || closedWork!.sessionsUsed >= closedWork!.caps.maxSessions);
    // The host fallback publishes under the same lease as the session did, so the heartbeat runs until it is done.
    const priorLimitDecline = store.listEvents(work.workId).some((event, index, events) =>
      event.kind === "limit-terminal-declined" &&
      !events.slice(index + 1).some((later) => later.kind === "operator-recovery" || later.kind === "limit-continuation"));
    const fallbackRuns = (result.stopCause === "done" || result.stopCause === "max_reached" ||
      (result.stopCause === "deadline" && limitTerminal))
      && (!limitTerminal || !priorLimitDecline)
      && Boolean(deps.publishFallback) && !leaseLost && result.cessation !== "unproven";
    const checkExhaustion = result.stopCause === "max_reached" && Boolean(deps.findPublishedPr);
    if (!fallbackRuns && !checkExhaustion) clearInterval(heartbeat);

    const recorded = writeStop({
      stopCause: result.stopCause, cessation: result.cessation,
      ...(result.cessation === "unproven" ? { cessationCheck: result.cessationCheck ?? "cessation-unproven" } : {}),
    });
    if (!recorded) {
      clearInterval(heartbeat);
      return leaseLost ? { kind: "lease-lost" } : failed;
    }

    if (result.cessation === "unproven") {
      clearInterval(heartbeat);
      const reason = result.stopCause === "workspace_timeout"
        ? "cessation-unproven: workspace preparation timed out and its processes could not be shown to have stopped"
        : "cessation-unproven: the session's processes could not be shown to have stopped";
      blockWork(work.workId, reason);
      return leaseLost ? { kind: "lease-lost" } : failed;
    }
    if (leaseLost) {
      clearInterval(heartbeat);
      return { kind: "lease-lost" };
    }

    // Throws unless this session still holds the lease and the work's current generation.
    const guard = () => {
      if (leaseLost) throw new LeaseLostError(409, `lease lost for claim ${claim.id}`);
      assertCurrentGeneration(store, work.workId, reserved.session.generation);
    };
    // The guard for decisions made after an await: the heartbeat answer still on its way is read first.
    const settledGuard = async () => { await settle(); guard(); };
    // What a writer that no longer holds the work does with a failed guard: nothing more.
    const fenced = (error: unknown): WorkOutcome | null => {
      if (leaseLost || error instanceof LeaseLostError) return { kind: "lease-lost" };
      if (error instanceof StaleGenerationError) return failed;
      return null;
    };
    const blockIfExhaustedWithoutPr = async (): Promise<WorkOutcome | null> => {
      const current = store.getWork(work.workId);
      if (!checkExhaustion || !deps.findPublishedPr || !current || current.state !== "checkpointed" ||
          current.sessionsUsed < current.caps.maxSessions) return null;
      try {
        await settledGuard();
        const hasPr = await deps.findPublishedPr(current.repo, current.branch);
        await settledGuard();
        if (hasPr) return null;
        const latest = store.getWork(work.workId);
        if (!latest || latest.state !== "checkpointed" || latest.sessionsUsed < latest.caps.maxSessions) return null;
        return blockWork(work.workId, `sessions exhausted (${latest.sessionsUsed} of ${latest.caps.maxSessions} used)`);
      } catch (error) {
        const outcome = fenced(error);
        if (outcome) return outcome;
        log("error", "could not check pull request before blocking exhausted work", {
          workId: work.workId, error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    if (fallbackRuns && deps.publishFallback) {
      try {
        const fallback = await deps.publishFallback({
          work,
          kind: job.type === "revise" ? "revise" : "start-work",
          stopCause: result.stopCause,
          limitTerminal,
          guard,
          settledGuard,
        });
        await settle();
        if (leaseLost) return { kind: "lease-lost" };
        if (fallback.published) {
          const evidence = await deps.collectEvidence(work.workId, { revise: job.type === "revise", guard: settledGuard });
          // The answer may have come after the lease or generation went: neither a block nor a report is ours then.
          await settledGuard();
          if (!evidence.ok) {
            return blockWork(work.workId, `publish fallback produced no verified pull request: ${evidence.reason}`);
          }
          if (fallback.host) {
            // SC-028: the pull request exists; failing to note who published it must not undo that.
            try {
              store.appendEvent(work.workId, "published-by-host", { url: evidence.url, stopCause: result.stopCause, checks: fallback.host.checks });
            } catch (error) {
              log("error", "could not record the host publish event", { workId: work.workId, error: error instanceof Error ? error.message : String(error) });
            }
          }
          store.setState(work.workId, "in-review");
          store.appendEvent(work.workId, "job-reported", { jobId: job.id, type: job.type });
          if (job.type === "start-work") store.setStartJob(work.workId, job.id);
          log("info", "work published by host fallback", { workId: work.workId, url: evidence.url });
          return { kind: "report", report: { outcome: "done", evidenceRef: evidence.url } };
        }
        if (fallback.reason) log("info", "work publish fallback skipped", { workId: work.workId, reason: fallback.reason });
        if (limitTerminal) {
          const reason = fallback.reason || "no reason given";
          let hasPublishedPr = reason === "pull request already exists" ? true : null;
          if (hasPublishedPr === null && deps.findPublishedPr) {
            try {
              const current = store.getWork(work.workId);
              await settledGuard();
              hasPublishedPr = await deps.findPublishedPr(current!.repo, current!.branch);
              await settledGuard();
            } catch (error) {
              const outcome = fenced(error);
              if (outcome) return outcome;
              log("error", "could not check pull request after publish fallback decline", {
                workId: work.workId, error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (hasPublishedPr === true) {
            const evidence = await deps.collectEvidence(work.workId, { revise: job.type === "revise", guard: settledGuard });
            await settledGuard();
            if (!evidence.ok) return blockWork(work.workId, `no verified pull request: ${evidence.reason}`);
            store.setState(work.workId, "in-review");
            store.appendEvent(work.workId, "job-reported", { jobId: job.id, type: job.type });
            if (job.type === "start-work") store.setStartJob(work.workId, job.id);
            return { kind: "report", report: { outcome: "done", evidenceRef: evidence.url } };
          }
          if (hasPublishedPr === false) {
            const latest = store.getWork(work.workId);
            const limit = latest && latest.execMsUsed >= latest.caps.workWallMs
              ? "execution time limit reached"
              : `sessions exhausted (${latest?.sessionsUsed ?? 0} of ${latest?.caps.maxSessions ?? 0} used)`;
            store.appendEvent(work.workId, "limit-terminal-declined", { limit, reason });
            if (fallback.hostPushed) {
              // SC-027: only now is the absence of a pull request confirmed (an unknown lookup or an existing PR never
              // reaches this branch) and the guards have just been re-checked, so the event is true and ours to write.
              try {
                store.appendEvent(work.workId, "host-push-without-pr", {
                  branch: work.branch, ...(fallback.hostSha ? { commit: fallback.hostSha } : {}), reason,
                });
              } catch (error) {
                log("error", "could not record the host push event", { workId: work.workId, error: error instanceof Error ? error.message : String(error) });
              }
            }
            // The remote PR check has settled; the same lease and generation must still own this decision.
            await settledGuard();
            const continued = store.continueAfterLimit({ workId: work.workId, root: work.root,
              generation: reserved.session.generation, sessionId: reserved.session.sessionId,
              jobType: job.type === "revise" ? "revise" : "start-work", state: "checkpointed" });
            if (continued) return { kind: "release" };
            return blockWork(work.workId, `${limit}; publish fallback declined: ${reason}`);
          }
        }
        const exhausted = await blockIfExhaustedWithoutPr();
        if (exhausted) return exhausted;
      } catch (error) {
        log("error", "work publish fallback failed", { workId: work.workId, error: error instanceof Error ? error.message : String(error) });
        // A writer that no longer holds the work must not carry on to report or block it.
        const outcome = fenced(error);
        if (outcome) return outcome;
        const exhausted = await blockIfExhaustedWithoutPr();
        if (exhausted) return exhausted;
      } finally {
        clearInterval(heartbeat);
        await settle();
      }
      // Whatever the fallback did (or failed to do), the old path below must still own the work.
      try {
        await settledGuard();
      } catch (error) {
        return fenced(error) ?? failed;
      }
    } else if (checkExhaustion) {
      try {
        const exhausted = await blockIfExhaustedWithoutPr();
        if (exhausted) return exhausted;
      } finally {
        clearInterval(heartbeat);
        await settle();
      }
      try {
        await settledGuard();
      } catch (error) {
        return fenced(error) ?? failed;
      }
    }

    switch (result.stopCause) {
      case "done": {
        try {
          await settledGuard();
          const evidence = await deps.collectEvidence(work.workId, { revise: job.type === "revise", guard: settledGuard });
          await settledGuard(); // the answer may have come after the lease or generation went
          if (!evidence.ok) return blockWork(work.workId, `no verified pull request: ${evidence.reason}`);
          store.setState(work.workId, "in-review");
          store.appendEvent(work.workId, "job-reported", { jobId: job.id, type: job.type });
          if (job.type === "start-work") store.setStartJob(work.workId, job.id);
          return { kind: "report", report: { outcome: "done", evidenceRef: evidence.url } };
        } catch (error) {
          const outcome = fenced(error);
          if (outcome) return outcome;
          throw error;
        }
      }
      case "model_unavailable":
        return blockWork(work.workId, "pinned model unavailable: no other model is tried");
      case "blocked":
        try {
          await settledGuard();
          return blockWork(work.workId, `worker reported blocked: ${result.blockedReason || "unspecified blocker"}`);
        } catch (error) {
          return fenced(error) ?? failed;
        }
      default:
        return { kind: "release" };
    }
  }
}
