/**
 * Issue dispatch for the work loop (mesh-agent-pipeline P2/B).
 *
 * An open issue that carries the approval label but has no active work is put on the Mesh job queue as one
 * `start-work` job for the configured author. The gateway enforces the idempotency key, so re-polling the same
 * approval never creates a second job; a changed issue body produces a new digest and may start a new work.
 *
 * Off by default: without a pipeline config file nothing here runs.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MeshJobsClient } from "./client";
import { spawnGh, type GhRunner } from "./github";
import type { ConsumerLog } from "./consumer";
import type { MeshJobsPresence } from "./start";
import type { MeshJobsWorkConfig } from "./config";
import { WorkStore, type WorkRecord, type WorkState } from "../work/store";
import { acquireWorkLock } from "../work/supervisor";

const DAY_MS = 24 * 3_600_000;
/** Works that hold or wait for an author session; a blocked work is continued only while fewer are in flight. */
const IN_FLIGHT_STATES: ReadonlySet<WorkState> = new Set(["queued", "running", "checkpointed", "revising"]);
const BACKLOG_IN_FLIGHT_LIMIT = 2;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const ACTIVE_STATES: ReadonlySet<WorkState> = new Set(["queued", "running", "checkpointed", "in-review", "revising"]);

export interface PipelineConfig {
  repos: string[];
  /** Repositories whose open pull requests are put on the review queue; defaults to `repos`. */
  reviewRepos: string[];
  intervalMs: number;
  issueLabel: string;
  /** Label that marks a draft intent awaiting review. */
  intentLabel: string;
  /** Only issues and PRs created at or after this instant (ms). Required so a missing field cannot drain a backlog. */
  notBefore: number;
  /** Maximum number of start-work jobs enqueued in one poll. */
  maxPerPoll: number;
  /** Maximum number of intent-review jobs enqueued in one poll. */
  maxIntentPerPoll: number;
  /** Maximum number of pull-request review jobs enqueued in one poll. */
  maxReviewPerPoll: number;
  /** How many times a start job that expired unclaimed is enqueued again for the same work (default 2). */
  maxStartRedispatch?: number;
}

/** `ANIMA_PIPELINE_CONFIG` wins; otherwise the file beside the other secrets. */
export function defaultPipelineConfigPath(env: Record<string, string | undefined> = process.env): string {
  return env.ANIMA_PIPELINE_CONFIG ?? join(env.HOME ?? "~", ".anima", "secrets", "pipeline.json");
}

/** Null when the file is absent (dispatch off). Every other problem throws, naming the field, never a value. */
export function loadPipelineConfig(path: string): PipelineConfig | null {
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`pipeline config must be mode 0600, got ${mode.toString(8)}`);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    throw new Error("pipeline config must contain valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("pipeline config must be an object");
  const known = new Set(["repos", "reviewRepos", "intervalMs", "issueLabel", "intentLabel", "notBefore", "maxPerPoll", "maxIntentPerPoll", "maxReviewPerPoll", "maxStartRedispatch"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`pipeline config: unknown field ${key}`);

  if (!Array.isArray(raw.repos) || raw.repos.length === 0) throw new Error("pipeline config: repos must be a non-empty array");
  const repos = raw.repos.map((value) => {
    if (typeof value !== "string" || !REPO.test(value)) throw new Error("pipeline config: invalid repo");
    return value;
  });
  if (new Set(repos).size !== repos.length) throw new Error("pipeline config: duplicate repo");

  const reviewReposRaw = raw.reviewRepos === undefined ? repos : raw.reviewRepos;
  if (!Array.isArray(reviewReposRaw) || reviewReposRaw.length === 0) throw new Error("pipeline config: reviewRepos must be a non-empty array");
  const reviewRepos = reviewReposRaw.map((value) => {
    if (typeof value !== "string" || !REPO.test(value)) throw new Error("pipeline config: invalid review repo");
    return value;
  });
  if (new Set(reviewRepos).size !== reviewRepos.length) throw new Error("pipeline config: duplicate review repo");

  const intervalMs = raw.intervalMs === undefined ? 300_000 : raw.intervalMs;
  if (typeof intervalMs !== "number" || !Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
    throw new Error("pipeline config: intervalMs must be an integer between 10000 and 3600000");
  }

  const issueLabel = raw.issueLabel === undefined ? "orca:approved" : raw.issueLabel;
  if (typeof issueLabel !== "string" || !LABEL.test(issueLabel)) throw new Error("pipeline config: invalid issueLabel");

  const intentLabel = raw.intentLabel === undefined ? "orca:intent" : raw.intentLabel;
  if (typeof intentLabel !== "string" || !LABEL.test(intentLabel)) throw new Error("pipeline config: invalid intentLabel");

  if (raw.notBefore === undefined) throw new Error("pipeline config: notBefore is required");
  const parsedNotBefore = typeof raw.notBefore === "string" ? Date.parse(raw.notBefore) : Number.NaN;
  if (!Number.isFinite(parsedNotBefore)) throw new Error("pipeline config: notBefore must be an ISO timestamp");
  const notBefore = parsedNotBefore;

  const maxPerPoll = raw.maxPerPoll === undefined ? 3 : raw.maxPerPoll;
  if (typeof maxPerPoll !== "number" || !Number.isInteger(maxPerPoll) || maxPerPoll < 1 || maxPerPoll > 10) {
    throw new Error("pipeline config: maxPerPoll must be an integer between 1 and 10");
  }
  const maxIntentPerPoll = raw.maxIntentPerPoll === undefined ? 2 : raw.maxIntentPerPoll;
  if (typeof maxIntentPerPoll !== "number" || !Number.isInteger(maxIntentPerPoll) || maxIntentPerPoll < 1 || maxIntentPerPoll > 10) {
    throw new Error("pipeline config: maxIntentPerPoll must be an integer between 1 and 10");
  }
  const maxReviewPerPoll = raw.maxReviewPerPoll === undefined ? 3 : raw.maxReviewPerPoll;
  if (typeof maxReviewPerPoll !== "number" || !Number.isInteger(maxReviewPerPoll) || maxReviewPerPoll < 1 || maxReviewPerPoll > 10) {
    throw new Error("pipeline config: maxReviewPerPoll must be an integer between 1 and 10");
  }

  const maxStartRedispatch = raw.maxStartRedispatch === undefined ? 2 : raw.maxStartRedispatch;
  if (typeof maxStartRedispatch !== "number" || !Number.isInteger(maxStartRedispatch) || maxStartRedispatch < 0 || maxStartRedispatch > 10) {
    throw new Error("pipeline config: maxStartRedispatch must be an integer between 0 and 10");
  }

  return {
    repos, reviewRepos, intervalMs, issueLabel, intentLabel, notBefore,
    maxPerPoll, maxIntentPerPoll, maxReviewPerPoll, maxStartRedispatch,
  };
}

/** The digest `mesh work` uses: SHA-256 over the issue body exactly as GitHub returns it. */
export function issueDigest(body: string | null | undefined): string {
  return createHash("sha256").update(String(body ?? ""), "utf8").digest("hex").slice(0, 12);
}

/** The revision key for an intent review: title+body, so an edited intent gets a fresh review. */
export function intentRevision(title: string, body: string | null | undefined): string {
  return createHash("sha256").update(JSON.stringify([title, String(body ?? "")])).digest("hex").slice(0, 12);
}

export interface StartWorkJobInput {
  repo: string;
  issue: number;
  digest: string;
  authorMeshId: string;
  now: number;
  /** Re-dispatch of a work that already exists: the job carries that work's id so the claim finds it. */
  workId?: string;
  /** 0 (default) is the first job for the approval; each later attempt gets its own idempotency key. */
  attempt?: number;
  /** A continuation or operator-recovery event scopes replacement keys to that allowance. */
  continuation?: number;
}

/** Same shape `mesh work` posts to the gateway, including the work reference the work runtime parses. */
export function buildStartWorkJob(input: StartWorkJobInput): Record<string, unknown> {
  return {
    type: "start-work",
    target: { repo: input.repo, kind: "issue", number: input.issue },
    slots: 1,
    eligible: [input.authorMeshId],
    priority: -10,
    workRef: `${input.workId ?? `w${randomBytes(5).toString("hex")}`}.${input.digest}`,
    expiresAt: input.now + DAY_MS,
    idempotencyKey: `work:${input.repo}#${input.issue}:${input.digest}${input.continuation ? `:c${input.continuation}` : ""}${input.attempt ? `:r${input.attempt}` : ""}`,
  };
}

export interface IntentReviewJobInput {
  repo: string;
  issue: number;
  revision: string;
  reviewerMeshIds: string[];
  authorMeshId: string;
  /** Mesh IDs that may not claim the job; defaults to the work author. */
  excludedMeshIds?: string[];
  now: number;
}

/** One intent-review job per intent revision, claimable by the independent reviewers only. */
export function buildIntentReviewJob(input: IntentReviewJobInput): Record<string, unknown> {
  return {
    type: "review-intent",
    target: { repo: input.repo, kind: "issue", number: input.issue },
    slots: 1,
    eligible: input.reviewerMeshIds,
    excluded: input.excludedMeshIds ?? [input.authorMeshId],
    priority: 0,
    expiresAt: input.now + DAY_MS,
    idempotencyKey: `intent:${input.repo}#${input.issue}@${input.revision}`,
  };
}

interface GitHubIssue {
  number: number;
  title?: string;
  body: string | null;
  createdAt?: string;
  labels: Array<{ name?: string }>;
  author?: { login?: string };
}

export interface IssueDispatchDeps {
  config: PipelineConfig;
  work: MeshJobsWorkConfig;
  store: Pick<WorkStore, "listWorks"> & Partial<Pick<WorkStore, "listEvents" | "appendEvent" | "setState" | "latestEndedSession" | "continueAfterLimit">>;
  mesh: Pick<MeshJobsClient, "enqueue"> & Partial<Pick<MeshJobsClient, "getJob">>;
  gh: GhRunner;
  log: ConsumerLog;
  now?: () => number;
}

/**
 * Whether a start job can no longer run: it expired with no live claim (a claim lease can outlast the job's expiry,
 * and re-dispatching then would start a second writer), or every worker it is eligible for already holds a failed or
 * reported claim on it, which the queue never lets them claim again. An unreadable job is not dead (fail closed).
 */
async function startJobIsDead(mesh: IssueDispatchDeps["mesh"], job: { id: string; state: string }): Promise<boolean> {
  if (job.state !== "expired" && job.state !== "queued") return false;
  if (!mesh.getJob) return false;
  let details: Awaited<ReturnType<NonNullable<typeof mesh.getJob>>>;
  try {
    details = await mesh.getJob(job.id);
  } catch {
    return false;
  }
  // The job may have completed between the caller's read and the claims read.
  if ((details.id !== undefined && details.id !== job.id) ||
      (details.state !== undefined && details.state !== job.state)) return false;
  if (details.claims.some((claim) => claim.state === "active")) return false;
  if (job.state === "expired") return true;
  const eligible = details.eligible ?? [];
  return eligible.length > 0 && eligible.every((worker) =>
    details.claims.some((claim) => claim.worker === worker && (claim.state === "failed" || claim.state === "reported")));
}

const REDISPATCH_EVENT = "start-job-redispatched";

/**
 * A work that was created for a start job but never ran (`queued`, no session) is orphaned when that job expires
 * unclaimed: the work stays queued and every later poll skips the issue. Returns true when the issue is handled here
 * (an orphan was re-dispatched, blocked or is still waiting on a live job) and must not be dispatched again.
 */
async function recoverQueuedWork(
  deps: IssueDispatchDeps, repo: string, issue: number, digest: string, record: WorkRecord, now: () => number,
): Promise<boolean> {
  const { config, work, store, mesh, log } = deps;
  const { listEvents, appendEvent, setState } = store;
  if (!listEvents || !appendEvent || !setState) {
    log("info", "issue dispatch skipped: work already active", { repo, issue });
    return false;
  }
  const attempts = listEvents.call(store, record.workId).filter((event) => event.kind === REDISPATCH_EVENT).length;
  const max = config.maxStartRedispatch ?? 2;
  const input = { repo, issue, digest, authorMeshId: work.authorMeshId, now: now(), workId: record.workId };
  try {
    // A replay of the current attempt's key returns the existing job, so its state tells whether it can still run.
    const current = await mesh.enqueue(buildStartWorkJob({ ...input, attempt: attempts }));
    if (!(await startJobIsDead(mesh, current))) {
      log("info", "issue dispatch skipped: work already active", { repo, issue });
      return false;
    }
    // The remote reads above can take a while: act only if the work is still the one that was decided on.
    const fresh = store.listWorks().find((w) => w.workId === record.workId);
    if (!fresh || fresh.state !== "queued" || fresh.sessionsUsed !== 0 || fresh.generation !== record.generation) {
      log("info", "start job recovery skipped: the work changed while the job was read", { repo, issue, workId: record.workId });
      return false;
    }
    if (attempts >= max) {
      setState.call(store, record.workId, "blocked", `start job expired ${attempts + 1} times without running`);
      log("info", "work blocked: start job expired", { repo, issue, workId: record.workId, attempts: attempts + 1 });
      return false;
    }
    const next = await mesh.enqueue(buildStartWorkJob({ ...input, attempt: attempts + 1 }));
    // Charged only once the replacement job was accepted, so a failing gateway does not use the attempts up.
    appendEvent.call(store, record.workId, REDISPATCH_EVENT, { attempt: attempts + 1, expiredJob: current.id, jobId: next.id });
    log("info", "start job re-dispatched", { repo, issue, workId: record.workId, attempt: attempts + 1, jobId: next.id });
    return next.state === "queued" || next.state === "reported";
  } catch (error) {
    log("error", "start job recovery failed", { repo, issue, error: errorText(error) });
    return false;
  }
}

/** Confirm a blocked issue is still approved and has no merged closing PR. Any incomplete response fails closed. */
async function issueStillNeedsWork(gh: GhRunner, repo: string, issue: number, digest: string, label: string): Promise<boolean> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){state body labels(first:100){nodes{name} pageInfo{hasNextPage}} closedByPullRequestsReferences(first:100,includeClosedPrs:true){nodes{merged} pageInfo{hasNextPage}}}}}`;
  try {
    const raw = await gh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${issue}`]);
    const parsed = JSON.parse(raw) as { errors?: unknown; data?: { repository?: { issue?: {
      state?: unknown; body?: unknown; labels?: { nodes?: Array<{ name?: unknown }>; pageInfo?: { hasNextPage?: unknown } };
      closedByPullRequestsReferences?: { nodes?: Array<{ merged?: unknown }>; pageInfo?: { hasNextPage?: unknown } };
    } } } };
    const current = parsed.data?.repository?.issue;
    const labels = current?.labels;
    const prs = current?.closedByPullRequestsReferences;
    return !parsed.errors && current?.state === "OPEN" && typeof current.body === "string" && issueDigest(current.body) === digest &&
      Array.isArray(labels?.nodes) && labels.pageInfo?.hasNextPage === false && labels.nodes.some((entry) => entry.name === label) &&
      Array.isArray(prs?.nodes) && prs.pageInfo?.hasNextPage === false && prs.nodes.every((entry) => entry.merged === false);
  } catch {
    return false;
  }
}

/** Recover an existing checkpoint without guessing about the original job or racing a local supervisor. */
async function recoverCheckpointedWork(
  deps: IssueDispatchDeps, repo: string, issue: number, digest: string, record: WorkRecord, now: () => number,
): Promise<boolean> {
  const { store, mesh, config, work, log } = deps;
  if (!store.listEvents || !store.appendEvent || !store.setState || !store.latestEndedSession || !mesh.getJob ||
      (record.state === "blocked" && !store.continueAfterLimit)) return false;
  let continued = false;
  try {
    const lock = acquireWorkLock(record.root);
    if (!lock) return false;
    try {
      const fresh = () => store.listWorks().find((candidate) => candidate.workId === record.workId);
      const unchanged = (candidate: WorkRecord | undefined) => candidate && candidate.state === record.state &&
        candidate.generation === record.generation && candidate.root === record.root && candidate.sessionsUsed === record.sessionsUsed &&
        candidate.approvedDigest.toLowerCase() === digest;
      if (!unchanged(fresh())) return false;
      const session = store.latestEndedSession(record.workId);
      if (!session || session.generation !== record.generation) return false;
      let events = store.listEvents(record.workId);
      const reservedSeq = events.filter((event) => event.kind === "session-reserved" &&
        (event.detail as { no?: unknown } | null)?.no === session.no).at(-1)?.seq ?? 0;
      const latestDispatch = events.filter((event) => event.kind === REDISPATCH_EVENT && event.seq > reservedSeq).at(-1);
      const dispatchedId = (latestDispatch?.detail as { jobId?: unknown } | undefined)?.jobId;
      const currentId = typeof dispatchedId === "string" ? dispatchedId : session.jobId;
      const current = await mesh.getJob(currentId);
      if (current.id !== currentId || !(await startJobIsDead(mesh, current))) return false;
      if (record.state === "blocked" && !(await issueStillNeedsWork(deps.gh, repo, issue, digest, config.issueLabel))) return false;
      if (!unchanged(fresh())) return false;
      const competing = store.listWorks().some((candidate) => candidate.workId !== record.workId &&
        candidate.repo.toLowerCase() === repo.toLowerCase() && candidate.issue === issue && ACTIVE_STATES.has(candidate.state));
      if (competing) return false;
      if (record.state === "blocked") {
        const resumed = store.continueAfterLimit!({ workId: record.workId, root: record.root, generation: record.generation,
          sessionId: session.sessionId, jobType: "start-work", state: "blocked" });
        if (!resumed) return false;
        continued = true;
        events = store.listEvents(record.workId);
      }
      const reset = events.filter((event) => event.kind === "limit-continuation" || event.kind === "operator-recovery").at(-1);
      const attempts = events.filter((event) => event.kind === REDISPATCH_EVENT && event.seq > (reset?.seq ?? 0)).length;
      if (attempts >= (config.maxStartRedispatch ?? 2)) {
        store.setState(record.workId, "blocked", `start job expired ${attempts + 1} times without running`);
        return continued;
      }
      const next = await mesh.enqueue(buildStartWorkJob({ repo, issue, digest, authorMeshId: work.authorMeshId,
        now: now(), workId: record.workId, attempt: attempts + 1, ...(reset ? { continuation: reset.seq } : {}) }));
      const after = fresh();
      if (!after || after.state !== "checkpointed" || after.generation !== record.generation || after.root !== record.root) return continued;
      store.appendEvent(record.workId, REDISPATCH_EVENT, { attempt: attempts + 1, expiredJob: current.id, jobId: next.id });
      log("info", "start job re-dispatched", { repo, issue, workId: record.workId, attempt: attempts + 1, jobId: next.id });
      return continued || next.state === "queued" || next.state === "reported";
    } finally {
      lock.release();
    }
  } catch (error) {
    log("error", "checkpointed start job recovery failed", { repo, issue, error: errorText(error) });
    return continued;
  }
}

/** One poll. Returns the number of jobs the gateway accepted (a replay counts as zero for logging). */
export async function dispatchApprovedIssues(deps: IssueDispatchDeps): Promise<number> {
  const { config, work, store, mesh, gh, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let dispatched = 0;

  for (const repo of config.repos) {
    let raw: string;
    try {
      raw = await gh([
        "issue", "list", "--repo", repo, "--state", "open", "--label", config.issueLabel,
        "--json", "number,body,labels,createdAt", "--limit", "100",
      ]);
    } catch (error) {
      log("error", "issue dispatch poll failed", { repo, error: errorText(error) });
      continue;
    }

    let issues: GitHubIssue[];
    try {
      issues = (JSON.parse(raw) as GitHubIssue[]).filter((issue) =>
        Number.isInteger(issue?.number) && issue.number > 0
        && (issue.labels ?? []).some((label) => label?.name === config.issueLabel)
        && (config.notBefore === undefined
          || (typeof issue.createdAt === "string" && Date.parse(issue.createdAt) >= config.notBefore)));
    } catch {
      log("error", "issue dispatch poll returned invalid JSON", { repo });
      continue;
    }

    for (const issue of issues) {
      if (dispatched >= config.maxPerPoll) break;
      const digest = issueDigest(issue.body);
      const records = store.listWorks().filter((record) =>
        record.repo.toLowerCase() === repo.toLowerCase() && record.issue === issue.number);
      let open = records.filter((record) => ACTIVE_STATES.has(record.state));
      // A work that never started and was approved for older text is superseded by the edited issue.
      for (const stale of open.filter((r) => r.state === "queued" && r.sessionsUsed === 0 && r.approvedDigest.toLowerCase() !== digest)) {
        if (!store.setState) continue;
        store.setState(stale.workId, "blocked", "superseded: the approved issue text changed before the work started");
        log("info", "queued work superseded by a new approval", { repo, issue: issue.number, workId: stale.workId });
        open = open.filter((r) => r.workId !== stale.workId);
      }
      if (open.length > 0) {
        const orphan = open.find((r) => r.state === "queued" && r.sessionsUsed === 0 && r.approvedDigest.toLowerCase() === digest);
        const checkpoint = open.find((r) => r.state === "checkpointed" && r.sessionsUsed > 0 && r.prNumber === null && r.approvedDigest.toLowerCase() === digest);
        if (orphan && open.length === 1) {
          if (await recoverQueuedWork(deps, repo, issue.number, digest, orphan, now)) dispatched += 1;
        } else if (checkpoint && open.length === 1) {
          if (await recoverCheckpointedWork(deps, repo, issue.number, digest, checkpoint, now)) dispatched += 1;
        } else log("info", "issue dispatch skipped: work already active", { repo, issue: issue.number });
        continue;
      }
      const matching = records.filter((record) => record.approvedDigest.toLowerCase() === digest);
      const latest = matching.at(-1);
      if (latest?.state === "blocked" && latest.sessionsUsed > 0 && latest.prNumber === null) {
        // Drain the blocked backlog slowly: a start job expires a day after it is queued, so flooding the queue
        // behind one author would only expire the jobs and block the works again.
        const inFlight = store.listWorks().filter((record) => IN_FLIGHT_STATES.has(record.state)).length;
        if (inFlight >= BACKLOG_IN_FLIGHT_LIMIT) {
          log("info", "blocked work continuation deferred: other works are in flight", { repo, issue: issue.number, inFlight });
          continue;
        }
        if (await recoverCheckpointedWork(deps, repo, issue.number, digest, latest, now)) dispatched += 1;
        continue;
      }
      // Any terminal work for the same approval digest is final: accepted, blocked, or otherwise. An edited
      // issue changes the digest and is the only way to ask for a new attempt.
      if (records.some((record) => record.approvedDigest === digest)) {
        log("info", "issue dispatch skipped: work already exists for this approval", { repo, issue: issue.number });
        continue;
      }
      try {
        const base = { repo, issue: issue.number, digest, authorMeshId: work.authorMeshId, now: now() };
        let job = await mesh.enqueue(buildStartWorkJob(base));
        // A replay of an approval whose job expired unclaimed (no work exists yet to recover): try the next attempt
        // key, bounded, so the approval is not stuck behind a dead job.
        const maxAttempts = config.maxStartRedispatch ?? 2;
        let dead = await startJobIsDead(mesh, job);
        for (let attempt = 1; dead && attempt <= maxAttempts; attempt += 1) {
          job = await mesh.enqueue(buildStartWorkJob({ ...base, attempt }));
          dead = await startJobIsDead(mesh, job);
        }
        if (dead) {
          log("info", "issue dispatch stopped: every start job for this approval is dead", { repo, issue: issue.number, digest });
          continue;
        }
        if ((job.state === "queued" || job.state === "reported") && freshJob(job, startedAt)) dispatched += 1;
        log("info", "issue dispatched", { repo, issue: issue.number, jobId: job.id, digest });
      } catch (error) {
        log("error", "issue dispatch enqueue failed", { repo, issue: issue.number, error: errorText(error) });
      }
    }
    if (dispatched >= config.maxPerPoll) break;
  }
  return dispatched;
}

/**
 * One poll for draft intents: an open issue with the intent label, without the approval label, created after the
 * cutoff, gets one review-intent job per title+body revision. The reviewer's tick of the workflow-owned approval
 * box is the evidence; the workflow then applies the approval label and the next work poll starts the work.
 */
export async function dispatchIntentReviews(deps: IssueDispatchDeps): Promise<number> {
  const { config, work, mesh, gh, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const reviewerMeshIds = work.reviewers.map((reviewer) => reviewer.meshId);
  let dispatched = 0;

  for (const repo of config.repos) {
    let raw: string;
    try {
      raw = await gh([
        "issue", "list", "--repo", repo, "--state", "open", "--label", config.intentLabel,
        "--json", "number,title,body,labels,createdAt,author", "--limit", "100",
      ]);
    } catch (error) {
      log("error", "intent dispatch poll failed", { repo, error: errorText(error) });
      continue;
    }

    let issues: GitHubIssue[];
    try {
      issues = (JSON.parse(raw) as GitHubIssue[]).filter((issue) => {
        const labels = (issue.labels ?? []).map((label) => label?.name);
        return Number.isInteger(issue?.number) && issue.number > 0
          && labels.includes(config.intentLabel)
          && !labels.includes(config.issueLabel)
          && (config.notBefore === undefined
            || (typeof issue.createdAt === "string" && Date.parse(issue.createdAt) >= config.notBefore));
      });
    } catch {
      log("error", "intent dispatch poll returned invalid JSON", { repo });
      continue;
    }

    for (const issue of issues) {
      if (dispatched >= config.maxIntentPerPoll) break;
      const revision = intentRevision(String(issue.title ?? ""), issue.body);
      const authorLogin = String(issue.author?.login ?? "").toLowerCase();
      const excluded = [...new Set([
        work.authorMeshId,
        // A reviewer never reviews its own intent.
        ...work.reviewers.filter((reviewer) => reviewer.login.toLowerCase() === authorLogin).map((reviewer) => reviewer.meshId),
      ])];
      try {
        const job = await mesh.enqueue(buildIntentReviewJob({
          repo, issue: issue.number, revision, reviewerMeshIds,
          authorMeshId: work.authorMeshId, excludedMeshIds: excluded, now: now(),
        }));
        if ((job.state === "queued" || job.state === "reported") && freshJob(job, startedAt)) dispatched += 1;
        log("info", "intent review dispatched", { repo, issue: issue.number, jobId: job.id, revision });
      } catch (error) {
        log("error", "intent review enqueue failed", { repo, issue: issue.number, error: errorText(error) });
      }
    }
    if (dispatched >= config.maxIntentPerPoll) break;
  }
  return dispatched;
}

interface GitHubPullRequest {
  number: number;
  headRefOid?: string;
  isDraft?: boolean;
  createdAt?: string;
  author?: { login?: string };
}

/**
 * One poll for open pull requests outside the work loop: a non-draft PR created after the cutoff, not already
 * tracked by a work, gets one review job per current head for the independent reviewers. Work-loop PRs are
 * excluded because the work reconciler already queues their reviews.
 */
export async function dispatchPrReviews(deps: IssueDispatchDeps): Promise<number> {
  const { config, work, mesh, gh, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const reviewerMeshIds = work.reviewers.map((reviewer) => reviewer.meshId);
  const workPrs = new Set(deps.store.listWorks()
    .filter((record) => record.prNumber !== null)
    .map((record) => `${record.repo.toLowerCase()}#${record.prNumber}`));
  let dispatched = 0;

  for (const repo of config.reviewRepos) {
    let raw: string;
    try {
      raw = await gh([
        "pr", "list", "--repo", repo, "--state", "open",
        "--json", "number,headRefOid,isDraft,author,createdAt", "--limit", "100",
      ]);
    } catch (error) {
      log("error", "PR review dispatch poll failed", { repo, error: errorText(error) });
      continue;
    }

    let prs: GitHubPullRequest[];
    try {
      prs = (JSON.parse(raw) as GitHubPullRequest[]).filter((pr) =>
        Number.isInteger(pr?.number) && pr.number > 0
        && pr.isDraft !== true
        && typeof pr.headRefOid === "string" && /^[0-9a-f]{40}$/i.test(pr.headRefOid)
        && (config.notBefore === undefined
          || (typeof pr.createdAt === "string" && Date.parse(pr.createdAt) >= config.notBefore))
        && !workPrs.has(`${repo.toLowerCase()}#${pr.number}`));
    } catch {
      log("error", "PR review dispatch poll returned invalid JSON", { repo });
      continue;
    }

    for (const pr of prs) {
      if (dispatched >= config.maxReviewPerPoll) break;
      const authorLogin = String(pr.author?.login ?? "").toLowerCase();
      const excluded = [...new Set([
        work.authorMeshId,
        // A reviewer never reviews its own pull request.
        ...work.reviewers.filter((reviewer) => reviewer.login.toLowerCase() === authorLogin).map((reviewer) => reviewer.meshId),
      ])];
      try {
        const job = await mesh.enqueue({
          type: "review",
          target: { repo, kind: "pr", number: pr.number, headSha: pr.headRefOid },
          slots: Math.min(2, reviewerMeshIds.length),
          eligible: reviewerMeshIds,
          excluded,
          expiresAt: now() + DAY_MS,
          idempotencyKey: `review:${repo}#${pr.number}@${pr.headRefOid}`,
        });
        if ((job.state === "queued" || job.state === "reported") && freshJob(job, startedAt)) dispatched += 1;
        log("info", "PR review dispatched", { repo, pr: pr.number, jobId: job.id });
      } catch (error) {
        log("error", "PR review dispatch enqueue failed", { repo, pr: pr.number, error: errorText(error) });
      }
    }
    if (dispatched >= config.maxReviewPerPoll) break;
  }
  return dispatched;
}

export interface StartPipelineOptions {
  configPath: string;
  gatewayUrl: string;
  work: MeshJobsWorkConfig;
  presence: MeshJobsPresence | null;
  log: ConsumerLog;
  gh?: GhRunner;
  store?: WorkStore;
  now?: () => number;
}

/** Starts the poller when its config exists. Never throws; returns null when it is off. */
export function startPipeline(options: StartPipelineOptions): (() => void) | null {
  const { configPath, gatewayUrl, work, presence, log } = options;
  try {
    const config = loadPipelineConfig(configPath);
    if (!config) return null;
    if (!presence) {
      log("error", "issue dispatch needs mesh presence — off");
      return null;
    }
    const store = options.store ?? WorkStore.open();
    const mesh = new MeshJobsClient(gatewayUrl, () => presence.inbox(work.enqueuer)?.capability ?? null);
    const gh = options.gh ?? spawnGh();
    let running = false;

    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const deps = { config, work, store, mesh, gh, log, now: options.now };
        await Promise.all([dispatchApprovedIssues(deps), dispatchIntentReviews(deps), dispatchPrReviews(deps)]);
      } catch (error) {
        log("error", "issue dispatch tick failed", { error: errorText(error) });
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, config.intervalMs);
    log("info", "issue dispatch started", { repos: config.repos, intervalMs: config.intervalMs, author: work.author });
    return () => clearInterval(timer);
  } catch (error) {
    log("error", "issue dispatch failed to start — non-fatal", { error: errorText(error) });
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A replayed enqueue returns the existing job with its original createdAt; only a fresh job spends the cap. */
export function freshJob(job: { createdAt?: number }, startedAt: number): boolean {
  return typeof job.createdAt === "number" && job.createdAt >= startedAt - 5_000;
}
