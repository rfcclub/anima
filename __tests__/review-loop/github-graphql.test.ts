import { describe, expect, test } from "bun:test";
import { createReviewGitHubDiscussion } from "../../src/review-loop/github-graphql";
import { ReviewHttpError } from "../../src/review-loop/github-get";
import { collectReviewDiscussion, DISCUSSION_QUERIES } from "../../src/review-loop/discussion";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";

const REPO = "rfcclub/anima", TOKEN = "fixture-only-token", URL = "https://api.github.com/graphql";
const SUBJECT = { owner: "rfcclub", name: "anima", number: 45, baseRef: "refs/heads/feature/base" };
type Kind = keyof typeof DISCUSSION_QUERIES;
type Vars = Record<string, string | number | null>;
type Deps = Parameters<typeof createReviewGitHubDiscussion>[3];
const envelope = () => ({ data: { value: true, legalNull: null } });
const vars = (kind: Kind): Vars => ({ ...SUBJECT, ...(kind === "anchor" ? {} : { after: null }),
  ...(kind === "threadComments" ? { threadId: "PRRT_a-1" } : {}) });
function fixture(overrides: Partial<Deps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [], signals: AbortSignal[] = [];
  const read = createReviewGitHubDiscussion(REPO, 45, "feature/base", {
    credential: async signal => { signals.push(signal); return TOKEN; },
    fetch: async (url, init) => { calls.push({ url, init }); return Response.json(envelope()); }, ...overrides,
  });
  return { read, calls, signals };
}
const call = (f: ReturnType<typeof fixture>, kind: Kind = "reviews", value = vars(kind)) =>
  f.read(DISCUSSION_QUERIES[kind], value, new AbortController().signal);
async function failure(action: Promise<unknown>, code: string) {
  let error: unknown, timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([action, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("fixture wait ceiling")), 1000);
  })]); } catch (e) { error = e; } finally { clearTimeout(timer); }
  expect(error).toBeInstanceOf(ReviewHttpError);
  expect(error).toMatchObject({ code, message: `review_http:${code}` });
  expect(String(error)).not.toContain(TOKEN);
  expect(JSON.stringify(error)).not.toContain(TOKEN);
  return error as ReviewHttpError;
}

describe("fixed GraphQL transport QH-1..8", () => {
  test.each(Object.keys(DISCUSSION_QUERIES) as Kind[])("QH-1 QH-2 exact %s document and variables use one fixed POST", async kind => {
    const f = fixture(); expect(await call(f, kind)).toEqual(envelope());
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(URL);
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit",
      cache: "no-store", referrerPolicy: "no-referrer", headers: {
        Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "anima-review-collector",
      } });
    expect(JSON.parse(init.body as string)).toEqual({ query: DISCUSSION_QUERIES[kind], variables: vars(kind) });
    expect(init.body).not.toContain(TOKEN); expect(url).not.toContain(TOKEN);
    expect(init.signal).toBe(f.signals[0]);
  });
  test("QH-1 copies variables before an awaited credential can rebind them", async () => {
    const value = vars("reviews");
    const f = fixture({ credential: async () => {
      value.owner = "evil"; value.number = 99; value.after = "changed"; return TOKEN;
    } });
    await call(f, "reviews", value);
    expect(JSON.parse(f.calls[0]!.init.body as string).variables).toEqual(vars("reviews"));
  });
  test("QH-1 throwing variable getter refuses as scope before credentials and poisons the session", async () => {
    const value = vars("reviews");
    Object.defineProperty(value, "owner", { enumerable: true, get() { throw Error(TOKEN); } });
    const f = fixture();
    await failure(call(f, "reviews", value), "scope");
    expect(f.signals).toEqual([]); expect(f.calls).toEqual([]);
    await failure(call(f), "closed");
    expect(f.signals).toEqual([]); expect(f.calls).toEqual([]);
  });
  test("QH-1 non-idempotent variable getter is read once and its first value is posted", async () => {
    const value = vars("reviews"); let reads = 0;
    Object.defineProperty(value, "owner", { enumerable: true,
      get() { return ++reads === 1 ? "rfcclub" : "evil"; } });
    const f = fixture();
    expect(await call(f, "reviews", value)).toEqual(envelope());
    expect(reads).toBe(1); expect(f.calls).toHaveLength(1); expect(f.signals).toHaveLength(1);
    expect(JSON.parse(f.calls[0]!.init.body as string).variables).toEqual(vars("reviews"));
  });
  test("QH-2 rotates credentials per request without caching", async () => {
    let issued = 0; const tokens: string[] = [];
    const f = fixture({ credential: async () => `${TOKEN}-${++issued}`, fetch: async (_url, init) => {
      tokens.push(new Headers(init.headers).get("Authorization")!); return Response.json(envelope());
    } });
    await call(f); await call(f, "anchor");
    expect(tokens).toEqual([`Bearer ${TOKEN}-1`, `Bearer ${TOKEN}-2`]);
  });
  test.each(["mutation { deleteIssue { id } }", "subscription { node { id } }", "query { viewer { login } }",
    DISCUSSION_QUERIES.reviews + " ", DISCUSSION_QUERIES.anchor.replace("rateLimit", "viewer"),
    "mutation # " + DISCUSSION_QUERIES.reviews])("QH-1 forbidden nonconstant document refuses without credentials: %s", async document => {
    const f = fixture(); await failure(f.read(document, vars("reviews"), new AbortController().signal), "scope");
    expect(f.calls).toEqual([]); expect(f.signals).toEqual([]); await failure(call(f), "closed");
  });
  const bad: [Kind, Vars][] = [
    ["anchor", { ...vars("anchor"), after: null }], ["reviews", { ...vars("reviews"), extra: "x" }],
    ["reviews", { ...vars("reviews"), owner: "RFCClub" }], ["reviews", { ...vars("reviews"), name: "other" }],
    ["reviews", { ...vars("reviews"), number: 46 }], ["reviews", { ...vars("reviews"), number: "45" }],
    ["reviews", { ...vars("reviews"), baseRef: "refs/heads/master" }],
    ["reviews", { ...vars("reviews"), after: 1 }], ["reviews", { ...vars("reviews"), after: "" }],
    ["reviews", { ...vars("reviews"), after: "white space" }], ["reviews", { ...vars("reviews"), after: "x".repeat(4097) }],
    ["threadComments", { ...vars("threadComments"), threadId: null }],
    ["threadComments", { ...vars("threadComments"), threadId: "x\n" }],
    ["threadComments", { ...vars("threadComments"), threadId: "x".repeat(4097) }],
  ];
  for (const key of Object.keys(vars("threadComments"))) {
    const value = vars("threadComments"); delete value[key]; bad.push(["threadComments", value]);
  }
  test.each(bad)("QH-1 forbidden %s variable set refuses before token/fetch: %j", async (kind, value) => {
    const f = fixture(); await failure(call(f, kind, value), "scope");
    expect(f.signals).toEqual([]); expect(f.calls).toEqual([]); await failure(call(f), "closed");
  });
  test.each(["A+/_=:-9", "x".repeat(4096)])("QH-1 valid opaque cursor and threadId boundary", async id => {
    const f = fixture(); await call(f, "threadComments", { ...vars("threadComments"), threadId: id, after: id });
    expect(f.calls).toHaveLength(1);
  });
  test.each([null, [], "x", 1].map(value => [value] as [unknown]))("QH-1 nonobject variables refuse: %j", async value => {
    const f = fixture(); await failure(call(f, "reviews", value as never), "scope"); expect(f.signals).toEqual([]);
  });
  test.each([
    ["evil/anima", 45, "master"], ["rfcclub/a/b", 45, "master"], [REPO, 0, "master"],
    [REPO, 2147483648, "master"], [REPO, 1.5, "master"], [REPO, 45, ""],
    [REPO, 45, "a..b"], [REPO, 45, ".hidden"], [REPO, 45, "a.lock"],
    [REPO, 45, "a\\b"], [REPO, 45, "a\nb"], [REPO, 45, "a//b"],
  ])("QH-1 invalid constructor subject %s/%s/%s", (repo, number, branch) => {
    expect(() => createReviewGitHubDiscussion(repo as string, number as number, branch as string,
      { fetch: async () => Response.json({}), credential: async () => TOKEN })).toThrow("review_http:config");
  });
  test("QH-1 native callbacks have no implicit defaults", () => {
    expect(() => createReviewGitHubDiscussion(REPO, 45, "master", {} as never)).toThrow("review_http:config");
  });
  test.each([null, "", "a b", "a\nb", "\u00e9", "\x7f", "x".repeat(4097)])("QH-2 unauthorized credential refuses: %j", async token => {
    const f = fixture({ credential: async () => token as string });
    await failure(call(f), "credential"); expect(f.calls).toEqual([]);
  });
  test.each(["credential", "fetch"])("QH-2 callback %s error text is never forwarded", async port => {
    const f = fixture({ [port]: async () => { throw new ReviewHttpError(TOKEN as never, 401); } });
    const e = await failure(call(f), "read_failed"); expect(e.status).toBeUndefined();
  });
  test.each([401, 403, 404, 429, 503, 206, 302, 304])("QH-3 non200 status %s is refused with content-free status", async status => {
    const f = fixture({ fetch: async () => new Response(status === 304 ? null : TOKEN, { status }) });
    const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found"
      : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "http_status";
    expect((await failure(call(f), code)).status).toBe(status);
  });
  test.each([undefined, []].map(value => [value] as [unknown]))("QH-3 absent or empty errors accepts nested nulls: %j", async errors => {
    const f = fixture({ fetch: async () => Response.json({ data: { endCursor: null, ref: null }, ...(errors === undefined ? {} : { errors }) }) });
    expect(await call(f)).toEqual({ data: { endCursor: null, ref: null }, ...(errors === undefined ? {} : { errors }) });
  });
  test.each([null, {}, "error", [{ message: TOKEN }]].map(value => [value] as [unknown]))("QH-3 GraphQL errors %j refuse with no partial data or body", async errors => {
    const f = fixture({ fetch: async () => Response.json({ data: { value: true }, errors }) });
    await failure(call(f), "graphql"); await failure(call(f), "closed");
  });
  test.each([{}, { data: null }, { data: [] }, { data: "x" }, []].map(value => [value] as [unknown]))("QH-3 malformed GraphQL envelope refuses: %j", async body => {
    const f = fixture({ fetch: async () => Response.json(body) }); await failure(call(f), "graphql");
  });
  test.each([["responseBytes", 8388609], ["sessionBytes", 67108865], ["requests", 201], ["timeoutMs", 30001],
    ["requests", 0], ["requests", 1.5], ["unexpected", 1]])("QH-4 raised or malformed %s limit=%s refuses", (key, value) => {
    expect(() => fixture({ limits: { [key]: value } })).toThrow("review_http:config");
  });
  test("QH-4 POST permits200 requests but the201st obtains no token or network", async () => {
    const f = fixture(); for (let i = 0; i < 200; i++) await call(f);
    await failure(call(f), "request_limit"); expect(f.calls).toHaveLength(200); expect(f.signals).toHaveLength(200);
  });
  test.each(["response", "session", "requests"])("QH-4 smaller %s bound is honored through the factory", async kind => {
    const size = new TextEncoder().encode(JSON.stringify(envelope())).length;
    const f = fixture({ limits: kind === "response" ? { responseBytes: size - 1 } : kind === "session"
      ? { sessionBytes: size } : { requests: 1 } });
    if (kind !== "response") await call(f);
    await failure(call(f), kind === "requests" ? "request_limit" : kind === "response" ? "response_bytes" : "session_bytes");
    await failure(call(f), "closed");
  });
  test("QH-5 caller preabort refuses before token", async () => {
    const f = fixture(), c = new AbortController(); c.abort();
    await failure(f.read(DISCUSSION_QUERIES.reviews, vars("reviews"), c.signal), "aborted");
    expect(f.signals).toEqual([]);
  });
  test.each(["credential", "fetch", "body"])("QH-5 never-resolving %s is bounded and requests cancellation", async port => {
    let seen: AbortSignal | undefined;
    const f = fixture({ limits: { timeoutMs: 20 }, credential: async s => {
      seen = s; return port === "credential" ? new Promise<string>(() => {}) : TOKEN;
    }, fetch: async (_url, init) => {
      seen = init.signal as AbortSignal; if (port === "fetch") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }),
        { headers: { "Content-Type": "application/json" } });
    } });
    await failure(call(f), "timeout"); expect(seen?.aborted).toBe(true); await failure(call(f), "closed");
  });
  test("QH-5 overlapping POST poisons and aborts both reads", async () => {
    let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    const f = fixture({ credential: async () => { enter(); return new Promise<string>(() => {}); } });
    const first = failure(call(f), "aborted"); await entered; await failure(call(f), "busy"); await first;
    await failure(call(f), "closed");
  });
  test.each([302, 307, 308])("QH-7 native redirect %s cannot resend token or POST body to target", async status => {
    let targets = 0, sources = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new globalThis.URL(request.url).pathname === "/target") { targets++; return Response.json({}); }
      sources++; expect(request.method).toBe("POST"); expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(await request.text()).query).toBe(DISCUSSION_QUERIES.reviews);
      return Response.redirect(new globalThis.URL("/target", request.url), status);
    } });
    try {
      const f = fixture({ fetch: async (url, init) => {
        expect(url).toBe(URL); return fetch(new globalThis.URL("/graphql", server.url), init);
      } });
      await failure(call(f), "read_failed"); expect(sources).toBe(1); expect(targets).toBe(0);
    } finally { server.stop(true); }
  });
  test.each([false, true])("QH-8 real collector integration; GraphQL errors=%s never grant eligibility", async errors => {
    const head = "a".repeat(40), base = "b".repeat(40);
    const empty = () => ({ totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
    const f = fixture({ fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string); expect(body.variables.baseRef).toBe(SUBJECT.baseRef);
      return Response.json({ data: { repository: { nameWithOwner: REPO,
        ref: { name: "feature/base", target: { __typename: "Commit", oid: base } },
        pullRequest: { number: 45, state: "OPEN", isDraft: false, headRefOid: head, baseRefOid: base,
          baseRefName: "feature/base", reviews: empty(), reviewThreads: empty(), comments: empty() } },
        rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: "2026-10-29T23:00:00Z" } },
        ...(errors ? { errors: [{ message: TOKEN }] } : {}) });
    } });
    const result = await collectReviewDiscussion(REPO, 45, { headSha: head, baseSha: base, baseBranch: "feature/base" }, f.read);
    if (errors) { expect(result).toEqual({ ok: false, collection: "reviews", reason: "read_failed" }); return; }
    expect(result.ok).toBe(true); if (!result.ok) throw Error("expected partial snapshot");
    expect(result.snapshot.rate.observedCost).toBe(4);
    expect(auditReviewEligibility(result.snapshot, { apps: { eli: "eli-gotako[bot]" }, bindings: [], now: 100, cooldownMs: 0 }))
      .toEqual({ automaticMerge: false, reasons: ["atomic_base_guard_unproven", "malformed_snapshot"] });
  });
});
