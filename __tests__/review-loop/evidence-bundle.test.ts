import { describe, expect, test } from "bun:test";
import { collectReviewEvidence } from "../../src/review-loop/evidence-bundle";
import { DISCUSSION_QUERIES } from "../../src/review-loop/discussion";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";

const H = "a".repeat(40), B = "b".repeat(40), X = "c".repeat(40);
const REPO = "rfcclub/anima", ROOT = `/repos/${REPO}`, PR = `${ROOT}/pulls/45`;
const AUTHOR = "eli-gotako[bot]", SECRET = "fixture-credential-not-a-live-token";
const config = () => ({ repo: REPO, number: 45, authorLogin: AUTHOR });
const page = (nodes: unknown[]) => ({ nodes, totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: nodes.length ? "cursor1" : null } });
interface Call { path: string; init: RequestInit; occurrence: number; kind?: string }
function fixture(edit?: (call: Call, value: any) => unknown | Promise<unknown>) {
  const calls: Call[] = [], signals: AbortSignal[] = [];
  const counts = new Map<string, number>();
  let credentials = 0;
  const metadata = { number: 45, state: "open", draft: false,
    head: { sha: H, repo: { full_name: REPO } },
    base: { sha: B, ref: "feature/base", repo: { full_name: REPO } },
    user: { type: "Bot", login: AUTHOR }, changed_files: 1, commits: 1 };
  const records: Record<string, unknown> = {
    [PR]: metadata,
    [`${ROOT}/git/ref/heads/feature%2Fbase`]: { ref: "refs/heads/feature/base", object: { type: "commit", sha: B } },
    [`${PR}/files?per_page=100&page=1`]: [{ filename: "src/safe.ts", status: "modified" }],
    [`${PR}/commits?per_page=100&page=1`]: [{ sha: H, author: { login: AUTHOR },
      committer: { login: AUTHOR }, commit: { message: "change\n\nAgent: eli" } }],
    [`${ROOT}/git/trees/${B}?recursive=1`]: { sha: B, truncated: false,
      tree: [{ path: ".github/workflows/ci.yml", type: "blob", mode: "100644", sha: X }] },
    [`${ROOT}/actions/runs?head_sha=${H}&per_page=100&page=1`]: { total_count: 0, workflow_runs: [] },
    [`${ROOT}/commits/${H}/check-suites?per_page=100&page=1`]: { total_count: 1,
      check_suites: [{ id: 21, head_sha: H, app: { id: 7, slug: "external-ci" } }] },
    [`${ROOT}/check-suites/21/check-runs?filter=all&per_page=100&page=1`]: { total_count: 1,
      check_runs: [{ id: 31, name: "test", head_sha: H, check_suite: { id: 21 },
        app: { id: 7, slug: "external-ci" }, status: "completed", conclusion: "success",
        started_at: null, completed_at: null }] },
    [`${ROOT}/commits/${H}/status?per_page=100&page=1`]: { sha: H, state: "pending", total_count: 0, statuses: [] },
  };
  const deps = {
    credential: async (signal: AbortSignal) => { credentials++; signals.push(signal); return SECRET; },
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      expect(new URL(url).origin).toBe("https://api.github.com");
      const path = url.slice("https://api.github.com".length);
      const occurrence = (counts.get(path) ?? 0) + 1; counts.set(path, occurrence);
      const call: Call = { path, init, occurrence }; calls.push(call);
      let value: any;
      if (path === "/graphql") {
        expect(init.method).toBe("POST");
        const request = JSON.parse(String(init.body));
        call.kind = Object.entries(DISCUSSION_QUERIES).find(([, text]) => text === request.query)?.[0];
        expect(call.kind).toBeDefined();
        expect(request.variables).toMatchObject({ owner: "rfcclub", name: "anima", number: 45,
          baseRef: "refs/heads/feature/base" });
        const pullRequest: any = { number: 45, state: "OPEN", isDraft: false,
          headRefOid: H, baseRefOid: B, baseRefName: "feature/base" };
        if (call.kind === "reviews") pullRequest.reviews = page([{ id: "R1", fullDatabaseId: "6000000001",
          author: { __typename: "Bot", login: "reviewer" }, body: "Reviewer: bruno", state: "APPROVED",
          submittedAt: "2026-10-29T12:00:00Z", commit: { oid: H } }]);
        if (call.kind === "threads") pullRequest.reviewThreads = page([{ id: "T1", isResolved: false,
          isOutdated: true, pullRequest: { number: 45, repository: { nameWithOwner: REPO } },
          comments: { totalCount: 1 } }]);
        if (call.kind === "comments") pullRequest.comments = page([]);
        value = { data: { repository: { nameWithOwner: REPO,
          ref: { name: "feature/base", target: { __typename: "Commit", oid: B } }, pullRequest },
          rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: "2100-01-01T00:00:00Z" } } };
        if (call.kind === "threadComments") value.data.node = { id: "T1", isResolved: false, isOutdated: true,
          pullRequest: { number: 45, repository: { nameWithOwner: REPO } }, comments: page([{ id: "C1",
            fullDatabaseId: "7000000001", author: { __typename: "User", login: "rfcclub" }, body: "discuss",
            createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-10-29T12:00:00Z" }]) };
      } else {
        expect(init.method).toBe("GET"); expect(init.body).toBeUndefined();
        if (!(path in records)) throw Error("Unexpected fixture path");
        value = structuredClone(records[path]);
      }
      const result = edit ? await edit(call, value) : value;
      return result instanceof Response ? result : Response.json(result);
    },
  };
  return { calls, records, metadata, deps, signals, get credentials() { return credentials; } };
}
const run = (f = fixture(), options: any = {}, subject: any = config()) =>
  collectReviewEvidence(subject, f.deps, options);
function failure(result: unknown, stage: string, reason?: string) {
  expect(result).toMatchObject({ ok: false, stage, ...(reason ? { reason } : {}) });
  expect(result).not.toHaveProperty("observations");
  expect(result).not.toHaveProperty("bundle");
  expect(JSON.stringify(result)).not.toContain(SECRET);
}

describe("bounded native review evidence bundle EB-1..8", () => {
  test("EB-2 EB-8 real collectors/adapters preserve coherent facts without manufacturing authority", async () => {
    const f = fixture(), result = await run(f);
    expect(result.ok).toBe(true); if (!result.ok) throw Error(JSON.stringify(result));
    expect(result.binding).toEqual({ ...config(), headSha: H, baseSha: B, baseBranch: "feature/base" });
    expect(result.automaticMerge).toBe(false); expect(result.candidate).toBeNull();
    expect(result.unproven).toEqual(["issuer", "custody", "owner", "issue", "loop", "atomic_merge"]);
    expect(result.observations.branch.paths.items).toEqual([{ path: "src/safe.ts" }]);
    expect(result.observations.discussion.threads.items[0]).toMatchObject({ resolved: false, outdated: true });
    expect(result.observations.discussion.reviews.items[0].appLogin).toBe("reviewer[bot]");
    expect(result.observations.ci.ci).toMatchObject({ configured: true, complete: true, results: ["SUCCESS"] });
    expect(result.requests).toBe(29); expect(f.calls).toHaveLength(29);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0); expect(result.elapsedMs).toBeLessThan(30_000);
    expect(f.calls.filter(x => x.path === PR)).toHaveLength(6);
    expect(f.credentials).toBe(29);
    expect(f.calls.every(x => x.init.redirect === "error" && x.init.cache === "no-store")).toBe(true);
    expect(f.calls.filter(x => x.path === "/graphql").map(x => x.kind))
      .toEqual(["reviews", "threads", "threadComments", "comments", "anchor"]);
    expect(auditReviewEligibility(result, { apps: { eli: AUTHOR }, bindings: [], now: 1000, cooldownMs: 0 }))
      .toMatchObject({ automaticMerge: false, reasons: ["atomic_base_guard_unproven", "malformed_snapshot"] });
    for (const field of ["issue", "loop", "ownerAgents", "observedHeadSha", "observedBaseSha"]) expect(result).not.toHaveProperty(field);
  });
  test.each([null, [], {}, { repo: "evil/anima", number: 45, authorLogin: AUTHOR },
    { ...config(), repo: `${REPO}/../other` }, { ...config(), number: 0 }, { ...config(), number: 2147483648 },
    { ...config(), authorLogin: "rfcclub" }, { ...config(), authorLogin: null }])
  ("EB-1 forbidden config %j has zero fetch/credential calls", async subject => {
    const f = fixture(); failure(await run(f, {}, subject), "config", "config"); expect(f.calls).toEqual([]); expect(f.credentials).toBe(0);
  });
  test.each([null, [], { timeoutMs: null }, { requests: null }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 }, { requests: 0 },
    { requests: 445 }, { requests: NaN }, { signal: null }, { signal: {} }, { unknown: 1 }])
  ("EB-1 invalid bounded option %j has zero I/O", async options => {
    const f = fixture(); failure(await run(f, options), "config", "config"); expect(f.calls).toEqual([]); expect(f.credentials).toBe(0);
  });
  test("EB-1 copied config/dependencies/limit values cannot be rebound during a credential await", async () => {
    const f = fixture(), subject = config(); const original = f.deps.credential;
    f.deps.credential = async signal => {
      subject.repo = "rfcclub/other"; subject.number = 99; subject.authorLogin = "other[bot]";
      f.deps.fetch = async () => { throw Error("rebound"); };
      return original(signal);
    };
    const r = await run(f, {}, subject); expect(r.ok).toBe(true);
    if (r.ok) expect(r.binding).toEqual({ ...config(), headSha: H, baseSha: B, baseBranch: "feature/base" });
  });
  test("EB-1 throwing config getter refuses content-free before credentials", async () => {
    const f = fixture(); failure(await run(f, {}, { get repo() { throw Error(SECRET); } }), "config", "config");
    expect(f.credentials).toBe(0);
  });
  test("EB-1 dependency limit getter is captured once before awaits", async () => {
    const f = fixture(); let reads = 0;
    Object.defineProperty(f.deps, "limits", { get() {
      if (++reads > 1) throw Error(SECRET);
      return { responseBytes: 1024 * 1024, sessionBytes: 16 * 1024 * 1024 };
    } });
    expect((await run(f)).ok).toBe(true); expect(reads).toBe(1);
  });
  test("EB-1 caller limit/option mutations cannot loosen the captured limits", async () => {
    const f = fixture(), limits = { responseBytes: 1 }, options = { requests: 1, timeoutMs: 1000 };
    (f.deps as any).limits = limits;
    const original = f.deps.credential;
    f.deps.credential = async s => { limits.responseBytes = 8 * 1024 * 1024; options.requests = 444; return original(s); };
    const r = await run(f, options);
    failure(r, "branch", "read_failed"); expect(r).toMatchObject({ transport: { code: "response_bytes" }, requests: 1 });
  });
  test.each([null, [], {}, { fetch: null, credential: async () => SECRET },
    { fetch: async () => Response.json({}), credential: null }, { limits: null }, { limits: [] },
    { limits: { responseBytes: 8388609 } }, { limits: { sessionBytes: 67108865 } },
    { limits: { timeoutMs: 30001 } }, { limits: { requests: 41 } }, { limits: { unknown: 1 } }])
  ("EB-1 invalid dependency shape/ceiling %j refuses without I/O", async change => {
    const f = fixture(); const deps = change === null || Array.isArray(change) || Object.keys(change).length === 0
      ? change : { ...f.deps, ...change };
    const r = await collectReviewEvidence(config(), deps as any);
    failure(r, "config", "config"); expect(f.credentials).toBe(0); expect(f.calls).toHaveLength(0);
  });
  test("EB-6 final cleanup aborts every native request signal after success", async () => {
    const f = fixture(); expect((await run(f)).ok).toBe(true);
    expect(f.signals).toHaveLength(29);
    expect(f.signals.every(s => s.aborted)).toBe(true);
  });
  test("EB-1 wrong trusted author never becomes its own expectation", async () => {
    const f = fixture(); f.metadata.user.login = "foreign[bot]";
    failure(await run(f), "pre_anchor", "author_mismatch"); expect(f.calls).toHaveLength(6);
  });
  test("EB-4 agreeing User observations do not satisfy expected Bot config", async () => {
    const f = fixture(); f.metadata.user.type = "User";
    failure(await run(f), "pre_anchor", "http_response"); expect(f.calls).toHaveLength(7);
  });
  test.each(["pre_anchor", "final_anchor"])("EB-4 %s repeats native fork/identity/live-tip validation", async stage => {
    const threshold = stage === "pre_anchor" ? 3 : 6;
    const f = fixture((c, v) => { if (c.path === PR && c.occurrence === threshold) v.head.repo = null; return v; });
    failure(await run(f), stage, "http_response");
  });
  test("EB-3 branch count failure never returns partial paths or requests discussion/CI", async () => {
    const f = fixture(); f.metadata.changed_files = 2; const r = await run(f);
    failure(r, "branch", "count_mismatch"); expect(r).toMatchObject({ collection: "files" });
    expect(f.calls).toHaveLength(3);
  });
  test("EB-3 discussion with another head is refused before CI", async () => {
    const f = fixture((c, v) => { if (c.kind === "reviews") v.data.repository.pullRequest.headRefOid = X; return v; });
    failure(await run(f), "discussion", "snapshot_changed"); expect(f.calls).toHaveLength(9);
  });
  test("EB-3 CI with another head cannot be mixed into anchored evidence", async () => {
    const f = fixture((c, v) => { if (c.path === PR && c.occurrence === 4) v.head.sha = X; return v; });
    failure(await run(f), "ci", "malformed"); expect(f.calls).toHaveLength(14);
  });
  test("EB-3 truncated CI tree refuses whole bundle without later anchor", async () => {
    const f = fixture(); (f.records[`${ROOT}/git/trees/${B}?recursive=1`] as any).truncated = true;
    failure(await run(f), "ci", "tree_truncated"); expect(f.calls).toHaveLength(16);
  });
  test.each(["head", "base", "live", "author", "closed", "draft"])("EB-4 final anchor %s movement refuses", async axis => {
    const f = fixture((c, v) => {
      if (c.path === PR && c.occurrence === 6) {
        if (axis === "head") v.head.sha = X; if (axis === "base") v.base.sha = X;
        if (axis === "author") v.user.login = "other[bot]";
        if (axis === "closed") v.state = "closed"; if (axis === "draft") v.draft = true;
      }
      if (c.path.includes("/git/ref/") && c.occurrence === 6 && axis === "live") v.object.sha = X;
      return v;
    });
    failure(await run(f), "final_anchor", "http_response");
  });
  test.each(Array.from({ length: 28 }, (_, i) => i + 1))("EB-5 shared budget %s never delegates call N+1", async requests => {
    const f = fixture(), r = await run(f, { requests });
    const stage = requests < 6 ? "branch" : requests < 8 ? "pre_anchor"
      : requests < 13 ? "discussion" : requests < 27 ? "ci" : "final_anchor";
    failure(r, stage, "request_limit"); expect(r).toMatchObject({ requests }); expect(f.calls).toHaveLength(requests);
  });
  test.each([29, 444])("EB-5 exact sufficient or maximum budget %s permits complete result", async requests => {
    expect((await run(fixture(), { requests })).ok).toBe(true);
  });
  test("EB-5 default shared cap is 200 even when one collector has remaining capacity", async () => {
    const f = fixture(), suites = Array.from({ length: 180 }, (_, i) => ({
      id: i + 100, head_sha: H, app: { id: 7, slug: "external-ci" },
    }));
    f.records[`${ROOT}/commits/${H}/check-suites?per_page=100&page=1`] =
      { total_count: 180, check_suites: suites.slice(0, 100) };
    f.records[`${ROOT}/commits/${H}/check-suites?per_page=100&page=2`] =
      { total_count: 180, check_suites: suites.slice(100) };
    for (const s of suites) f.records[`${ROOT}/check-suites/${s.id}/check-runs?filter=all&per_page=100&page=1`] =
      { total_count: 0, check_runs: [] };
    const r = await run(f); failure(r, "ci", "request_limit");
    expect(r).toMatchObject({ requests: 200 }); expect(f.calls).toHaveLength(200);
  });
  test("EB-6 pre-aborted caller has no credential or fetch calls", async () => {
    const f = fixture(), c = new AbortController(); c.abort();
    failure(await run(f, { signal: c.signal }), "config", "aborted"); expect(f.credentials).toBe(0); expect(f.calls).toEqual([]);
  });
  test.each(["branch", "pre_anchor", "discussion", "ci", "final_anchor"])
  ("EB-6 root deadline in %s refuses bounded and identifies used fetches", async stage => {
    const target = ({ branch: 1, pre_anchor: 7, discussion: 9, ci: 14, final_anchor: 28 })[stage]!;
    let calls = 0;
    const f = fixture(async (_c, v) => { if (++calls === target) return new Promise(() => {}); return v; });
    const start = performance.now(), r = await run(f, { timeoutMs: 80 });
    failure(r, stage, "timeout"); expect(r).toMatchObject({ requests: target });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(60); expect(performance.now() - start).toBeLessThan(1500);
    expect(f.calls).toHaveLength(target);
  });
  test("EB-6 hung credential is bounded without any fetch", async () => {
    const f = fixture(); f.deps.credential = () => new Promise(() => {});
    failure(await run(f, { timeoutMs: 30 }), "branch", "timeout"); expect(f.calls).toEqual([]);
  });
  test("EB-6 mid-flight caller abort forwards to native request and stops later stages", async () => {
    const c = new AbortController();
    const f = fixture(async (_call, v) => { c.abort(); return v; });
    failure(await run(f, { signal: c.signal }), "branch", "aborted");
    expect(f.calls).toHaveLength(1); expect(f.calls[0].init.signal?.aborted).toBe(true);
  });
  test.each([401, 403, 429])("EB-7 observed HTTP%s is content-free with typed transport facts", async status => {
    const f = fixture(() => new Response(SECRET, { status,
      headers: { "retry-after": "99999", "x-ratelimit-remaining": "0" } }));
    const r = await run(f); failure(r, "branch", "read_failed");
    expect(r).toMatchObject({ transport: { status, code: status === 401 ? "unauthorized" : "rate_limited",
      retryAfterSeconds: 3600 } }); expect(f.calls).toHaveLength(1);
  });
  test("EB-7 thrown secret never reaches diagnostic", async () => {
    const f = fixture(() => { throw Error(SECRET); }); const r = await run(f);
    failure(r, "branch", "read_failed"); expect(r).toMatchObject({ transport: { code: "read_failed" }, requests: 1 });
  });
});
