import { describe, expect, test } from "bun:test";
import { createReviewGitHubCiGet } from "../../src/review-loop/github-ci";
import { ReviewHttpError } from "../../src/review-loop/http-session";
import { collectReviewCi } from "../../src/review-loop/ci-snapshot";

const REPO = "rfcclub/anima", ROOT = `/repos/${REPO}`, PR = `${ROOT}/pulls/45`;
const HEAD = "a".repeat(40), BASE = "b".repeat(40), ORIGIN = "https://api.github.com";
const BINDING = { headSha: HEAD, baseSha: BASE, baseBranch: "feature/base" };
const TOKEN = "fixture-ci-credential";
type Deps = Parameters<typeof createReviewGitHubCiGet>[3];
const signal = () => new AbortController().signal;
const routes = {
  pr: PR, ref: `${ROOT}/git/ref/heads/feature%2Fbase`, tree: `${ROOT}/git/trees/${BASE}?recursive=1`,
  runs: `${ROOT}/actions/runs?head_sha=${HEAD}&per_page=100&page=1`,
  suites: `${ROOT}/commits/${HEAD}/check-suites?per_page=100&page=1`,
  checks: `${ROOT}/check-suites/21/check-runs?filter=all&per_page=100&page=1`,
  status: `${ROOT}/commits/${HEAD}/status?per_page=100&page=1`,
  jobs: `${ROOT}/actions/runs/11/attempts/1/jobs?per_page=100&page=1`,
};
function fixture(overrides: Partial<Deps> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [], issued: AbortSignal[] = [];
  const get = createReviewGitHubCiGet(REPO, 45, BINDING, {
    credential: async s => { issued.push(s); return TOKEN; },
    fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ fixture: true }); },
    ...overrides,
  });
  return { get, calls, issued };
}
async function failure(p: Promise<unknown>, code: string) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ReviewHttpError);
  expect(caught).toMatchObject({ code, message: `review_http:${code}` });
  expect(String(caught)).not.toContain(TOKEN);
  return caught as ReviewHttpError;
}

describe("unwired CI HTTP boundary CIH-1..8", () => {
  test.each([
    ...Object.values(routes),
    routes.runs.replace("&page=1", "&page=10"), routes.suites.replace("&page=1", "&page=10"),
    routes.status.replace("&page=1", "&page=10"), routes.checks.replace("&page=1", "&page=10"),
    routes.jobs.replace("/attempts/1/", "/attempts/5/").replace("&page=1", "&page=10"),
    routes.checks.replace("/21/", "/9007199254740991/"),
    routes.jobs.replace("/11/", "/9007199254740991/"),
  ])("CIH-1 exact canonical read %s", async path => {
    const f = fixture(); expect(await f.get(path, signal())).toEqual({ fixture: true });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.url).toBe(ORIGIN + path);
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit",
      cache: "no-store", referrerPolicy: "no-referrer",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "anima-review-collector" } });
    expect(f.calls[0]!.init).not.toHaveProperty("body");
    expect(f.calls[0]!.init.signal).toBe(f.issued[0]);
  });
  const forbidden = [
    "https://evil.test/x", "//evil.test/x", `${PR}#x`, `${PR}?x=1`, `${PR}/reviews`,
    PR.replace("anima", "other"), PR.replace("/45", "/46"), `${PR}/../45`, `${PR}\n`,
    routes.ref.replace("feature%2Fbase", "master"), routes.ref.replace("%2F", "%2f"),
    routes.ref.replace("feature%2Fbase", "feature/base"),
    routes.tree.replace(BASE, HEAD), routes.tree.replace("?recursive=1", ""),
    routes.tree.replace("?recursive=1", "?recursive=true"), routes.tree + "&x=1",
    routes.runs.replace(HEAD, BASE), routes.suites.replace(HEAD, BASE), routes.status.replace(HEAD, BASE),
    routes.checks.replace("?filter=all&", "?"), routes.checks.replace("filter=all", "filter=latest"),
    routes.jobs.replace("/attempts/1/", "/attempts/0/"), routes.jobs.replace("/attempts/1/", "/attempts/6/"),
    routes.jobs.replace("/attempts/1/", "/attempts/01/"), `${ROOT}/actions/runs/11/rerun`,
    `${ROOT}/actions/runs/11/cancel`, `${ROOT}/actions/workflows/1/dispatches`,
    `${ROOT}/commits/${HEAD}/statuses`, `${ROOT}/commits/${HEAD}/check-runs?per_page=100&page=1`,
    "/graphql", `${ROOT}/pulls/45/files?per_page=100&page=1`,
    ...[routes.runs, routes.suites, routes.checks, routes.status, routes.jobs].flatMap(path => [
      path.replace("&page=1", "&page=0"), path.replace("&page=1", "&page=11"),
      path.replace("&page=1", "&page=01"), path.replace("per_page=100", "per_page=99"),
      path.replace("per_page=100&page=1", "page=1&per_page=100"), path + "&extra=1",
      path + "&page=1", path + "#fragment",
    ]),
    ...["0", "-1", "01", "1.0", "1e2", "9007199254740992", "10000000000000000", "%31"].flatMap(id => [
      routes.checks.replace("/21/", `/${id}/`), routes.jobs.replace("/11/", `/${id}/`),
    ]),
    `/repos//rfcclub/anima/pulls/45`, `/repos/rfcclub/anima/a/%2e%2e/pulls/45`,
  ];
  test.each(forbidden)("CIH-2 forbidden path refuses before credentials or network: %s", async path => {
    const f = fixture(); await failure(f.get(path, signal()), "scope");
    expect(f.calls).toEqual([]); expect(f.issued).toEqual([]);
    await failure(f.get(PR, signal()), "closed");
  });
  test.each([
    ["evil/anima", 45, BINDING], [REPO, 0, BINDING], [REPO, 1.5, BINDING],
    [REPO, 2147483648, BINDING], [REPO, 45, null],
    ...["headSha", "baseSha"].flatMap(key => ["A".repeat(40), "a".repeat(39), "../x", null]
      .map(value => [REPO, 45, { ...BINDING, [key]: value }])),
    ...["", ".hidden", "a..b", "a.lock", "a//b", "a b", null].map(baseBranch =>
      [REPO, 45, { ...BINDING, baseBranch }]),
  ] as [unknown, unknown, unknown][])("CIH-2 malformed constructor subject %j/%j/%j refuses config", (repo, number, binding) => {
    expect(() => createReviewGitHubCiGet(repo as string, number as number, binding as typeof BINDING,
      { fetch: async () => Response.json({}), credential: async () => TOKEN })).toThrow("review_http:config");
  });
  test("CIH-3 credentials rotate per request without URL disclosure", async () => {
    const used: string[] = []; let issued = 0;
    const f = fixture({ credential: async () => `${TOKEN}-${++issued}`,
      fetch: async (url, init) => {
        expect(url).not.toContain(TOKEN); used.push(new Headers(init.headers).get("Authorization")!);
        return Response.json({});
      } });
    await f.get(PR, signal()); await f.get(routes.tree, signal());
    expect(used).toEqual([`Bearer ${TOKEN}-1`, `Bearer ${TOKEN}-2`]);
  });
  test.each(["", "a b", "x\n", "\u00e9", "x".repeat(4097)])("CIH-3 unauthorized credential %j refuses", async token => {
    const f = fixture({ credential: async () => token }); await failure(f.get(PR, signal()), "credential");
    expect(f.calls).toEqual([]);
  });
  test.each([[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"],
    [503, "server_error"], [206, "http_status"], [302, "http_status"], [304, "http_status"]] as const)(
    "CIH-3 HTTP %s refuses %s and poisons reuse", async (status, code) => {
      const f = fixture({ fetch: async () => new Response(status === 304 ? null : TOKEN, { status }) });
      await failure(f.get(PR, signal()), code); await failure(f.get(PR, signal()), "closed");
    });
  test.each(["credential", "fetch"] as const)("CIH-3 %s exception text is suppressed", async port => {
    const f = fixture({ [port]: async () => { throw Error(TOKEN + " private-body"); } });
    const e = await failure(f.get(PR, signal()), "read_failed");
    expect(e.status).toBeUndefined();
  });
  test("CIH-3 malformed JSON and content type are refused", async () => {
    await failure(fixture({ fetch: async () => new Response("{", { headers: { "Content-Type": "application/json" } }) })
      .get(PR, signal()), "json");
    await failure(fixture({ fetch: async () => new Response(TOKEN) }).get(PR, signal()), "content_type");
  });
  test("CIH-4 declared and streamed response bytes are bounded", async () => {
    for (const declared of [false, true]) {
      const f = fixture({ limits: { responseBytes: 8 }, fetch: async () => new Response('{"long":true}',
        { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": "13" } : {}) } }) });
      await failure(f.get(PR, signal()), "response_bytes");
    }
  });
  test("CIH-4 bytes accumulate across allowed routes", async () => {
    const f = fixture({ limits: { responseBytes: 8, sessionBytes: 10 }, fetch: async () => Response.json({ a: 1 }) });
    await f.get(PR, signal()); await failure(f.get(routes.tree, signal()), "session_bytes");
  });
  test("CIH-4 exactly 200 requests allowed; 201 refuses before credential/fetch", async () => {
    const f = fixture(); for (let i = 0; i < 200; i++) await f.get(PR, signal());
    expect(f.calls).toHaveLength(200); expect(f.issued).toHaveLength(200);
    await failure(f.get(PR, signal()), "request_limit");
    expect(f.calls).toHaveLength(200); expect(f.issued).toHaveLength(200);
  });
  test("CIH-4 a lower request limit is honored", async () => {
    const f = fixture({ limits: { requests: 1 } }); await f.get(PR, signal());
    await failure(f.get(PR, signal()), "request_limit"); expect(f.calls).toHaveLength(1);
  });
  test.each([{ requests: 201 }, { responseBytes: 8388609 }, { sessionBytes: 67108865 }, { timeoutMs: 30001 },
    { requests: 0 }, { timeoutMs: 1.5 }])("CIH-4 limits cannot be raised or invalid: %j", limits => {
      expect(() => fixture({ limits })).toThrow("review_http:config");
    });
  test("CIH-3 timeout races a hostile hanging fetch and cancels its signal", async () => {
    let seen: AbortSignal | undefined;
    const f = fixture({ limits: { timeoutMs: 10 }, fetch: async (_url, init) => {
      seen = init.signal as AbortSignal; return new Promise(() => {});
    } });
    await failure(f.get(PR, signal()), "timeout"); expect(seen?.aborted).toBe(true);
  });
  test("CIH-3 overlap aborts and poisons both requests", async () => {
    let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    const f = fixture({ fetch: async () => { entered(); return new Promise(() => {}); } });
    const first = failure(f.get(PR, signal()), "aborted"); await ready;
    await failure(f.get(routes.tree, signal()), "busy"); await first;
    await failure(f.get(PR, signal()), "closed");
  });
  test.each(["headSha", "baseSha", "baseBranch"] as const)("CIH-5 captured binding survives caller mutation: %s", async key => {
    const binding = { ...BINDING }, urls: string[] = [];
    const get = createReviewGitHubCiGet(REPO, 45, binding, { credential: async () => TOKEN,
      fetch: async (url) => { urls.push(url); return Response.json({}); } });
    binding[key] = key === "baseBranch" ? "other" : "c".repeat(40);
    for (const path of [routes.ref, routes.tree, routes.runs]) await get(path, signal());
    expect(urls).toEqual([routes.ref, routes.tree, routes.runs].map(p => ORIGIN + p));
  });
  test("CIH-6 real native redirect keeps production init and never reaches the credential target", async () => {
    let targetCalls = 0, firstAuth: string | null = null;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { targetCalls++; return Response.json({}); } });
    const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      firstAuth = request.headers.get("Authorization");
      return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/target` } });
    } });
    try {
      const f = fixture({ fetch: (url, init) => fetch(url.replace(ORIGIN, `http://127.0.0.1:${first.port}`), init) });
      await failure(f.get(PR, signal()), "read_failed");
      expect<string | null>(firstAuth).toBe(`Bearer ${TOKEN}`); expect(targetCalls).toBe(0);
    } finally { first.stop(true); target.stop(true); }
  });
  test("CIH-7 CIH-8 collector composition accepts complete absence but remains partial", async () => {
    const values: Record<string, unknown> = {
      [PR]: { number: 45, state: "open", draft: false, head: { sha: HEAD },
        base: { sha: BASE, ref: BINDING.baseBranch, repo: { full_name: REPO } } },
      [routes.ref]: { ref: `refs/heads/${BINDING.baseBranch}`, object: { type: "commit", sha: BASE } },
      [routes.tree]: { sha: BASE, truncated: false, tree: [] },
      [routes.runs]: { total_count: 0, workflow_runs: [] },
      [routes.suites]: { total_count: 0, check_suites: [] },
      [routes.status]: { sha: HEAD, state: "pending", total_count: 0, statuses: [] },
    };
    const f = fixture({ fetch: async url => {
      const path = url.slice(ORIGIN.length); expect(path in values).toBe(true);
      return Response.json(values[path]);
    } });
    const result = await collectReviewCi(f.get, REPO, 45, BINDING);
    expect(result).toMatchObject({ ok: true, snapshot: { ci: { complete: true, configured: false, results: [] } } });
    if (result.ok) expect(result.snapshot).not.toHaveProperty("merge");
  });
});
