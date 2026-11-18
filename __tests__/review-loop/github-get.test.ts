import { describe, expect, test } from "bun:test";
import { createReviewGitHubGet, ReviewHttpError } from "../../src/review-loop/github-get";
import { collectReviewBranch } from "../../src/review-loop/branch-snapshot";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";

const REPO = "rfcclub/anima";
const PR = "/repos/rfcclub/anima/pulls/45";
const REF = "/repos/rfcclub/anima/git/ref/heads/master";
const TOKEN = "fixture-installation-token";
const ORIGIN = "https://api.github.com";
type Deps = Parameters<typeof createReviewGitHubGet>[2];
const json = (value: unknown) => Response.json(value);
function fixture(options: Partial<Deps> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const signals: AbortSignal[] = [];
  const get = createReviewGitHubGet(REPO, 45, {
    credential: async signal => { signals.push(signal); return TOKEN; },
    fetch: async (url, init) => { calls.push({ url, init }); return json({ value: true }); },
    ...options,
  });
  return { get, calls, signals };
}
async function failure(action: Promise<unknown>, code: string, status?: number) {
  let error: unknown, ceiling: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => { ceiling = setTimeout(() => reject(Error("fixture wait ceiling")), 1000); });
  try { await Promise.race([action, guard]); } catch (caught) { error = caught; }
  finally { clearTimeout(ceiling); }
  expect(error).toBeInstanceOf(ReviewHttpError);
  expect(error).toMatchObject({ code, message: `review_http:${code}` });
  if (status !== undefined) expect(error).toMatchObject({ status });
  expect(String(error)).not.toContain(TOKEN);
  return error as ReviewHttpError;
}
const read = (get: ReturnType<typeof createReviewGitHubGet>, path = PR) => get(path, new AbortController().signal);

describe("scoped review HTTP (HT-1..8)", () => {
  test("HT-1 HT-2 HT-3 fixed host GET headers, no cookies/cache/referrer; credential per read", async () => {
    const f = fixture();
    expect(await read(f.get)).toEqual({ value: true });
    await read(f.get, `${PR}/files?per_page=100&page=1`);
    expect(f.signals).toHaveLength(2);
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      expect(call.url.startsWith(ORIGIN + "/repos/rfcclub/anima/")).toBe(true);
      expect(call.url).not.toContain(TOKEN);
      expect(call.init).toMatchObject({
        method: "GET", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "anima-review-collector" },
      });
      expect(call.init).not.toHaveProperty("body");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(f.signals).toContain(call.init.signal as AbortSignal);
    }
  });
  test("HT-2 credential rotation takes effect on the next request without caching", async () => {
    let issued = 0; const tokens: string[] = [];
    const get = createReviewGitHubGet(REPO, 45, { credential: async () => `${TOKEN}-${++issued}`,
      fetch: async (_url, init) => { tokens.push(new Headers(init.headers).get("Authorization")!); return json({}); } });
    await read(get); await read(get);
    expect(tokens).toEqual([`Bearer ${TOKEN}-1`, `Bearer ${TOKEN}-2`]);
  });
  test.each([PR, REF, "/repos/rfcclub/anima/git/ref/heads/feature%2Fguard",
    `${PR}/files?per_page=100&page=30`, `${PR}/commits?per_page=100&page=1`])("HT-1 canonical path %s", async path => {
    const f = fixture(); await read(f.get, path); expect(f.calls[0]!.url).toBe(ORIGIN + path);
  });
  test.each([
    "https://evil.test/x", "//evil.test/x", "/repos/rfcclub/other/pulls/45", "/repos/rfcclub/anima/pulls/46",
    `${PR}#fragment`, `${PR}?x=1`, `${PR}/files?per_page=100&page=0`, `${PR}/files?per_page=100&page=31`,
    `${PR}/files?per_page=100&page=01`, `${PR}/files?page=1&per_page=100`, `${PR}/files?per_page=99&page=1`,
    `${PR}/files?per_page=100&page=1&x=1`, `${PR}/reviews`, `${PR}/../45`, `/repos//rfcclub/anima/pulls/45`,
    "/repos/rfcclub/anima/git/ref/heads/%2e%2e", "/repos/rfcclub/anima/git/ref/heads/a%2F..%2Fmaster",
    "/repos/rfcclub/anima/git/ref/heads/a%2fbranch", "/repos/rfcclub/anima/git/ref/heads/.hidden",
    "/repos/rfcclub/anima/git/ref/heads/a.lock", "/repos/rfcclub/anima/git/ref/heads/a%00b",
    "/repos/rfcclub/anima/git/ref/heads/a%5Cb", "/repos/rfcclub/anima/git/ref/heads/a/b",
    "/repos/rfcclub/anima/git/ref/heads/a..b", `${PR}\n`,
  ])("HT-1 forbidden path refuses before credential or fetch: %s", async path => {
    const f = fixture(); await failure(read(f.get, path), "scope"); expect(f.calls).toEqual([]); expect(f.signals).toEqual([]);
    await failure(read(f.get), "closed");
  });
  test.each([null, undefined, {}, "", " ", "token\n", "a\rb", "a\tb", "a b", "\u00e9", "\x7f", "x".repeat(4097)])(
    "HT-2 unauthorized malformed credential %j refuses without fetch", async token => {
      const f = fixture({ credential: async () => token as string });
      await failure(read(f.get), "credential"); expect(f.calls).toEqual([]);
    });
  test.each(["credential", "fetch"])("HT-2 %s exception text is suppressed", async port => {
    const f = fixture({ [port]: async () => { throw Error(TOKEN + " body private"); } });
    await failure(read(f.get), "read_failed");
  });
  test("HT-2 forged typed credential error cannot forward secret text or status", async () => {
    const f = fixture({ credential: async () => {
      const e = new ReviewHttpError(TOKEN as never, 401); throw e;
    } });
    const e = await failure(read(f.get), "read_failed");
    expect(e.status).toBeUndefined();
  });
  test.each([
    [401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"],
    [500, "server_error"], [503, "server_error"], [206, "http_status"], [302, "http_status"], [304, "http_status"],
  ])("HT-3 status %s is typed %s without response body", async (status, code) => {
    const f = fixture({ fetch: async () => new Response(status === 304 ? null : JSON.stringify({ secret: TOKEN }),
      { status, headers: { "Content-Type": "application/json" } }) });
    await failure(read(f.get), code, status);
  });
  test.each([["99", 99], ["9999999", 3600], ["-1", undefined], ["secret", undefined]])(
    "HT-3 bounded numeric retry-after %s", async (value, expected) => {
      const f = fixture({ fetch: async () => new Response(TOKEN, { status: 429, headers: { "Retry-After": value } }) });
      expect((await failure(read(f.get), "rate_limited", 429)).retryAfterSeconds).toBe(expected);
    });
  test("HT-3 exhausted 403 is rate-limited without exposing other headers", async () => {
    const f = fixture({ fetch: async () => new Response(TOKEN, { status: 403,
      headers: { "x-ratelimit-remaining": "0", "Retry-After": "2", "Location": TOKEN } }) });
    const e = await failure(read(f.get), "rate_limited", 403);
    expect(e.retryAfterSeconds).toBe(2); expect(JSON.stringify(e)).not.toContain(TOKEN);
  });
  test.each(["redirected", "url"])("HT-3 unexpected response %s refuses", async property => {
    const r = json({ value: true });
    Object.defineProperty(r, property, { value: property === "redirected" ? true : "https://evil.test/" + TOKEN });
    const f = fixture({ fetch: async () => r }); await failure(read(f.get), "http_response");
  });
  test.each(["text/html", "text/plain", "application/jsonx", ""])("HT-3 MIME %s refuses", async mime => {
    const f = fixture({ fetch: async () => new Response("{}", { headers: { "Content-Type": mime } }) });
    await failure(read(f.get), "content_type");
  });
  test.each(["not-json " + TOKEN, "null", "true", "1", JSON.stringify(TOKEN)])("HT-3 invalid JSON shape refuses: %s", async body => {
    const f = fixture({ fetch: async () => new Response(body, { headers: { "Content-Type": "application/json" } }) });
    await failure(read(f.get), "json");
  });
  test("HT-3 invalid UTF8 refuses instead of replacement decoding", async () => {
    const f = fixture({ fetch: async () => new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      { headers: { "Content-Type": "application/json" } }) });
    await failure(read(f.get), "json");
  });
  test.each(["-1", "x", "999999999999999999999999"])("HT-4 malformed declared length %s refuses", async value => {
    const f = fixture({ fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": value } }) });
    await failure(read(f.get), "content_length");
  });
  test("HT-4 declared and streamed response byte limits apply with exact boundary accepted", async () => {
    const equal = fixture({ limits: { responseBytes: 2 }, fetch: async () => new Response("{}",
      { headers: { "Content-Type": "application/json", "Content-Length": "2" } }) });
    expect(await read(equal.get)).toEqual({});
    for (const declared of [true, false]) {
      const f = fixture({ limits: { responseBytes: 2 }, fetch: async () => new Response('{"x":1}',
        { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": "7" } : {}) } }) });
      await failure(read(f.get), "response_bytes");
    }
  });
  test("HT-4 session bytes accumulate across reads, exact total allowed, later overflow distinct", async () => {
    const f = fixture({ limits: { sessionBytes: 4 }, fetch: async () => json({}) });
    await read(f.get); await read(f.get);
    await failure(read(f.get), "session_bytes");
  });
  test("HT-4 conservative declared response/session bounds refuse even when actual body is smaller", async () => {
    const response = fixture({ limits: { responseBytes: 2 }, fetch: async () => new Response("{}",
      { headers: { "Content-Type": "application/json", "Content-Length": "7" } }) });
    await failure(read(response.get), "response_bytes");
    let calls = 0;
    const session = fixture({ limits: { sessionBytes: 6 }, fetch: async () => ++calls === 1 ? json({})
      : new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "5" } }) });
    await read(session.get); await failure(read(session.get), "session_bytes");
  });
  test.each([false, true])("HT-5 failed byte limit cancels available reader/body, declared=%s", async declared => {
    let cancelled = false;
    const f = fixture({ limits: { responseBytes: 2 }, fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"x":1}')); }, cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": "7" } : {}) } }) });
    await failure(read(f.get), "response_bytes"); expect(cancelled).toBe(true);
  });
  test("HT-4 request cap exact boundary, no credential on extra request", async () => {
    const f = fixture({ limits: { requests: 2 } }); await read(f.get); await read(f.get);
    await failure(read(f.get), "request_limit"); expect(f.signals).toHaveLength(2); expect(f.calls).toHaveLength(2);
  });
  test.each([["responseBytes", 8 * 1024 * 1024 + 1], ["sessionBytes", 64 * 1024 * 1024 + 1],
    ["requests", 41], ["timeoutMs", 30001], ["requests", 0], ["requests", 1.5], ["requests", "2"]])(
    "HT-4 invalid limit %s=%s refuses", (key, value) => {
      expect(() => fixture({ limits: { [key]: value } as never })).toThrow("review_http:config");
    });
  test.each([["evil/anima", 45], ["rfcclub/../anima", 45], [REPO, 0], [REPO, 1.5], [null, 45]])(
    "HT-1 invalid subject %s/%s", (repo, number) => {
      expect(() => createReviewGitHubGet(repo as string, number,
        { fetch: async () => json({}), credential: async () => TOKEN })).toThrow("review_http:config");
    });
  test("HT-8 no implicit fetch or credential defaults exist", () => {
    expect(() => createReviewGitHubGet(REPO, 45, {} as never)).toThrow("review_http:config");
  });
  test("HT-4 unknown limit key refuses", () => {
    expect(() => fixture({ limits: { unexpected: 1 } as never })).toThrow("review_http:config");
  });
  test.each(["toString", "__proto__"])("regression: HT-4 inherited limit key %s refuses", key => {
    const limits = JSON.parse(`{"${key}":1}`);
    expect(() => fixture({ limits })).toThrow("review_http:config");
  });
  test.each([{ value: null }, { value: [] }, { value: 1 }])("HT-4 malformed limits %j refuse", row => {
    expect(() => fixture({ limits: row.value as never })).toThrow("review_http:config");
  });
  test("HT-5 pre-aborted call never requests credentials", async () => {
    const f = fixture(), c = new AbortController(); c.abort();
    await failure(f.get(PR, c.signal), "aborted"); expect(f.signals).toEqual([]); expect(f.calls).toEqual([]);
  });
  test.each(["credential", "fetch", "body"])("HT-5 never-resolving %s is bounded and aborted", async port => {
    let seen: AbortSignal | undefined, cancelled = false;
    const f = fixture({ limits: { timeoutMs: 20 }, credential: async signal => {
      seen = signal; return port === "credential" ? new Promise<string>(() => {}) : TOKEN;
    }, fetch: async (_url, init) => {
      seen = init.signal as AbortSignal;
      if (port === "fetch") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }),
        { headers: { "Content-Type": "application/json" } });
    } });
    const start = performance.now(); await failure(read(f.get), "timeout");
    expect(performance.now() - start).toBeLessThan(2000); expect(seen?.aborted).toBe(true);
    if (port === "body") expect(cancelled).toBe(true);
    await failure(read(f.get), "closed");
  });
  test.each(["credential", "fetch", "body"])("regression: HT-5 elapsed deadline refuses synchronous %s overrun", async port => {
    const overrun = () => { const until = performance.now() + 60; while (performance.now() < until) {} };
    const f = fixture({ limits: { timeoutMs: 20 },
      credential: async () => { if (port === "credential") overrun(); return TOKEN; },
      fetch: async () => {
        if (port === "fetch") overrun();
        return port === "body"
          ? new Response(new ReadableStream({ pull(controller) {
            overrun(); controller.enqueue(new TextEncoder().encode("{}")); controller.close();
          } }), { headers: { "Content-Type": "application/json" } })
          : json({});
      },
    });
    await failure(read(f.get), "timeout");
  });
  test("regression: HT-5 elapsed deadline refuses synchronous JSON parse overrun", async () => {
    const original = JSON.parse, marker = '{"slow":true}';
    JSON.parse = (text, reviver) => {
      if (text === marker) { const until = performance.now() + 60; while (performance.now() < until) {} }
      return original(text, reviver);
    };
    try {
      const f = fixture({ limits: { timeoutMs: 20 }, fetch: async () => new Response(marker,
        { headers: { "Content-Type": "application/json" } }) });
      await failure(read(f.get), "timeout");
    } finally { JSON.parse = original; }
  });
  test("HT-5 caller abort races a hung credential", async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ limits: { timeoutMs: 100 }, credential: async () => { entered(); return new Promise<string>(() => {}); } });
    const c = new AbortController(), result = f.get(PR, c.signal); await ready; c.abort();
    await failure(result, "aborted");
  });
  test("HT-5 overall deadline spans reads and idle time", async () => {
    const f = fixture({ limits: { timeoutMs: 15 } }); await read(f.get);
    await new Promise(resolve => setTimeout(resolve, 25)); await failure(read(f.get), "timeout");
    expect(f.calls).toHaveLength(1);
  });
  test("HT-5 concurrent call poisons session and aborts first read", async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ limits: { timeoutMs: 100 }, credential: async () => { entered(); return new Promise<string>(() => {}); } });
    const first = failure(read(f.get), "aborted"); await ready; await failure(read(f.get), "busy"); await first;
    await failure(read(f.get), "closed");
  });
  test("HT-6 adapter feeds real collector partial facts without granting eligibility", async () => {
    const head = "a".repeat(40), base = "b".repeat(40), calls: string[] = [];
    const get = createReviewGitHubGet(REPO, 45, { credential: async () => TOKEN, fetch: async url => {
      const path = new URL(url).pathname + new URL(url).search; calls.push(path);
      if (path === PR) return json({ number: 45, state: "open", draft: false, head: { sha: head },
        base: { sha: base, ref: "master", repo: { full_name: REPO } }, user: { login: "eli-gotako[bot]" }, changed_files: 1, commits: 1 });
      if (path === REF) return json({ ref: "refs/heads/master", object: { type: "commit", sha: base } });
      if (path.includes("/files?")) return json([{ filename: "docs/a.md", status: "added" }]);
      return json([{ sha: head, author: { login: "eli-gotako[bot]" }, committer: { login: "web-flow" }, commit: { message: "docs" } }]);
    } });
    const result = await collectReviewBranch(get, REPO, 45);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("expected partial facts");
    expect(calls).toEqual([PR, REF, `${PR}/files?per_page=100&page=1`, `${PR}/commits?per_page=100&page=1`, PR, REF]);
    const audit = auditReviewEligibility(result.snapshot, { apps: { eli: "eli-gotako[bot]" }, bindings: [], now: 100, cooldownMs: 0 });
    expect(audit).toEqual({ automaticMerge: false, reasons: ["atomic_base_guard_unproven", "malformed_snapshot"] });
  });
  test.each([false, true])("HT-6 complete HTTP page2 preserves rename; changed live base=%s", async moved => {
    const head = "a".repeat(40), base = "b".repeat(40), other = "c".repeat(40);
    const files = Array.from({ length: 101 }, (_, i) => ({ filename: `docs/${i}.md`, status: "added" }));
    const renamed = { filename: "src/new.ts", previous_filename: "scripts/ANIMA.ENV", status: "renamed" };
    const commits = Array.from({ length: 101 }, (_, i) => ({
      sha: i === 0 ? head : i.toString(16).padStart(40, "0"), author: { login: "eli-gotako[bot]" },
      committer: { login: i === 100 ? "foreign-user" : "web-flow" }, commit: { message: `change${i}` },
    }));
    let refs = 0; const calls: string[] = [];
    const get = createReviewGitHubGet(REPO, 45, { credential: async () => TOKEN, fetch: async url => {
      const u = new URL(url), path = u.pathname + u.search; calls.push(path);
      if (path === PR) return json({ number: 45, state: "open", draft: false, head: { sha: head },
        base: { sha: base, ref: "master", repo: { full_name: REPO } }, user: { login: "eli-gotako[bot]" }, changed_files: 101, commits: 101 });
      if (path === REF) return json({ ref: "refs/heads/master", object: { type: "commit", sha: moved && ++refs === 2 ? other : base } });
      const page = Number(u.searchParams.get("page"));
      return path.includes("/files?")
        ? json(page === 1 ? files.slice(0, 100) : [renamed])
        : json(commits.slice((page - 1) * 100, page * 100));
    } });
    const result = await collectReviewBranch(get, REPO, 45);
    expect(calls).toEqual([PR, REF, `${PR}/files?per_page=100&page=1`, `${PR}/files?per_page=100&page=2`,
      `${PR}/commits?per_page=100&page=1`, `${PR}/commits?per_page=100&page=2`, PR, REF]);
    if (moved) expect(result).toEqual({ ok: false, collection: "base", reason: "snapshot_changed" });
    else {
      expect(result.ok).toBe(true); if (!result.ok) throw Error("expected complete pages");
      expect(result.snapshot.paths.items[100]).toEqual({ path: renamed.filename, previousPath: renamed.previous_filename });
      expect(result.snapshot.commits.items[100]!.committerLogin).toBe("foreign-user");
    }
  });
  test("HT-6 branch collector currently reduces typed HTTP status to read_failed, not backoff", async () => {
    const f = fixture({ fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }) });
    expect(await collectReviewBranch(f.get, REPO, 45)).toEqual({ ok: false, collection: "metadata", reason: "read_failed" });
  });
  test("HT-3 HT-7 native fetch uses unchanged production init and refuses redirect before target sees credential", async () => {
    let targets = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/target") { targets++; return json({ authorization: request.headers.get("Authorization") }); }
      return Response.redirect(new URL("/target", request.url), 302);
    } });
    try {
      const f = fixture({ fetch: async (url, init) => {
        expect(url).toBe(ORIGIN + PR); expect(init.redirect).toBe("error");
        return fetch(new URL(PR, server.url), init);
      } });
      await failure(read(f.get), "read_failed"); expect(targets).toBe(0);
    } finally { server.stop(true); }
  });
});
