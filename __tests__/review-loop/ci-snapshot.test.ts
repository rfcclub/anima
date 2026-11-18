import { describe, expect, test } from "bun:test";
import { collectReviewCi } from "../../src/review-loop/ci-snapshot";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";
import { createReviewGitHubCiGet } from "../../src/review-loop/github-ci";

const HEAD = "a".repeat(40), BASE = "b".repeat(40), REPO = "rfcclub/anima", ROOT = `/repos/${REPO}`;
const BINDING = { headSha: HEAD, baseSha: BASE, baseBranch: "feature/base" };
const TIME = "2026-10-29T20:00:00Z";
const paths = {
  pr: `${ROOT}/pulls/45`, ref: `${ROOT}/git/ref/heads/feature%2Fbase`,
  tree: `${ROOT}/git/trees/${BASE}?recursive=1`,
  runs: `${ROOT}/actions/runs?head_sha=${HEAD}&per_page=100&page=1`,
  suites: `${ROOT}/commits/${HEAD}/check-suites?per_page=100&page=1`,
  status: `${ROOT}/commits/${HEAD}/status?per_page=100&page=1`,
  checks: (suite = 21) => `${ROOT}/check-suites/${suite}/check-runs?filter=all&per_page=100&page=1`,
  jobs: (run = 11, attempt = 1) => `${ROOT}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=1`,
};
const app = () => ({ id: 15368, slug: "github-actions" });
function run(id = 11, workflow = 1, suite = 21, event = "pull_request") {
  return { id, workflow_id: workflow, check_suite_id: suite, head_sha: HEAD, run_attempt: 1,
    name: `workflow-${workflow}`, path: `.github/workflows/${workflow}.yml`, event,
    repository: { full_name: REPO }, status: "completed", conclusion: "success", created_at: TIME };
}
function check(id = 31, suite = 21, name = "test") {
  return { id, name, head_sha: HEAD, check_suite: { id: suite }, app: app(),
    status: "completed", conclusion: "success", started_at: TIME, completed_at: TIME };
}
function job(id = 31, runId = 11, attempt = 1, name = "test") {
  return { id, name, head_sha: HEAD, run_id: runId, run_attempt: attempt,
    status: "completed", conclusion: "success", started_at: TIME, completed_at: TIME };
}
function data() {
  return {
    [paths.pr]: { number: 45, state: "open", draft: false, head: { sha: HEAD },
      base: { sha: BASE, ref: "feature/base", repo: { full_name: REPO } } },
    [paths.ref]: { ref: "refs/heads/feature/base", object: { type: "commit", sha: BASE } },
    [paths.tree]: { sha: BASE, truncated: false, tree: [
      { path: ".github/workflows/ci.yml", type: "blob", mode: "100644", sha: "c".repeat(40) },
      { path: "src/main.ts", type: "blob", mode: "100644", sha: "d".repeat(40) },
    ] },
    [paths.runs]: { total_count: 2, workflow_runs: [run(), run(12, 2, 22, "push")] },
    [paths.suites]: { total_count: 2, check_suites: [
      { id: 21, head_sha: HEAD, app: app() }, { id: 22, head_sha: HEAD, app: app() },
    ] },
    [paths.checks()]: { total_count: 1, check_runs: [check()] },
    [paths.checks(22)]: { total_count: 1, check_runs: [check(32, 22, "orca")] },
    [paths.jobs()]: { total_count: 1, jobs: [job()] },
    [paths.jobs(12)]: { total_count: 1, jobs: [job(32, 12, 1, "orca")] },
    [paths.status]: { sha: HEAD, state: "pending", total_count: 0, statuses: [] },
  } as Record<string, any>;
}
function fixture(change?: (records: ReturnType<typeof data>) => void,
  observe?: (path: string, occurrence: number, value: any) => any) {
  const records = data(); change?.(records);
  const calls: string[] = [], signals: AbortSignal[] = [], counts = new Map<string, number>();
  const get = async (path: string, signal: AbortSignal): Promise<unknown> => {
    calls.push(path); signals.push(signal);
    const occurrence = (counts.get(path) ?? 0) + 1; counts.set(path, occurrence);
    if (!(path in records)) throw Error("fixture unexpected path: " + path);
    const value = structuredClone(records[path]);
    return observe ? observe(path, occurrence, value) : value;
  };
  return { records, calls, signals, get, collect: (options = {}) => collectReviewCi(get, REPO, 45, BINDING, options) };
}
async function refused(f: ReturnType<typeof fixture>, reason: string, options = {}) {
  const result = await f.collect(options);
  expect(result).toMatchObject({ ok: false, reason });
  expect(result).not.toHaveProperty("snapshot");
  return result;
}
function absent(d: ReturnType<typeof data>) {
  d[paths.tree].tree = [];
  d[paths.runs] = { total_count: 0, workflow_runs: [] };
  d[paths.suites] = { total_count: 0, check_suites: [] };
}

describe("bounded CI facts CIC-1..8", () => {
  test("CIC-1 CIC-7 complete head/base observations retain two workflow events and green results", async () => {
    const f = fixture(), result = await f.collect();
    expect(result.ok).toBe(true); if (!result.ok) throw Error("expected CI facts");
    expect(result.snapshot).toMatchObject({ repo: REPO, number: 45, ...BINDING,
      ci: { complete: true, configured: true, headSha: HEAD } });
    expect(result.snapshot.ci.results.length).toBeGreaterThan(0);
    expect(result.snapshot.ci.results.every(x => x === "SUCCESS")).toBe(true);
    expect(result.snapshot.observations.runs).toHaveLength(2);
    expect(result.snapshot.observations.checks).toHaveLength(2);
    expect(f.calls.filter(x => x === paths.tree)).toHaveLength(2);
    expect(f.calls.filter(x => x === paths.runs)).toHaveLength(2);
    expect(f.calls.filter(x => x === paths.pr)).toHaveLength(2);
    expect(f.calls.filter(x => x === paths.ref)).toHaveLength(2);
  });
  test("CIC-7 complete absence alone proves configured false", async () => {
    const result = await fixture(absent).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: false, complete: true, results: [] } } });
  });
  test("CIC-7 BASE workflow with no run remains configured and has no green result", async () => {
    const result = await fixture(d => { absent(d); d[paths.tree] = data()[paths.tree]; }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: true, results: [] } } });
  });
  test("CIC-7 observations configure CI even without BASE YAML", async () => {
    const result = await fixture(d => { d[paths.tree].tree = []; }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: true } } });
  });
  test.each([".github/workflows/X.YAML", ".GitHub/workflows/x.yml"])("CIC-2 conservative YAML spelling %s configures CI", async path => {
    const result = await fixture(d => { absent(d); d[paths.tree].tree = [
      { path, type: "blob", mode: "100644", sha: "c".repeat(40) },
    ]; }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: true } } });
  });
  test.each(["README.md", ".github/workflows/sub/x.yml", "src/ci.yml"])("CIC-2 unrelated path %s does not configure CI", async path => {
    const result = await fixture(d => { absent(d); d[paths.tree].tree = [
      { path, type: "blob", mode: "100644", sha: "c".repeat(40) },
    ]; }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: false } } });
  });
  const badSubjects: Array<(d: ReturnType<typeof data>) => void> = [
    d => { d[paths.pr].draft = true; }, d => { d[paths.pr].state = "closed"; },
    d => { d[paths.pr].number = 46; }, d => { d[paths.pr].head.sha = BASE; },
    d => { d[paths.pr].base.sha = HEAD; }, d => { d[paths.pr].base.ref = "master"; },
    d => { d[paths.pr].base.repo.full_name = "evil/anima"; },
    d => { d[paths.ref].object.sha = HEAD; }, d => { d[paths.ref].object.type = "tag"; },
    d => { d[paths.ref].ref = "refs/tags/feature/base"; },
  ];
  test.each(badSubjects.map((change, i) => [i, change] as const))("CIC-1 unauthorized/stale anchor shape %s refuses", async (_i, change) => {
    expect((await fixture(change).collect()).ok).toBe(false);
  });
  test.each(["headSha", "baseSha", "baseBranch"])("CIC-1 malformed binding %s refuses before network", async key => {
    const f = fixture(), result = await collectReviewCi(f.get, REPO, 45, { ...BINDING, [key]: "bad.." });
    expect(result.ok).toBe(false); expect(f.calls).toEqual([]);
  });
  test.each([["evil/anima", 45], [REPO, 0], [REPO, 1.5], [REPO, 2147483648]] as const)(
    "CIC-1 invalid subject %s/%s refuses", async (repo, number) => {
      const f = fixture(); expect((await collectReviewCi(f.get, repo, number, BINDING)).ok).toBe(false);
      expect(f.calls).toEqual([]);
    });
  test("CIC-2 truncated BASE tree never proves absence", async () => {
    await refused(fixture(d => { absent(d); d[paths.tree].truncated = true; }), "tree_truncated");
  });
  test.each([
    d => { d[paths.tree].sha = HEAD; }, d => { delete d[paths.tree].truncated; },
    d => { d[paths.tree].tree[0].sha = "bad"; }, d => { d[paths.tree].tree[0].path = "../x"; },
    d => { d[paths.tree].tree[0].type = "unknown"; }, d => { d[paths.tree].tree[0].mode = "unknown"; },
  ] as Array<(d: ReturnType<typeof data>) => void>)("CIC-2 malformed or wrong BASE tree refuses", async change => {
    await refused(fixture(change), "malformed");
  });
  test("CIC-2 duplicate tree path refuses", async () => {
    await refused(fixture(d => { d[paths.tree].tree.push(d[paths.tree].tree[0]); }), "duplicate");
  });
  test("CIC-2 tree entry ceiling is explicit", async () => {
    await refused(fixture(d => { d[paths.tree].tree = Array.from({ length: 20001 }, (_, i) =>
      ({ path: `src/${i}`, type: "blob", mode: "100644", sha: BASE })); }), "tree_limit");
  });
  test.each([["runs", "workflow_runs", "actions_limit"], ["suites", "check_suites", "suites_limit"]] as const)(
    "CIC-5 %s 1000-result ceiling refuses before clipping", async (key, _items, reason) => {
      await refused(fixture(d => { d[paths[key]].total_count = 1000; }), reason);
    });
  test.each(["runs", "suites", "status"] as const)("CIC-5 %s count mismatch refuses", async key => {
    await refused(fixture(d => { d[paths[key]].total_count++; }), "count_mismatch");
  });
  test("CIC-5 duplicate run ID refuses", async () => {
    await refused(fixture(d => { d[paths.runs].workflow_runs[1].id = 11; }), "duplicate");
  });
  test.each(["run_attempt", "workflow_id", "check_suite_id"])("CIC-3 invalid run %s refuses", async key => {
    await refused(fixture(d => { d[paths.runs].workflow_runs[0][key] = 0; }), "malformed");
  });
  test.each([
    d => { d[paths.runs].workflow_runs[0].head_sha = BASE; },
    d => { d[paths.runs].workflow_runs[0].repository.full_name = "evil/anima"; },
    d => { d[paths.runs].workflow_runs[0].created_at = "2026-02-30T20:00:00Z"; },
    d => { d[paths.runs].workflow_runs[0].event = "x y"; },
    d => { d[paths.runs].workflow_runs[0].status = "unknown"; },
    d => { d[paths.runs].workflow_runs[0].conclusion = "unknown"; },
  ] as Array<(d: ReturnType<typeof data>) => void>)("CIC-3 malformed run identity/time/state refuses", async change => {
    await refused(fixture(change), "malformed");
  });
  test("CIC-3 same workflow ID with different event is not collapsed", async () => {
    const result = await fixture(d => {
      const second = d[paths.runs].workflow_runs[1]; second.workflow_id = 1;
      second.name = "workflow-1"; second.path = ".github/workflows/1.yml";
      second.conclusion = "failure";
    }).collect();
    expect(result.ok).toBe(true); if (result.ok) {
      expect(result.snapshot.ci.results).toContain("FAILURE");
      expect(result.snapshot.ci.results).toHaveLength(4);
    }
  });
  test("CIC-3 two IDs with the same workflow name remain distinct", async () => {
    const result = await fixture(d => {
      d[paths.runs].workflow_runs[1].name = "workflow-1"; d[paths.runs].workflow_runs[1].conclusion = "failure";
      d[paths.runs].workflow_runs[1].event = "pull_request";
    }).collect();
    expect(result.ok).toBe(true); if (result.ok) {
      expect(result.snapshot.ci.results).toContain("FAILURE");
      expect(result.snapshot.ci.results).toHaveLength(4);
    }
  });
  test.each(["failure", "skipped", "neutral", "cancelled", "timed_out", "action_required", "stale"])(
    "CIC-7 %s run never becomes SUCCESS", async conclusion => {
      const result = await fixture(d => { d[paths.runs].workflow_runs[0].conclusion = conclusion; }).collect();
      expect(result.ok).toBe(true); if (result.ok) expect(result.snapshot.ci.results).toContain(conclusion.toUpperCase());
    });
  test("CIC-7 pending run remains non-green", async () => {
    const result = await fixture(d => {
      Object.assign(d[paths.runs].workflow_runs[0], { status: "in_progress", conclusion: null });
    }).collect();
    expect(result.ok).toBe(true); if (result.ok) expect(result.snapshot.ci.results).toContain("PENDING");
  });
  test("CIC-4 same-name external App check cannot disappear into Actions", async () => {
    const result = await fixture(d => {
      const external = check(33, 23); external.app = { id: 999, slug: "external" };
      external.conclusion = "failure";
      d[paths.suites].check_suites.push({ id: 23, head_sha: HEAD, app: external.app });
      d[paths.suites].total_count++;
      d[paths.checks(23)] = { total_count: 1, check_runs: [external] };
    }).collect();
    expect(result.ok).toBe(true); if (result.ok) expect(result.snapshot.ci.results).toContain("FAILURE");
  });
  test("CIC-4 ambiguous external history refuses rather than invent latest order", async () => {
    await refused(fixture(d => {
      const records = [check(33, 23), check(34, 23)];
      records.forEach(r => { r.app = { id: 999, slug: "external" }; });
      d[paths.suites].check_suites.push({ id: 23, head_sha: HEAD, app: records[0]!.app });
      d[paths.suites].total_count++;
      d[paths.checks(23)] = { total_count: 2, check_runs: records };
    }), "external_history_unproven");
  });
  test.each(["id", "head_sha", "app", "check_suite"])("CIC-4 forged check %s refuses", async key => {
    const result = await fixture(d => { d[paths.checks()].check_runs[0][key] = null; }).collect();
    expect(result.ok).toBe(false);
  });
  test("CIC-4 suite without matching Actions run refuses", async () => {
    await refused(fixture(d => { d[paths.runs].total_count = 1; d[paths.runs].workflow_runs.pop(); }), "actions_suite_unproven");
  });
  test("CIC-4 job/check mismatch refuses", async () => {
    await refused(fixture(d => { d[paths.jobs()].jobs[0].name = "another"; }), "job_check_mismatch");
  });
  test("CIC-3 same-name full rerun maps latest job IDs; old red check stays evidence", async () => {
    const result = await fixture(d => {
      d[paths.runs].workflow_runs[0].run_attempt = 2;
      d[paths.checks()].check_runs[0].conclusion = "failure";
      d[paths.checks()].check_runs.push(check(35)); d[paths.checks()].total_count++;
      d[paths.jobs(11, 2)] = { total_count: 1, jobs: [job(35, 11, 2)] };
      d[paths.jobs()].jobs[0].conclusion = "failure";
    }).collect();
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.snapshot.observations.checks).toHaveLength(3);
    expect(result.snapshot.ci.results.every(x => x === "SUCCESS")).toBe(true);
  });
  test("CIC-3 unexplained partial rerun refuses even with success aggregate", async () => {
    await refused(fixture(d => {
      d[paths.runs].workflow_runs[0].run_attempt = 2;
      d[paths.jobs(11, 2)] = { total_count: 0, jobs: [] };
    }), "partial_rerun_unproven");
  });
  test("CIC-3 attempt ceiling refuses", async () => {
    await refused(fixture(d => { d[paths.runs].workflow_runs[0].run_attempt = 6; }), "attempt_limit");
  });
  test.each(["pending", "failure", "success"])("CIC-4 complete server status aggregate %s is retained", async state => {
    const result = await fixture(d => {
      absent(d); d[paths.status] = { sha: HEAD, state, total_count: 1,
        statuses: [{ id: 41, context: "deploy", state, creator: { id: 8 }, created_at: TIME, updated_at: TIME }] };
    }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: true, results: [state.toUpperCase()] } } });
  });
  test.each([
    d => { d[paths.status].sha = BASE; }, d => { d[paths.status].state = "neutral"; },
  ] as Array<(d: ReturnType<typeof data>) => void>)("CIC-4 malformed status aggregate refuses", async change => {
    await refused(fixture(change), "malformed");
  });
  test.each(["runs", "suites", "status", "tree"] as const)("CIC-5 %s drift between complete passes refuses", async key => {
    const f = fixture(undefined, (path, occurrence, value) => {
      if (path === paths[key] && occurrence === 2) {
        if (key === "runs") value.workflow_runs[0].run_attempt = 2;
        else if (key === "suites") value.check_suites[0].app.slug = "changed";
        else if (key === "status") value.state = "success";
        else value.tree[1].sha = HEAD;
      }
      return value;
    });
    expect((await f.collect()).ok).toBe(false);
  });
  test.each(["pr", "ref"] as const)("CIC-5 final %s anchor movement refuses", async key => {
    const f = fixture(undefined, (path, occurrence, value) => {
      if (path === paths[key] && occurrence === 2) {
        if (key === "pr") value.head.sha = BASE; else value.object.sha = HEAD;
      }
      return value;
    });
    await refused(f, "snapshot_changed");
  });
  test("CIC-6 abort before collection obtains no observations", async () => {
    const c = new AbortController(); c.abort(); const f = fixture();
    await refused(f, "aborted", { signal: c.signal }); expect(f.calls).toEqual([]);
  });
  test("CIC-6 port error is content-free", async () => {
    const result = await collectReviewCi(async () => { throw Error("PRIVATE_TOKEN"); }, REPO, 45, BINDING);
    expect(result).toMatchObject({ ok: false, reason: "read_failed" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN");
  });
  test("CIC-6 a hanging port ignoring abort still has bounded refusal and cancellation", async () => {
    let signal: AbortSignal | undefined;
    const result = await collectReviewCi(async (_path, s) => { signal = s; return new Promise(() => {}); },
      REPO, 45, BINDING, { timeoutMs: 10 });
    expect(result).toMatchObject({ ok: false, reason: "aborted" }); expect(signal?.aborted).toBe(true);
  });
  test.each([0, -1, 30001, 1.5])("CIC-6 invalid timeout %s refuses before reads", async timeoutMs => {
    const f = fixture(); await refused(f, "malformed", { timeoutMs }); expect(f.calls).toEqual([]);
  });
  test("CIC-8 facts are partial, unwired and cannot grant automatic merge", async () => {
    const result = await fixture().collect(); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.snapshot).not.toHaveProperty("merge");
    expect(auditReviewEligibility(result.snapshot, { apps: { eli: "eli-gotako[bot]" }, bindings: [],
      now: 0, cooldownMs: 0 })).toEqual({ automaticMerge: false, reasons: ["atomic_base_guard_unproven", "malformed_snapshot"] });
  });
  function statusPages(d: ReturnType<typeof data>, count: number) {
    absent(d);
    const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, context: `context-${i}`,
      state: "success", creator: { id: 8 }, created_at: TIME, updated_at: TIME }));
    for (let page = 1; page <= Math.ceil(count / 100); page++) {
      d[paths.status.replace("&page=1", `&page=${page}`)] = {
        sha: HEAD, state: "success", total_count: count, statuses: rows.slice((page - 1) * 100, page * 100),
      };
    }
  }
  test("CIC-5 complete status pagination retains all 101 distinct contexts", async () => {
    const f = fixture(d => statusPages(d, 101)), result = await f.collect();
    expect(result.ok).toBe(true); if (result.ok) expect(result.snapshot.observations.statuses).toHaveLength(101);
    expect(f.calls.filter(p => p === paths.status.replace("&page=1", "&page=2"))).toHaveLength(2);
  });
  test.each(["count", "state", "sha", "duplicate", "empty"] as const)(
    "CIC-5 status page boundary %s refuses instead of clipping", async kind => {
      const f = fixture(d => {
        statusPages(d, 101);
        const second = d[paths.status.replace("&page=1", "&page=2")];
        if (kind === "count") second.total_count = 100;
        if (kind === "state") second.state = "failure";
        if (kind === "sha") second.sha = BASE;
        if (kind === "duplicate") second.statuses[0].id = 1;
        if (kind === "empty") second.statuses = [];
      });
      expect((await f.collect()).ok).toBe(false);
    });
  test("CIC-5 page ceiling refuses a 1001-status collection", async () => {
    await refused(fixture(d => statusPages(d, 1001)), "page_limit");
  });
  test("CIC-6 request ceiling includes both passes and per-suite requests", async () => {
    const f = fixture(d => {
      absent(d);
      const suites = Array.from({ length: 96 }, (_, i) => ({ id: 100 + i, head_sha: HEAD,
        app: { id: 999, slug: "external" } }));
      d[paths.suites] = { total_count: suites.length, check_suites: suites };
      for (const suite of suites) d[paths.checks(suite.id)] = { total_count: 0, check_runs: [] };
    });
    await refused(f, "request_limit"); expect(f.calls).toHaveLength(200);
  });
  test("CIC-6 observed string budget is shared across collections", async () => {
    await refused(fixture(d => {
      statusPages(d, 1000);
      for (let page = 1; page <= 10; page++) for (const row of
        d[paths.status.replace("&page=1", `&page=${page}`)].statuses) row.context = "x".repeat(60000) + row.id;
    }), "string_limit");
  });
  test.each(["failure", "pending"] as const)("CIC-4 regression: contradictory combined status %s cannot grant green", async state => {
    await refused(fixture(d => {
      absent(d); d[paths.status] = { sha: HEAD, state: "success", total_count: 1,
        statuses: [{ id: 41, context: "deploy", state, creator: { id: 8 }, created_at: TIME, updated_at: TIME }] };
    }), "malformed");
  });
  test("CIC-4 regression: duplicate status context cannot be silently aggregated", async () => {
    await refused(fixture(d => {
      statusPages(d, 101);
      d[paths.status.replace("&page=1", "&page=2")].statuses[0].context = "context-0";
    }), "duplicate");
  });
  test.each(["failure", "skipped", "neutral"] as const)("CIC-3 successful aggregate with %s current job is not green", async conclusion => {
    const result = await fixture(d => {
      d[paths.jobs()].jobs[0].conclusion = conclusion;
      d[paths.checks()].check_runs[0].conclusion = conclusion;
    }).collect();
    expect(result.ok).toBe(true); if (result.ok) expect(result.snapshot.ci.results).toContain(conclusion.toUpperCase());
  });
  test("CIC-3 empty successful job set cannot prove green", async () => {
    const result = await fixture(d => { d[paths.jobs()] = { total_count: 0, jobs: [] }; }).collect();
    expect(result.ok).toBe(true); if (result.ok) expect(result.snapshot.ci.results).toContain("UNPROVEN");
  });
  test("CIC-3 latest workflow run wins by created_at before ID and retains old red facts", async () => {
    const result = await fixture(d => {
      const newer = d[paths.runs].workflow_runs[0], older = d[paths.runs].workflow_runs[1];
      newer.created_at = "2026-10-29T20:01:00Z";
      older.workflow_id = 1; older.event = "pull_request"; older.name = newer.name; older.path = newer.path;
      older.conclusion = "failure";
    }).collect();
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.snapshot.observations.runs).toHaveLength(2);
    expect(result.snapshot.ci.results.every(x => x === "SUCCESS")).toBe(true);
  });
  test.each(["name", "path"] as const)("CIC-3 workflow ID with inconsistent %s refuses", async field => {
    await refused(fixture(d => {
      const second = d[paths.runs].workflow_runs[1]; second.workflow_id = 1;
      second.name = "workflow-1"; second.path = ".github/workflows/1.yml"; second[field] = "different";
    }), "malformed");
  });
  test("CIC-5 checks and jobs both paginate 101 IDs without dropping one", async () => {
    const f = fixture(d => {
      const checks = Array.from({ length: 101 }, (_, i) => check(1000 + i, 21, `job-${i}`));
      const jobs = Array.from({ length: 101 }, (_, i) => job(1000 + i, 11, 1, `job-${i}`));
      for (let page = 1; page <= 2; page++) {
        d[paths.checks().replace("&page=1", `&page=${page}`)] =
          { total_count: 101, check_runs: checks.slice((page - 1) * 100, page * 100) };
        d[paths.jobs().replace("&page=1", `&page=${page}`)] =
          { total_count: 101, jobs: jobs.slice((page - 1) * 100, page * 100) };
      }
    });
    const result = await f.collect();
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.snapshot.observations.jobs).toHaveLength(102);
    expect(result.snapshot.observations.checks).toHaveLength(102);
    expect(f.calls).toContain(paths.jobs().replace("&page=1", "&page=2"));
    expect(f.calls).toContain(paths.checks().replace("&page=1", "&page=2"));
  });
  test("CIC-6 exactly 200 GETs succeed; the ceiling is inclusive", async () => {
    const f = fixture(d => {
      absent(d);
      const suites = Array.from({ length: 94 }, (_, i) => ({ id: 100 + i, head_sha: HEAD,
        app: { id: 999, slug: "external" } }));
      d[paths.suites] = { total_count: suites.length, check_suites: suites };
      for (const suite of suites) d[paths.checks(suite.id)] = { total_count: 0, check_runs: [] };
    });
    expect((await f.collect()).ok).toBe(true); expect(f.calls).toHaveLength(200);
  });
  test("CIC-6 CI item budget applies across both complete passes", async () => {
    await refused(fixture(d => {
      absent(d);
      const suites = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, head_sha: HEAD,
        app: { id: 999, slug: "external" } }));
      d[paths.suites] = { total_count: suites.length, check_suites: suites };
      for (const suite of suites) for (let page = 1; page <= 10; page++) {
        const rows = Array.from({ length: 100 }, (_, i) => {
          const c = check(suite.id * 10000 + page * 100 + i, suite.id, `${suite.id}-${page}-${i}`);
          c.app = suite.app; return c;
        });
        d[paths.checks(suite.id).replace("&page=1", `&page=${page}`)] = { total_count: 1000, check_runs: rows };
      }
    }), "item_limit");
  });
  test("CIC-3 duplicate current job names refuse even with distinct matching check IDs", async () => {
    await refused(fixture(d => {
      d[paths.jobs()] = { total_count: 2, jobs: [job(), job(35)] };
      d[paths.checks()] = { total_count: 2, check_runs: [check(), check(35)] };
    }), "duplicate");
  });
  test("CIC-5 overfull check page refuses although the declared count matches", async () => {
    await refused(fixture(d => {
      d[paths.checks()] = { total_count: 101, check_runs: Array.from({ length: 101 },
        (_, i) => check(1000 + i, 21, `job-${i}`)) };
    }), "malformed");
  });
  test.each([["suite", "id"], ["suite", "slug"], ["check", "id"], ["check", "slug"]] as const)(
    "CIC-4 Actions-looking %s with wrong App %s refuses", async (kind, field) => {
      const result = await fixture(d => {
        const a = kind === "suite" ? d[paths.suites].check_suites[0].app : d[paths.checks()].check_runs[0].app;
        a[field] = field === "id" ? 999 : "external";
      }).collect();
      expect(result.ok).toBe(false);
    });
  test("CIH-7 suite membership requires the bound head", async () => {
    await refused(fixture(d => { d[paths.suites].check_suites[0].head_sha = BASE; }), "malformed");
  });
  test("CIH-7 check_suite.id must equal the suite being fetched", async () => {
    await refused(fixture(d => { d[paths.checks()].check_runs[0].check_suite.id = 22; }), "malformed");
  });
  test("CIH-7 a check App cannot disagree with its external suite App", async () => {
    await refused(fixture(d => {
      absent(d);
      d[paths.suites] = { total_count: 1, check_suites: [{ id: 23, head_sha: HEAD, app: { id: 999, slug: "external" } }] };
      d[paths.checks(23)] = { total_count: 1, check_runs: [check(33, 23)] };
    }), "malformed");
  });
  test.each([["run_id", 12], ["run_attempt", 2], ["head_sha", BASE]] as const)(
    "CIH-7 job %s must match its requested run/attempt/head", async (field, value) => {
      await refused(fixture(d => { d[paths.jobs()].jobs[0][field] = value; }), "malformed");
    });
  test("CIH-7 an Actions run cannot borrow a non-Actions suite even without jobs", async () => {
    await refused(fixture(d => {
      d[paths.suites].check_suites[0].app = { id: 999, slug: "external" };
      d[paths.checks()] = { total_count: 0, check_runs: [] };
      d[paths.jobs()] = { total_count: 0, jobs: [] };
    }), "actions_suite_unproven");
  });
  test("CIH-7 duplicate job ID across two attempts refuses before projection", async () => {
    await refused(fixture(d => {
      d[paths.runs].workflow_runs[0].run_attempt = 2;
      d[paths.jobs(11, 2)] = { total_count: 1, jobs: [job(31, 11, 2)] };
    }), "duplicate");
  });
  test("CIH-7 a job without any check-run is unproven", async () => {
    await refused(fixture(d => { d[paths.checks()] = { total_count: 0, check_runs: [] }; }), "job_check_mismatch");
  });
  test("CIH-7 a matching job ID from another Actions suite does not prove this run", async () => {
    await refused(fixture(d => {
      // Run 12 remains as old evidence for suite 22, but only run 11 is selected.
      const older = d[paths.runs].workflow_runs[1];
      Object.assign(older, { workflow_id: 1, name: "workflow-1", path: ".github/workflows/1.yml",
        event: "pull_request", created_at: "2026-10-29T19:59:00Z" });
      d[paths.jobs()] = { total_count: 1, jobs: [job(32, 11, 1, "orca")] };
    }), "job_check_mismatch");
  });
  test("CIH-7 foreign App check cannot authorize an Actions job (layered guards)", async () => {
    await refused(fixture(d => { d[paths.checks()].check_runs[0].app = { id: 999, slug: "external" }; }), "malformed");
  });
  test("CIH-7 individually valid job/check states must agree", async () => {
    await refused(fixture(d => {
      Object.assign(d[paths.jobs()].jobs[0], { status: "in_progress", conclusion: null });
      Object.assign(d[paths.checks()].check_runs[0], { status: "queued", conclusion: null });
    }), "job_check_mismatch");
  });
  test("CIH-7 completed job/check conclusions must agree", async () => {
    await refused(fixture(d => { d[paths.jobs()].jobs[0].conclusion = "failure"; }), "job_check_mismatch");
  });
  test.each(["started_at", "completed_at"] as const)("CIH-7 job/check %s must agree", async field => {
    await refused(fixture(d => { d[paths.jobs()].jobs[0][field] = "2026-10-29T20:00:01Z"; }), "job_check_mismatch");
  });
  test("CIH-7 external checks with identical names stay distinct by App id", async () => {
    const result = await fixture(d => {
      absent(d);
      d[paths.suites] = { total_count: 2, check_suites: [23, 24].map(id =>
        ({ id, head_sha: HEAD, app: { id: 900 + id, slug: `external-${id}` } })) };
      for (const suite of d[paths.suites].check_suites) {
        const c = check(suite.id + 100, suite.id, "same-name"); c.app = suite.app;
        d[paths.checks(suite.id)] = { total_count: 1, check_runs: [c] };
      }
    }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { results: ["SUCCESS", "SUCCESS"] } } });
  });
  test("CIH-7 equal timestamps select the higher run id, retaining both raw runs", async () => {
    const result = await fixture(d => {
      const first = d[paths.runs].workflow_runs[0], second = d[paths.runs].workflow_runs[1];
      first.conclusion = "failure";
      Object.assign(second, { workflow_id: 1, event: first.event, name: first.name, path: first.path });
    }).collect();
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.snapshot.observations.runs).toHaveLength(2);
    expect(result.snapshot.ci.results).toEqual(["SUCCESS", "SUCCESS"]);
  });
  test("CIH-7 an error status contributes aggregate FAILURE", async () => {
    const result = await fixture(d => {
      absent(d); d[paths.status] = { sha: HEAD, state: "failure", total_count: 1,
        statuses: [{ id: 41, context: "deploy", state: "error", creator: { id: 8 }, created_at: TIME, updated_at: TIME }] };
    }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { results: ["FAILURE"] } } });
  });
  test("CIH-7 an unknown status-row state cannot masquerade as success", async () => {
    await refused(fixture(d => {
      absent(d); d[paths.status] = { sha: HEAD, state: "success", total_count: 1,
        statuses: [{ id: 41, context: "deploy", state: "unknown", creator: { id: 8 }, created_at: TIME, updated_at: TIME }] };
    }), "malformed");
  });
  test("CIH-7 a workflow-shaped directory is not a workflow blob", async () => {
    const result = await fixture(d => {
      absent(d); d[paths.tree].tree = [{ path: ".github/workflows/ci.yml", type: "tree", mode: "040000", sha: BASE }];
    }).collect();
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { configured: false, results: [] } } });
  });
  test("CIH-7 one oversized name refuses independently of the overall string budget", async () => {
    await refused(fixture(d => { d[paths.runs].workflow_runs[0].name = "x".repeat(65537); }), "malformed");
  });
  test("CIH-7 a malformed external App slug refuses even with no checks or runs", async () => {
    await refused(fixture(d => {
      absent(d); d[paths.suites] = { total_count: 1, check_suites: [
        { id: 23, head_sha: HEAD, app: { id: 999, slug: "Bad Slug" } },
      ] }; d[paths.checks(23)] = { total_count: 0, check_runs: [] };
    }), "malformed");
  });
  test("CIH-7 mid-flight caller abort is forwarded before the collection deadline", async () => {
    const controller = new AbortController(); let forwarded = false;
    const f = fixture(undefined, (path, occurrence, value) => {
      if (path === paths.pr && occurrence === 1) { controller.abort(); forwarded = f.signals[0]!.aborted; }
      return value;
    });
    await refused(f, "aborted", { signal: controller.signal });
    expect(forwarded).toBe(true);
  });
  test("CIH-7 successful collection finally aborts every issued signal", async () => {
    const f = fixture(); expect((await f.collect()).ok).toBe(true);
    expect(f.signals.length).toBeGreaterThan(0); expect(f.signals.every(s => s.aborted)).toBe(true);
  });
  test.each([false, true])("CIH-7 native CI factory composition: forged job head=%s", async forged => {
    const f = fixture(d => { if (forged) d[paths.jobs()].jobs[0].head_sha = BASE; });
    const get = createReviewGitHubCiGet(REPO, 45, BINDING, {
      credential: async () => "fixture-only",
      fetch: async (url, init) => Response.json(await f.get(url.slice("https://api.github.com".length), init.signal as AbortSignal)),
    });
    const result = await collectReviewCi(get, REPO, 45, BINDING);
    if (forged) expect(result).toMatchObject({ ok: false, collection: "jobs", reason: "malformed" });
    else expect(result).toMatchObject({ ok: true, snapshot: { ci: { complete: true, results: ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"] } } });
  });
});
