import type { ReviewGitHubGet } from "./branch-snapshot";
import { classifyReviewPath } from "./eligibility";
import { validReviewBranch } from "./http-session";

export interface ReviewCiBinding { headSha: string; baseSha: string; baseBranch: string }
type Fields = Record<string, unknown>;
interface App { id: number; slug: string }
interface Run {
  id: number; workflowId: number; suiteId: number; attempt: number; name: string; path: string;
  event: string; status: string; conclusion: string | null; createdAt: string;
}
interface Suite { id: number; app: App }
interface Check {
  id: number; suiteId: number; app: App; name: string; status: string; conclusion: string | null;
  startedAt: string | null; completedAt: string | null;
}
interface Job {
  id: number; runId: number; attempt: number; name: string; status: string; conclusion: string | null;
  startedAt: string | null; completedAt: string | null;
}
interface Status { id: number; context: string; state: string; creatorId: number; createdAt: string; updatedAt: string }
interface TreeEntry { path: string; sha: string; type: string; mode: string }
interface Observations {
  tree: TreeEntry[]; runs: Run[]; suites: Suite[]; checks: Check[]; jobs: Job[];
  statuses: Status[]; statusState: string;
}
export interface ReviewCiSnapshot extends ReviewCiBinding {
  repo: string; number: number;
  ci: { complete: true; configured: boolean; headSha: string; results: string[] };
  observations: Observations;
}
type Collection = "subject" | "metadata" | "base" | "tree" | "runs" | "suites" | "checks" | "jobs" | "statuses";
type Reason = "malformed" | "snapshot_changed" | "tree_truncated" | "tree_limit" | "actions_limit"
  | "suites_limit" | "attempt_limit" | "page_limit" | "item_limit" | "string_limit" | "request_limit"
  | "count_mismatch" | "duplicate" | "partial_rerun_unproven" | "external_history_unproven"
  | "actions_suite_unproven" | "job_check_mismatch" | "aborted" | "read_failed";
export type ReviewCiResult = { ok: true; snapshot: ReviewCiSnapshot }
  | { ok: false; collection: Collection; reason: Reason };
const object = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const states = new Set(["queued", "requested", "waiting", "pending", "in_progress", "completed"]);
const conclusions = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]);
const statusStates = new Set(["pending", "success", "failure", "error"]);
class Refusal extends Error { constructor(readonly reason: Reason) { super(reason); } }
function fact(ok: unknown, reason: Reason = "malformed"): asserts ok { if (!ok) throw new Refusal(reason); }
function iso(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v.replace("Z", ".000Z");
}
function outcome(v: Fields): { status: string; conclusion: string | null } {
  fact(typeof v.status === "string" && states.has(v.status)
    && (v.conclusion === null || (typeof v.conclusion === "string" && conclusions.has(v.conclusion))));
  fact(v.status === "completed" ? v.conclusion !== null : v.conclusion === null);
  return { status: v.status, conclusion: v.conclusion };
}
function time(v: unknown): string | null { fact(v === null || iso(v)); return v; }
const greenOrState = (v: { status: string; conclusion: string | null }) =>
  v.status === "completed" ? v.conclusion!.toUpperCase() : "PENDING";
const actionApp = (v: App) => v.id === 15368 && v.slug === "github-actions";
const ordered = <T extends { id: number }>(items: T[]) => items.sort((a, b) => a.id - b.id);

/**
 * Partial, unwired observations. The injected GET port must authenticate, pin GitHub, refuse redirects
 * and bound bytes before parsing. No credential issuer, review receipt, atomic snapshot or merge action.
 */
export async function collectReviewCi(
  get: ReviewGitHubGet, repo: string, number: number, binding: ReviewCiBinding,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReviewCiResult> {
  let collection: Collection = "subject";
  if (!object(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || typeof get !== "function" || typeof repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || !integer(number) || number > 2147483647 || !object(binding) || !sha(binding.headSha) || !sha(binding.baseSha)
    || typeof binding.baseBranch !== "string" || !validReviewBranch(binding.baseBranch)) {
    return { ok: false, collection, reason: "malformed" };
  }
  const timeout = options.timeoutMs ?? 30_000;
  if (!integer(timeout) || timeout > 30_000) return { ok: false, collection, reason: "malformed" };
  // Capture inputs before the first await; later caller mutations cannot rebind a collection.
  const { headSha, baseSha, baseBranch } = binding;
  const root = `/repos/${repo}`, pr = `${root}/pulls/${number}`;
  const ref = `${root}/git/ref/heads/${encodeURIComponent(baseBranch)}`;
  const controller = new AbortController(), signal = controller.signal, start = performance.now();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let requests = 0, items = 0, strings = 0;
  function deadline(): void {
    if (performance.now() - start >= timeout) abort();
    fact(!signal.aborted, "aborted");
  }
  function text(v: unknown): string {
    deadline();
    fact(typeof v === "string" && v.length > 0 && v.length <= 65536);
    strings += v.length * 2; fact(strings <= 32 * 1024 * 1024, "string_limit");
    return v;
  }
  function app(v: unknown): App {
    fact(object(v) && integer(v.id));
    const slug = text(v.slug); fact(/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug));
    return { id: v.id, slug };
  }
  async function read(path: string): Promise<unknown> {
    deadline(); fact(++requests <= 200, "request_limit");
    let interrupted: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      interrupted = () => reject(new Refusal("aborted"));
      signal.addEventListener("abort", interrupted, { once: true });
    });
    try {
      const v = await Promise.race([get(path, signal), cancelled]);
      deadline(); return v;
    } finally { if (interrupted) signal.removeEventListener("abort", interrupted); }
  }
  async function anchor(final = false): Promise<void> {
    collection = "metadata";
    const v = await read(pr);
    fact(object(v) && v.number === number && v.state === "open" && v.draft === false
      && object(v.head) && v.head.sha === headSha && object(v.base) && v.base.sha === baseSha
      && v.base.ref === baseBranch && object(v.base.repo) && v.base.repo.full_name === repo,
    final ? "snapshot_changed" : "malformed");
    collection = "base";
    const b = await read(ref);
    fact(object(b) && b.ref === `refs/heads/${baseBranch}` && object(b.object)
      && b.object.type === "commit" && b.object.sha === baseSha, final ? "snapshot_changed" : "malformed");
  }
  async function pages<T extends { id: number }>(
    kind: Collection, path: string, field: string, parse: (v: unknown) => T, ceiling?: Reason,
    envelope?: (v: Fields) => void,
  ): Promise<T[]> {
    collection = kind;
    let total: number | undefined;
    const all: T[] = [], seen = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const v = await read(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      fact(object(v) && count(v.total_count) && Array.isArray(v[field]));
      const values = v[field];
      fact(values.length <= 100);
      if (ceiling) fact(v.total_count < 1000, ceiling);
      fact(v.total_count <= 1000, "page_limit");
      if (total === undefined) total = v.total_count;
      else fact(total === v.total_count, "count_mismatch");
      envelope?.(v);
      for (const value of values) {
        deadline(); fact(++items <= 10000, "item_limit");
        const item = parse(value);
        fact(!seen.has(item.id), "duplicate"); seen.add(item.id); all.push(item);
      }
      fact(all.length <= total, "count_mismatch");
      if (all.length === total) return ordered(all);
      fact(values.length === 100, "count_mismatch");
    }
    throw new Refusal("page_limit");
  }
  function parseRun(v: unknown): Run {
    fact(object(v) && integer(v.id) && integer(v.workflow_id) && integer(v.check_suite_id)
      && integer(v.run_attempt) && v.head_sha === headSha && object(v.repository)
      && v.repository.full_name === repo && iso(v.created_at));
    fact(v.run_attempt <= 5, "attempt_limit");
    const event = text(v.event), path = text(v.path), name = text(v.name);
    fact(/^[a-z0-9_]{1,100}$/.test(event) && classifyReviewPath(path) !== "invalid");
    return { id: v.id, workflowId: v.workflow_id, suiteId: v.check_suite_id, attempt: v.run_attempt,
      name, path, event, ...outcome(v), createdAt: v.created_at };
  }
  function parseSuite(v: unknown): Suite {
    fact(object(v) && integer(v.id) && v.head_sha === headSha);
    return { id: v.id, app: app(v.app) };
  }
  function parseCheck(v: unknown, suite: Suite): Check {
    fact(object(v) && integer(v.id) && v.head_sha === headSha && object(v.check_suite) && v.check_suite.id === suite.id);
    const owner = app(v.app);
    fact(owner.id === suite.app.id && owner.slug === suite.app.slug);
    return { id: v.id, suiteId: suite.id, app: owner, name: text(v.name), ...outcome(v),
      startedAt: time(v.started_at), completedAt: time(v.completed_at) };
  }
  function parseJob(v: unknown, run: Run, attempt: number): Job {
    fact(object(v) && integer(v.id) && v.run_id === run.id && v.run_attempt === attempt && v.head_sha === headSha);
    return { id: v.id, runId: run.id, attempt, name: text(v.name), ...outcome(v),
      startedAt: time(v.started_at), completedAt: time(v.completed_at) };
  }
  function parseStatus(v: unknown): Status {
    fact(object(v) && integer(v.id) && typeof v.state === "string" && statusStates.has(v.state)
      && object(v.creator) && integer(v.creator.id) && iso(v.created_at) && iso(v.updated_at));
    return { id: v.id, context: text(v.context), state: v.state, creatorId: v.creator.id,
      createdAt: v.created_at, updatedAt: v.updated_at };
  }
  async function tree(): Promise<TreeEntry[]> {
    collection = "tree";
    const v = await read(`${root}/git/trees/${baseSha}?recursive=1`);
    fact(object(v) && v.sha === baseSha && typeof v.truncated === "boolean" && Array.isArray(v.tree));
    fact(!v.truncated, "tree_truncated"); fact(v.tree.length <= 20000, "tree_limit");
    const seen = new Set<string>(), all: TreeEntry[] = [];
    for (const e of v.tree) {
      deadline();
      fact(object(e) && sha(e.sha) && typeof e.type === "string" && typeof e.mode === "string");
      const path = text(e.path);
      fact(classifyReviewPath(path) !== "invalid"
        && ((e.type === "blob" && ["100644", "100755", "120000"].includes(e.mode))
          || (e.type === "tree" && e.mode === "040000") || (e.type === "commit" && e.mode === "160000")));
      fact(!seen.has(path), "duplicate"); seen.add(path);
      all.push({ path, sha: e.sha, type: e.type, mode: e.mode });
    }
    return all.sort((a, b) => a.path.localeCompare(b.path));
  }
  async function scan(): Promise<{ observations: Observations; results: string[]; configured: boolean }> {
    const entries = await tree();
    const runs = await pages("runs", `${root}/actions/runs?head_sha=${headSha}`, "workflow_runs", parseRun, "actions_limit");
    const suites = await pages("suites", `${root}/commits/${headSha}/check-suites`, "check_suites", parseSuite, "suites_limit");
    const checks: Check[] = [], checkIds = new Set<number>();
    for (const suite of suites) {
      const part = await pages("checks", `${root}/check-suites/${suite.id}/check-runs?filter=all`, "check_runs", v => parseCheck(v, suite));
      for (const c of part) { fact(!checkIds.has(c.id), "duplicate"); checkIds.add(c.id); checks.push(c); }
    }
    let statusState: string | undefined;
    const statuses = await pages("statuses", `${root}/commits/${headSha}/status`, "statuses", parseStatus, undefined, v => {
      fact(v.sha === headSha && typeof v.state === "string" && statusStates.has(v.state));
      if (statusState === undefined) statusState = v.state;
      else fact(statusState === v.state, "snapshot_changed");
    });
    const contexts = new Set<string>();
    for (const s of statuses) {
      fact(!contexts.has(s.context), "duplicate"); contexts.add(s.context);
    }
    const aggregateStatus = statuses.some(s => s.state === "failure" || s.state === "error") ? "failure"
      : !statuses.length || statuses.some(s => s.state === "pending") ? "pending" : "success";
    fact(statusState === aggregateStatus);
    const suiteMap = new Map(suites.map(v => [v.id, v]));
    const runSuites = new Set(runs.map(v => v.suiteId));
    for (const suite of suites) if (actionApp(suite.app)) fact(runSuites.has(suite.id), "actions_suite_unproven");
    const workflowNames = new Map<number, string>(), latest = new Map<string, Run>();
    for (const r of runs) {
      collection = "runs";
      fact(actionApp(suiteMap.get(r.suiteId)?.app ?? { id: 0, slug: "" }), "actions_suite_unproven");
      const shape = JSON.stringify([r.name, r.path]), prior = workflowNames.get(r.workflowId);
      fact(prior === undefined || prior === shape);
      workflowNames.set(r.workflowId, shape);
      const key = `${r.workflowId}:${r.event}`, old = latest.get(key);
      if (!old || r.createdAt > old.createdAt || (r.createdAt === old.createdAt && r.id > old.id)) latest.set(key, r);
    }
    const results: string[] = [], jobs: Job[] = [], jobIds = new Set<number>();
    const checkMap = new Map(checks.map(v => [v.id, v]));
    for (const run of latest.values()) {
      let firstNames: string | undefined, current: Job[] = [];
      for (let attempt = 1; attempt <= run.attempt; attempt++) {
        const part = await pages("jobs", `${root}/actions/runs/${run.id}/attempts/${attempt}/jobs`,
          "jobs", v => parseJob(v, run, attempt));
        const names = part.map(v => v.name).sort();
        fact(new Set(names).size === names.length, "duplicate");
        const set = JSON.stringify(names);
        if (firstNames === undefined) firstNames = set;
        else fact(firstNames === set, "partial_rerun_unproven");
        for (const j of part) {
          fact(!jobIds.has(j.id), "duplicate"); jobIds.add(j.id); jobs.push(j);
          const c = checkMap.get(j.id);
          fact(c && c.suiteId === run.suiteId && actionApp(c.app) && c.name === j.name && c.status === j.status
            && c.conclusion === j.conclusion && c.startedAt === j.startedAt && c.completedAt === j.completedAt, "job_check_mismatch");
        }
        current = part;
      }
      const aggregate = greenOrState(run);
      results.push(aggregate);
      // An empty job set supplies no execution proof even if an aggregate reports success.
      if (!current.length) results.push("UNPROVEN");
      for (const j of current) results.push(greenOrState(j));
    }
    collection = "checks";
    const external = new Set<string>();
    for (const c of checks) if (!actionApp(c.app)) {
      const key = JSON.stringify([c.app.id, c.name]);
      fact(!external.has(key), "external_history_unproven"); external.add(key);
      results.push(greenOrState(c));
    }
    if (statuses.length) results.push(statusState!.toUpperCase());
    return { configured: entries.some(e => e.type === "blob" && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(e.path))
      || !!(runs.length || suites.length || checks.length || statuses.length), results,
    observations: { tree: entries, runs, suites, checks: ordered(checks), jobs: ordered(jobs), statuses, statusState: statusState! } };
  }
  try {
    await anchor();
    const first = await scan(), second = await scan();
    fact(JSON.stringify(first) === JSON.stringify(second), "snapshot_changed");
    await anchor(true); deadline();
    return { ok: true, snapshot: { repo, number, headSha, baseSha, baseBranch,
      ci: { complete: true, configured: first.configured, headSha, results: first.results }, observations: first.observations } };
  } catch (error) {
    return { ok: false, collection, reason: signal.aborted ? "aborted" : error instanceof Refusal ? error.reason : "read_failed" };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort); abort();
  }
}
