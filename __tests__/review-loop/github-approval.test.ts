import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createReviewGitHubApprovalPost, createReviewGitHubApprovalAnchor } from "../../src/review-loop/github-approval";
import { ReviewHttpError, type ReviewHttpDependencies } from "../../src/review-loop/http-session";
import { produceApprovalReceipt, type ApprovalRequest } from "../../src/review-loop/approval-receipt";
import { ReviewJournal } from "../../src/review-loop/review-journal";

const REPO = "rfcclub/anima", NUMBER = 45, HEAD = "a".repeat(40), BASE = "b".repeat(40);
const AUTHOR = "author-app[bot]", REVIEWER = "reviewer-app[bot]", TOKEN = "fixture-only-token";
const PR_PATH = "/repos/rfcclub/anima/pulls/45", REF_PATH = "/repos/rfcclub/anima/git/ref/heads/feature%2Fbase";
const binding = () => ({ headSha: HEAD, baseSha: BASE, baseBranch: "feature/base", authorLogin: AUTHOR });
const request = (): ApprovalRequest => ({ repo: REPO, number: NUMBER, event: "APPROVE", commit_id: HEAD, body: "Read it." });
const review = () => ({ id: 87, state: "APPROVED", commit_id: HEAD, user: { type: "Bot", login: REVIEWER } });
const pr = () => ({ number: NUMBER, state: "open", draft: false, user: { type: "Bot", login: AUTHOR },
  base: { ref: "feature/base", sha: BASE, repo: { full_name: REPO } },
  head: { sha: HEAD, repo: { full_name: REPO } } });
const ref = () => ({ ref: "refs/heads/feature/base", object: { type: "commit", sha: BASE } });
const signal = () => new AbortController().signal;
function fixture(overrides: Partial<ReviewHttpDependencies> = {}) {
  const calls: { url: string; init: RequestInit }[] = [], signals: AbortSignal[] = [];
  const deps: ReviewHttpDependencies = { credential: async s => { signals.push(s); return TOKEN; },
    fetch: async (url, init) => { calls.push({ url, init }); return Response.json(review()); }, ...overrides };
  const post = createReviewGitHubApprovalPost(REPO, NUMBER, HEAD, deps);
  return { post, deps, calls, signals };
}
async function failure(promise: Promise<unknown>, code: string) {
  let error: unknown, timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("fixture ceiling")), 2000);
  })]); } catch (e) { error = e; } finally { clearTimeout(timer); }
  expect(error).toBeInstanceOf(ReviewHttpError);
  expect(error).toMatchObject({ code, message: `review_http:${code}` });
  expect(String(error)).not.toContain(TOKEN); expect(JSON.stringify(error)).not.toContain(TOKEN);
  return error as ReviewHttpError;
}
function anchorFixture(change?: (value: ReturnType<typeof pr>) => unknown, changeRef?: (value: ReturnType<typeof ref>) => unknown,
  limits?: ReviewHttpDependencies["limits"]) {
  const paths: string[] = [], credentials: AbortSignal[] = [];
  const read = createReviewGitHubApprovalAnchor(REPO, NUMBER, binding(), {
    limits, credential: async s => { credentials.push(s); return TOKEN; },
    fetch: async url => {
      const path = new URL(url).pathname; paths.push(path);
      if (path === PR_PATH) return Response.json(change ? change(pr()) : pr());
      if (path === REF_PATH) return Response.json(changeRef ? changeRef(ref()) : ref());
      throw Error("unexpected route");
    },
  });
  return { read, paths, credentials };
}

describe("AH-1 fixed single approval POST", () => {
  test("exact request, body and unchanged security init; second call never sends", async () => {
    const f = fixture(); expect(await f.post(request(), signal())).toEqual({ status: 200, review: review() });
    expect(f.calls).toHaveLength(1); expect(f.signals).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://api.github.com" + PR_PATH + "/reviews");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      referrerPolicy: "no-referrer", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "anima-review-collector" } });
    expect(JSON.parse(init.body as string)).toEqual({ event: "APPROVE", commit_id: HEAD, body: "Read it." });
    expect(init.signal).toBe(f.signals[0]); expect(f.signals[0]!.aborted).toBe(true);
    await failure(f.post(request(), signal()), "request_limit"); expect(f.calls).toHaveLength(1);
    await failure(f.post(request(), signal()), "closed");
  });
  const badRequests: unknown[] = [null, [], {}, { ...request(), extra: "x" }, { ...request(), comments: [] },
    { ...request(), repo: "rfcclub/other" }, { ...request(), number: 46 }, { ...request(), number: "45" },
    { ...request(), commit_id: BASE }, { ...request(), event: "COMMENT" }, { ...request(), event: "REQUEST_CHANGES" },
    { ...request(), body: null }, { ...request(), body: 42 }, { ...request(), body: true },
    { ...request(), body: ["text"] }, { ...request(), body: { length: 0 } }, { ...request(), body: new String("text") },
    { ...request(), body: "x".repeat(65_537) },
    { ...request(), [Symbol("hidden")]: true }, Object.create(request()),
    Object.assign(Object.create(request()), { a: 1, b: 2, c: 3, d: 4, e: 5 }),
    Object.fromEntries(Object.entries(request()).filter(([key]) => key !== "event"))];
  test.each(badRequests.map((value, i) => [i, value] as const))("forbidden request shape %i refuses before credential or fetch", async (_i, value) => {
    const f = fixture(); await failure(f.post(value as ApprovalRequest, signal()), "scope");
    expect(f.calls).toEqual([]); expect(f.signals).toEqual([]);
    await failure(f.post(request(), signal()), "closed");
  });
  test.each(["", "x".repeat(65_536), "😀".repeat(32_768), "\u00e9".repeat(65_536)].map((body, i) => [i, body] as const))("body at permitted UTF16 boundary %i is copied exactly", async (_i, body) => {
    const f = fixture(); await f.post({ ...request(), body }, signal());
    expect(JSON.parse(f.calls[0]!.init.body as string).body).toBe(body);
  });
  test("astral text one UTF16 unit over the cap is refused", async () => {
    const f = fixture(); await failure(f.post({ ...request(), body: "😀".repeat(32_768) + "x" }, signal()), "scope");
    expect(f.calls).toEqual([]);
  });
  test("copy precedes awaited credential; every request scalar is read once", async () => {
    const input = request(), reads = new Map<string, number>();
    const live = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v]));
    for (const [key, value] of Object.entries(input)) Object.defineProperty(live, key, { enumerable: true,
      get() { reads.set(key, (reads.get(key) ?? 0) + 1); return reads.get(key) === 1 ? value : "rebound"; } });
    const f = fixture({ credential: async () => { input.body = "changed"; return TOKEN; } });
    await f.post(live as unknown as ApprovalRequest, signal());
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ event: "APPROVE", commit_id: HEAD, body: "Read it." });
  });
  test("awaited credential cannot mutate any captured input scalar", async () => {
    const input = request();
    const f = fixture({ credential: async () => {
      Object.assign(input, { repo: "evil/repo", number: 99, event: "COMMENT", commit_id: BASE, body: "changed" });
      return TOKEN;
    } });
    await f.post(input, signal());
    expect(f.calls[0]!.url).toBe("https://api.github.com" + PR_PATH + "/reviews");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ event: "APPROVE", commit_id: HEAD, body: "Read it." });
  });
  test("throwing getter refuses as scope without leaking or issuing credentials", async () => {
    const input = request(); Object.defineProperty(input, "body", { get() { throw Error(TOKEN); } });
    const f = fixture(); await failure(f.post(input, signal()), "scope"); expect(f.calls).toEqual([]); expect(f.signals).toEqual([]);
  });
  test("concurrent call poisons the first call and never sends twice", async () => {
    const f = fixture({ credential: async () => new Promise<string>(() => {}) });
    const first = f.post(request(), signal()); await failure(f.post(request(), signal()), "busy");
    await failure(first, "aborted"); expect(f.calls).toEqual([]);
  });
  test("credential-before-fetch ordering and invalid credential refusal", async () => {
    const f = fixture({ credential: async () => TOKEN + "\n" });
    await failure(f.post(request(), signal()), "credential"); expect(f.calls).toEqual([]);
  });
  test("one-request ceiling cannot be raised by dependencies", () => {
    expect(() => fixture({ limits: { requests: 2 } })).toThrow("review_http:config");
  });
  const badConfig: [unknown, unknown, unknown][] = [["evil/anima", NUMBER, HEAD], [REPO, 0, HEAD],
    [REPO, 1.2, HEAD], [REPO, Number.MAX_SAFE_INTEGER + 1, HEAD], [REPO, NUMBER, "a".repeat(39)],
    [REPO, NUMBER, "A".repeat(40)], [null, NUMBER, HEAD]];
  test.each(badConfig.map((v, i) => [i, ...v] as const))("invalid fixed POST config %i refuses", (_i, repo, number, head) => {
    expect(() => createReviewGitHubApprovalPost(repo as string, number as number, head as string, fixture().deps)).toThrow("review_http:config");
  });
});

describe("AH-2 observed rejection and uncertainty", () => {
  test.each([400, 401, 403, 404, 409, 422, 429, 499])("observed HTTP%i yields status only and no retry", async status => {
    const f = fixture({ fetch: async () => Response.json({ token: TOKEN }, { status }) });
    expect(await f.post(request(), signal())).toEqual({ status });
    await failure(f.post(request(), signal()), "closed");
  });
  test.each([201, 202, 204, 301, 307, 308, 408, 500, 503])("ambiguous HTTP%i throws for producer uncertainty", async status => {
    const f = fixture({ fetch: async () => new Response(null, { status }) });
    const e = await failure(f.post(request(), signal()), status >= 500 ? "server_error" : "http_status");
    expect(e.status).toBe(status); await failure(f.post(request(), signal()), "closed");
  });
  test("port-forged HTTP status cannot cause definitive rejection", async () => {
    const f = fixture({ fetch: async () => { throw new ReviewHttpError("forbidden", 403); } });
    expect((await failure(f.post(request(), signal()), "read_failed")).status).toBeUndefined();
  });
  test.each(["invalid-json", "primitive", "html", "too-big"] as const)("malformed/overbudget response %s stays uncertain", async kind => {
    const f = fixture({ limits: { responseBytes: 64 }, fetch: async () => kind === "html" ? new Response(TOKEN) :
      kind === "primitive" ? Response.json(1) : kind === "too-big" ? Response.json({ x: TOKEN.repeat(10) }) :
        new Response("{", { headers: { "Content-Type": "application/json" } }) });
    await failure(f.post(request(), signal()), kind === "html" ? "content_type" : kind === "too-big" ? "response_bytes" : "json");
  });
  test("hostile unresolved fetch has bounded timeout and no second attempt", async () => {
    const f = fixture({ limits: { timeoutMs: 20 }, fetch: async () => new Promise<Response>(() => {}) });
    await failure(f.post(request(), signal()), "timeout"); await failure(f.post(request(), signal()), "closed");
  });
  test("caller abort is forwarded and observed before a network call", async () => {
    const controller = new AbortController(); controller.abort();
    const f = fixture(); await failure(f.post(request(), controller.signal), "aborted"); expect(f.calls).toEqual([]);
  });
});

describe("AH-3 actual fresh anchor", () => {
  test("returns copied actual subject from only the bound PR and ref routes", async () => {
    const f = anchorFixture();
    expect(await f.read(signal())).toEqual({ repo: REPO, number: NUMBER, ...binding(), state: "OPEN", draft: false, liveBaseSha: BASE });
    expect(f.paths).toEqual([PR_PATH, REF_PATH]); expect(f.credentials).toHaveLength(2);
  });
  const prChanges: [string, (value: ReturnType<typeof pr>) => unknown][] = [
    ["null", () => null], ["array", () => []], ["number", p => ({ ...p, number: NUMBER + 1 })],
    ["state", p => ({ ...p, state: "closed" })], ["draft", p => ({ ...p, draft: true })],
    ["missing-draft", p => { const { draft, ...rest } = p; return rest; }],
    ["null-base", p => ({ ...p, base: null })], ["null-head", p => ({ ...p, head: null })],
    ["foreign-base-repo", p => ({ ...p, base: { ...p.base, repo: { full_name: "evil/anima" } } })],
    ["foreign-head-repo", p => ({ ...p, head: { ...p.head, repo: { full_name: "evil/anima" } } })],
    ["deleted-head-repo", p => ({ ...p, head: { ...p.head, repo: null } })],
    ["null-base-repo", p => ({ ...p, base: { ...p.base, repo: null } })],
    ["head", p => ({ ...p, head: { ...p.head, sha: BASE } })],
    ["base", p => ({ ...p, base: { ...p.base, sha: HEAD } })],
    ["branch", p => ({ ...p, base: { ...p.base, ref: "other" } })],
    ["user-type", p => ({ ...p, user: { ...p.user, type: "User" } })],
    ["user-login", p => ({ ...p, user: { ...p.user, login: "other[bot]" } })], ["null-user", p => ({ ...p, user: null })],
  ];
  test.each(prChanges)("forbidden PR anchor %s never returns a trusted anchor", async (_name, change) => {
    const f = anchorFixture(change); await failure(f.read(signal()), _name === "null" ? "json" : "http_response");
    expect(f.paths).toEqual([PR_PATH]);
  });
  const refChanges: [string, (value: ReturnType<typeof ref>) => unknown][] = [
    ["null", () => null], ["array", () => []], ["ref", v => ({ ...v, ref: "refs/heads/other" })],
    ["tag", v => ({ ...v, object: { ...v.object, type: "tag" } })],
    ["moved", v => ({ ...v, object: { ...v.object, sha: HEAD } })], ["null-object", v => ({ ...v, object: null })],
    ["malformed-sha", v => ({ ...v, object: { ...v.object, sha: "b".repeat(39) } })],
  ];
  test.each(refChanges)("forbidden base anchor %s refuses", async (_name, change) => {
    const f = anchorFixture(undefined, change); await failure(f.read(signal()), _name === "null" ? "json" : "http_response");
    expect(f.paths).toEqual([PR_PATH, REF_PATH]);
  });
  test("every read has a fresh deadline and acquires fresh credentials", async () => {
    const f = anchorFixture(undefined, undefined, { timeoutMs: 100 });
    await f.read(signal()); await Bun.sleep(150); await f.read(signal());
    expect(f.paths).toEqual([PR_PATH, REF_PATH, PR_PATH, REF_PATH]); expect(f.credentials).toHaveLength(4);
    expect(new Set(f.credentials).size).toBe(4);
  });
  test("fixed anchor binding is copied before caller mutation", async () => {
    const b = binding(), paths: string[] = [];
    const read = createReviewGitHubApprovalAnchor(REPO, NUMBER, b, { credential: async () => TOKEN,
      fetch: async url => { paths.push(new URL(url).pathname); return Response.json(paths.length === 1 ? pr() : ref()); } });
    b.baseBranch = "other"; b.headSha = BASE; b.baseSha = HEAD; b.authorLogin = REVIEWER;
    expect(await read(signal())).toMatchObject(binding()); expect(paths).toEqual([PR_PATH, REF_PATH]);
  });
  test.each(["headSha", "baseSha", "baseBranch", "authorLogin"])("invalid fixed anchor %s refuses construction", key => {
    expect(() => createReviewGitHubApprovalAnchor(REPO, NUMBER, { ...binding(), [key]: "" }, fixture().deps)).toThrow("review_http:config");
  });
  test.each([null, [], {}].map((value, i) => [i, value] as const))("invalid anchor config shape %i refuses", (_i, value) => {
    expect(() => createReviewGitHubApprovalAnchor(REPO, NUMBER,
      value as Parameters<typeof createReviewGitHubApprovalAnchor>[2], fixture().deps)).toThrow("review_http:config");
  });
});

describe("AH-4 real boundary and fixture composition", () => {
  test.each([307, 308])("real fetch HTTP%i never forwards Authorization or body to target", async status => {
    let targetCalls = 0, sourceCalls = 0, sourceBody = "", sourceAuth = "";
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetCalls++; return Response.json(review()); } });
    const source = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      sourceCalls++; sourceBody = await req.text(); sourceAuth = req.headers.get("authorization") ?? "";
      return new Response(null, { status, headers: { Location: target.url.href + TOKEN } });
    } });
    try {
      const f = fixture({ fetch: (url, init) => fetch(url.replace("https://api.github.com", source.url.origin), init) });
      await failure(f.post(request(), signal()), "read_failed");
      expect(sourceCalls).toBe(1); expect(sourceAuth).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(sourceBody)).toEqual({ event: "APPROVE", commit_id: HEAD, body: "Read it." });
      expect(targetCalls).toBe(0);
    } finally { await source.stop(true); await target.stop(true); }
  });
  test.each([200, 403, 408, 201, 500])("producer and journal through real adapters classify HTTP%i without resending", async status => {
    let posts = 0, gets = 0, postedBody = "";
    const deps: ReviewHttpDependencies = { credential: async () => TOKEN, fetch: async (url, init) => {
      if (init.method === "POST") { posts++; postedBody = JSON.parse(init.body as string).body; return Response.json(review(), { status }); }
      gets++; return Response.json(new URL(url).pathname === PR_PATH ? pr() : ref());
    } };
    const ports = { readAnchor: createReviewGitHubApprovalAnchor(REPO, NUMBER, binding(), deps),
      submitApproval: createReviewGitHubApprovalPost(REPO, NUMBER, HEAD, deps) };
    const db = new Database(":memory:"), journal = new ReviewJournal(db);
    try {
      const expected = { repo: REPO, number: NUMBER, ...binding() }, who = { agent: "reviewer", appLogin: REVIEWER };
      const prose = "😀".repeat(32_500);
      const result = await produceApprovalReceipt(journal, expected, who, prose, ports);
      expect(postedBody.startsWith(prose + "\n\nReviewer: reviewer\n<!-- anima-review-attempt:")).toBe(true);
      expect(postedBody.length).toBeLessThanOrEqual(65_536);
      expect(result.ok).toBe(status === 200); expect(posts).toBe(1); expect(gets).toBe(status === 200 ? 4 : 2);
      const attempt = journal.find({ repo: REPO, number: NUMBER, headSha: HEAD, baseSha: BASE, appLogin: REVIEWER })!;
      expect(attempt.state).toBe(status === 200 ? "bound" : status === 403 ? "rejected" : "uncertain");
      expect(journal.bindings()).toHaveLength(status === 200 ? 1 : 0);
      expect((await produceApprovalReceipt(journal, expected, who, "Again", ports)).ok).toBe(false); expect(posts).toBe(1);
    } finally { db.close(); }
  });
  test.each(["before", "after"])("head movement %s POST never binds", async when => {
    let posts = 0;
    const deps: ReviewHttpDependencies = { credential: async () => TOKEN, fetch: async (url, init) => {
      if (init.method === "POST") { posts++; return Response.json(review()); }
      const p = pr();
      if (when === "before" || posts) p.head.sha = "c".repeat(40);
      return Response.json(new URL(url).pathname === PR_PATH ? p : ref());
    } };
    const db = new Database(":memory:"), journal = new ReviewJournal(db);
    try {
      expect((await produceApprovalReceipt(journal, { repo: REPO, number: NUMBER, ...binding() },
        { agent: "reviewer", appLogin: REVIEWER }, "Read", {
          readAnchor: createReviewGitHubApprovalAnchor(REPO, NUMBER, binding(), deps),
          submitApproval: createReviewGitHubApprovalPost(REPO, NUMBER, HEAD, deps),
        })).ok).toBe(false);
      expect(posts).toBe(when === "before" ? 0 : 1); expect(journal.bindings()).toEqual([]);
    } finally { db.close(); }
  });
});
