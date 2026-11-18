import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { _resetGithubTokenCache, handleGithubTool, validateBranch, type GithubDeps } from "../../src/tools/github-app";
import { ReviewBudgets } from "../../src/tools/review-budget";
import type { ToolPolicy } from "../../src/config/types";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const TOKEN = "ghs_TOKEN_THAT_MUST_NEVER_LEAK";
const allowed: ToolPolicy = { allowedTools: ["anima_github"], allowedRoots: ["/work"] };

interface Call { method: string; url: string; auth: string; body: unknown }
let calls: Call[];
let gitRuns: Array<{ args: string[]; cwd: string; env: Record<string, string> }>;
let logLines: string[];
let routes: Array<{ m: string; re: RegExp; res: (body?: any) => { status: number; json: unknown } }>;
let gitResult: { code: number; out: string };

const route = (m: string, re: RegExp, json: unknown, status = 200) => routes.unshift({ m, re, res: () => ({ status, json }) });
const fileAt = (path: string) => route("GET", new RegExp(`/contents/${path.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")}\\?ref=`), { type: "file" });
const routeGraphql = (threads: unknown[], mutation: unknown, hasNextPage = false) =>
  routes.unshift({ m: "POST", re: /\/graphql$/, res: (body) => ({ status: 200, json: String(body?.query).includes("mutation") ? mutation : { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor: "c" }, nodes: threads } } } } } }) });

function deps(): Partial<GithubDeps> {
  return {
    fetch: (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, url, auth: headers.Authorization ?? "", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = routes.find((r) => r.m === method && r.re.test(url));
      if (!hit) return new Response("{}", { status: 404 });
      const { status, json } = hit.res(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch,
    readKeyPem: () => PEM,
    runGit: async (args, opts) => {
      gitRuns.push({ args, cwd: opts.cwd, env: opts.env });
      return gitResult;
    },
    now: () => 1_800_000_000_000,
    appendLog: (l) => logLines.push(l),
  };
}

const run = (agent: string | undefined, args: Record<string, unknown>, policy: ToolPolicy | null = allowed) =>
  handleGithubTool(args, { agentName: agent, policy, cwd: "/work/repo", deps: deps() });

beforeEach(() => {
  _resetGithubTokenCache();
  calls = [];
  gitRuns = [];
  logLines = [];
  gitResult = { code: 0, out: "ok" };
  routes = [];
  route("GET", /\/repos\/rfcclub\/anima\/installation$/, { id: 111 });
  route("POST", /\/app\/installations\/111\/access_tokens$/, { token: TOKEN, expires_at: new Date(1_800_003_600_000).toISOString() });
  // Lowest priority: an issue with no comments, so the duplicate check passes unless a test sets comments.
  route("GET", /\/repos\/rfcclub\/anima\/issues\/\d+\/comments/, []);
});

describe("gate and identity", () => {
  test("SC identity: argument naming another agent is ignored; JWT iss is the session agent's App", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/issues$/, { number: 7, html_url: "https://github.com/rfcclub/anima/issues/7" }, 201);
    const out = await run("finn", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b", agent: "bruno", as: "bruno" });
    expect(out).toContain("ok");
    const jwt = calls[0].auth.replace("Bearer ", "");
    const [h, p, sig] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p, "base64url").toString()).iss).toBe(5204721);
  });

  test("SC identity: unknown or missing session agent -> error, 0 network calls", async () => {
    for (const who of ["mallory", undefined]) {
      const out = await run(who, { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" });
      expect(out).toContain("unknown agent identity");
    }
    expect(calls.length).toBe(0);
  });

  test("SC gate: not in allowedTools (or no policy) -> error, 0 network calls", async () => {
    for (const policy of [{ allowedTools: ["read"] } as ToolPolicy, null]) {
      const out = await run("finn", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" }, policy);
      expect(out).toContain("not in allowedTools");
    }
    expect(calls.length).toBe(0);
  });

  test("SC repo scope: foreign repo -> error, 0 network calls", async () => {
    const out = await run("finn", { action: "issue_create", repo: "someone/else", title: "t", body: "b" });
    expect(out).toContain("repo not allowed");
    expect(calls.length).toBe(0);
  });
});

describe("secrecy", () => {
  test("SC secrecy: GitHub 422 does not echo the token in result or log", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/issues$/, { message: `Validation failed for ${TOKEN}` }, 422);
    const out = await run("finn", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" });
    expect(out).toContain("422");
    expect(out).not.toContain(TOKEN);
    expect(logLines.join("\n")).not.toContain(TOKEN);
    expect(out).not.toContain("PRIVATE KEY");
  });

  test("SC forbidden: GitHub 401 unauthorized and 403 forbidden are reported without the token", async () => {
    for (const code of [401, 403]) {
      route("POST", /\/repos\/rfcclub\/anima\/issues$/, { message: `denied ${TOKEN}` }, code);
      const out = await run("finn", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" });
      expect(out).toContain(String(code));
      expect(out).not.toContain(TOKEN);
    }
  });

  test("SC secrecy: git failure output with the credential is redacted", async () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    gitResult = { code: 1, out: `fatal: auth failed ${TOKEN} / ${basic}` };
    const out = await run("finn", { action: "push", repo: "rfcclub/anima", branch: "feature/issue-56-x" });
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(basic);
  });
});

describe("push guard", () => {
  test("SC push: protected destinations and force forms are refused, 0 git runs, 0 network calls", async () => {
    for (const branch of ["master", "dev", "refs/heads/master", "refs/heads/dev", "HEAD:master", "+feature/x", "--force", "-f", "MASTER", "a/../b", "feature/x:master", ""]) {
      const out = await run("finn", { action: "push", repo: "rfcclub/anima", branch });
      expect(out).toContain("branch not allowed");
    }
    const forced = await run("finn", { action: "push", repo: "rfcclub/anima", branch: "feature/x", force: true });
    expect(forced).toContain("force not allowed");
    expect(gitRuns.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("SC push: feature branch -> one git run with HEAD:refs/heads/<branch>, credential only in env", async () => {
    const out = await run("finn", { action: "push", repo: "rfcclub/anima", branch: "feature/issue-56-x" });
    expect(out).toContain("ok");
    expect(gitRuns.length).toBe(1);
    expect(gitRuns[0].args).toEqual(["push", "https://github.com/rfcclub/anima.git", "HEAD:refs/heads/feature/issue-56-x"]);
    expect(gitRuns[0].args.join(" ")).not.toContain(TOKEN);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(gitRuns[0].env.GIT_CONFIG_VALUE_0).toContain(basic);
    expect(gitRuns[0].env.GIT_CONFIG_KEY_0).toBe("http.extraheader");
  });

  test("SC push: dir outside the agent's allowedRoots is refused", async () => {
    const out = await run("finn", { action: "push", repo: "rfcclub/anima", branch: "feature/x", dir: "/etc" });
    expect(out).toContain("dir not allowed");
    expect(gitRuns.length).toBe(0);
  });

  test("validateBranch accepts normal names", () => {
    expect(validateBranch("feature/issue-56-agent-github-app-tool")).toEqual({ ok: true, branch: "feature/issue-56-agent-github-app-tool" });
    expect(validateBranch("refs/heads/fix/x").ok).toBe(true);
  });
});

describe("issues and PRs", () => {
  test("issue_create posts title, body and labels as the minted token", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/issues$/, { number: 9, html_url: "u" }, 201);
    await run("bruno", { action: "issue_create", repo: "rfcclub/anima", title: "T", body: "B", labels: ["enhancement"] });
    const post = calls.find((c) => c.url.endsWith("/issues"))!;
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(post.body).toEqual({ title: "T", body: "B", labels: ["enhancement"] });
  });

  test("pr_create defaults base to master and refuses a protected head", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/pulls$/, { number: 3, html_url: "u" }, 201);
    await run("bruno", { action: "pr_create", repo: "rfcclub/anima", title: "T", body: "B", head: "feature/x" });
    expect(calls.find((c) => c.url.endsWith("/pulls"))!.body).toEqual({ title: "T", body: "B", head: "feature/x", base: "master" });
    const bad = await run("bruno", { action: "pr_create", repo: "rfcclub/anima", title: "T", body: "B", head: "master" });
    expect(bad).toContain("branch not allowed");
  });

  test("SC-018: pr_create sends draft only when it is exactly true", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/pulls$/, { number: 3, html_url: "u" }, 201);
    for (const args of [
      { action: "pr_create", repo: "rfcclub/anima", title: "T", body: "B", head: "feature/x", draft: true },
      { action: "pr_create", repo: "rfcclub/anima", title: "T", body: "B", head: "feature/x", draft: "true" },
      { action: "pr_create", repo: "rfcclub/anima", title: "T", body: "B", head: "feature/x", draft: 1 },
      { action: "pr_create", repo: "rfcclub/anima", title: "T", body: "B", head: "feature/x" },
    ]) await run("bruno", args);
    const bodies = calls.filter((call) => call.url.endsWith("/pulls")).map((call) => call.body);
    expect(bodies[0]).toEqual({ title: "T", body: "B", head: "feature/x", base: "master", draft: true });
    for (const body of bodies.slice(1)) expect(body).toEqual({ title: "T", body: "B", head: "feature/x", base: "master" });
  });
});

describe("four-eyes", () => {
  test("SC four-eyes: reviewing own PR is refused and nothing is posted", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "finn-gotako[bot]" } });
    const out = await run("finn", { action: "review", repo: "rfcclub/anima", pr: 5, event: "APPROVE", body: "ok" });
    expect(out).toContain("four-eyes");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toBe(false);
  });

  test("review by another App posts the review", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    route("POST", /\/pulls\/5\/reviews$/, { id: 1 }, 200);
    const out = await run("finn", { action: "review", repo: "rfcclub/anima", pr: 5, event: "APPROVE", body: "ok" });
    expect(out).toContain("ok");
    expect(calls.find((c) => c.url.endsWith("/reviews"))!.body).toEqual({ event: "APPROVE", body: "ok" });
  });

  test("SC approve: another App ticks the checkbox", async () => {
    route("GET", /\/issues\/56$/, { user: { login: "example-author" } });
    route("GET", /\/issues\/56\/comments/, [{ id: 42, body: "<!-- orca-approve -->\n- [ ] Approve\n\nA reviewer ticks" }]);
    route("PATCH", /\/issues\/comments\/42$/, { id: 42 });
    const out = await run("finn", { action: "approve_intent", repo: "rfcclub/anima", issue: 56 });
    expect(out).toContain("ok");
    expect((calls.find((c) => c.method === "PATCH")!.body as { body: string }).body).toContain("- [x] Approve");
  });

  test("SC four-eyes: approving an intent the same App authored is refused", async () => {
    route("GET", /\/issues\/56$/, { user: { login: "finn-gotako[bot]" } });
    const out = await run("finn", { action: "approve_intent", repo: "rfcclub/anima", issue: 56 });
    expect(out).toContain("four-eyes");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("issue_comment", () => {
  test("SC comment: posted as the session agent, extra agent argument ignored", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/issues\/58\/comments$/, { id: 1, html_url: "https://github.com/rfcclub/anima/issues/58#issuecomment-1" }, 201);
    const out = await run("finn", { action: "issue_comment", repo: "rfcclub/anima", issue: 58, body: "needs a measurable pass criterion", agent: "bruno" });
    expect(out).toContain("ok");
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/58/comments"))!;
    expect(post.body).toEqual({ body: "needs a measurable pass criterion" });
    const jwt = calls[0].auth.replace("Bearer ", "");
    expect(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).iss).toBe(5204721);
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("SC comment: foreign repo is refused (forbidden), 0 network calls", async () => {
    const out = await run("finn", { action: "issue_comment", repo: "someone/else", issue: 58, body: "x" });
    expect(out).toContain("repo not allowed");
    expect(calls.length).toBe(0);
  });

  test("SC comment: empty body or bad issue number is refused, 0 network calls", async () => {
    for (const args of [{ issue: 58, body: "" }, { issue: 58 }, { body: "x" }, { issue: null, body: "x" }, { issue: 0, body: "x" }, { issue: "abc", body: "x" }, { issue: 1.5, body: "x" }]) {
      const out = await run("finn", { action: "issue_comment", repo: "rfcclub/anima", ...args });
      expect(out).toContain("Error");
    }
    expect(calls.length).toBe(0);
  });

  test("SC comment: GitHub 403 forbidden does not echo the token", async () => {
    route("POST", /\/issues\/58\/comments$/, { message: `denied ${TOKEN}` }, 403);
    const out = await run("finn", { action: "issue_comment", repo: "rfcclub/anima", issue: 58, body: "x" });
    expect(out).toContain("403");
    expect(out).not.toContain(TOKEN);
    expect(logLines.join("\n")).not.toContain(TOKEN);
  });

  test("SC log: one line per issue_comment call with target issue#58", async () => {
    route("POST", /\/issues\/58\/comments$/, { id: 1, html_url: "u" }, 201);
    await run("finn", { action: "issue_comment", repo: "rfcclub/anima", issue: 58, body: "x" });
    expect(logLines.length).toBe(1);
    expect(JSON.parse(logLines[0])).toMatchObject({ agent: "finn", action: "issue_comment", repo: "rfcclub/anima", target: "issue#58", ok: true });
  });
});

describe("review inline comments", () => {
  test("SC inline: comments are sent as inline review comments on the right side", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" }, head: { sha: "abc123" } });
    fileAt("src/a.ts");
    route("POST", /\/pulls\/5\/reviews$/, { id: 1 }, 200);
    const out = await run("finn", { action: "review", repo: "rfcclub/anima", pr: 5, event: "REQUEST_CHANGES", body: "see inline", comments: [{ path: "src/a.ts", line: 12, body: "bound this" }] });
    expect(out).toContain("ok");
    expect(calls.find((c) => c.url.endsWith("/reviews"))!.body).toEqual({ event: "REQUEST_CHANGES", body: "see inline", comments: [{ path: "src/a.ts", line: 12, body: "bound this", side: "RIGHT" }] });
  });

  test("SC inline: malformed inline comment is refused, 0 network calls", async () => {
    for (const comments of [[{ path: "", line: 12, body: "x" }], [{ path: "a.ts", line: 0, body: "x" }], [{ path: "a.ts", line: 3, body: "" }], [{ path: "a.ts", line: 1.5, body: "x" }], "nope"]) {
      const out = await run("finn", { action: "review", repo: "rfcclub/anima", pr: 5, event: "COMMENT", body: "b", comments });
      expect(out).toContain("Error");
    }
    expect(calls.length).toBe(0);
  });
});

describe("review inline comment limit", () => {
  test("SC inline: more than 50 inline comments in one review is refused, 0 network calls", async () => {
    const comments = Array.from({ length: 51 }, (_, i) => ({ path: "a.ts", line: i + 1, body: "x" }));
    const out = await run("finn", { action: "review", repo: "rfcclub/anima", pr: 5, event: "COMMENT", body: "b", comments });
    expect(out).toContain("at most 50");
    expect(calls.length).toBe(0);
  });
});

describe("review threads", () => {
  const thread = (id: string, isResolved: boolean) => ({ id, isResolved, path: "src/a.ts", line: 12, comments: { nodes: [{ databaseId: 99, author: { login: "finn-gotako[bot]" }, body: "bound this" }] } });

  test("SC threads: lists only unresolved threads with id, path, line and comment", async () => {
    routeGraphql([thread("PRRT_1", false), thread("PRRT_2", true)], {});
    const out = await run("bruno", { action: "review_threads", repo: "rfcclub/anima", pr: 5 });
    expect(out).toContain("PRRT_1");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("bound this");
    expect(out).not.toContain("PRRT_2");
    expect(calls.find((c) => c.url.endsWith("/graphql"))!.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("SC reply: posts into the thread of the given comment", async () => {
    route("GET", /\/pulls\/comments\/99$/, { pull_request_url: "https://api.github.com/repos/rfcclub/anima/pulls/5" });
    route("POST", /\/pulls\/5\/comments\/99\/replies$/, { id: 100, html_url: "u" }, 201);
    const out = await run("bruno", { action: "review_reply", repo: "rfcclub/anima", pr: 5, comment: 99, body: "fixed in abc123" });
    expect(out).toContain("ok");
    expect(calls.find((c) => c.url.endsWith("/comments/99/replies"))!.body).toEqual({ body: "fixed in abc123" });
  });

  test("SC reply: a comment that belongs to another PR is refused, nothing is posted", async () => {
    route("GET", /\/pulls\/comments\/99$/, { pull_request_url: "https://api.github.com/repos/rfcclub/anima/pulls/6" });
    const out = await run("bruno", { action: "review_reply", repo: "rfcclub/anima", pr: 5, comment: 99, body: "x" });
    expect(out).toContain("not a review comment of pull request 5");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/replies"))).toBe(false);
  });

  test("SC reply: bad pr, comment or empty body is refused, 0 network calls", async () => {
    for (const args of [{ pr: 0, comment: 99, body: "x" }, { pr: 5, comment: "a", body: "x" }, { pr: 5, comment: 99, body: "" }]) {
      expect(await run("bruno", { action: "review_reply", repo: "rfcclub/anima", ...args })).toContain("Error");
    }
    expect(calls.length).toBe(0);
  });

  test("SC resolve four-eyes: only the PR author's App may resolve, 0 mutations otherwise", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    const out = await run("finn", { action: "review_resolve", repo: "rfcclub/anima", pr: 5, thread: "PRRT_1" });
    expect(out).toContain("four-eyes");
    expect(calls.some((c) => c.url.endsWith("/graphql"))).toBe(false);
  });

  test("SC resolve: the PR author's App resolves the thread through GraphQL", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    routeGraphql([thread("PRRT_1", false)], { data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } });
    const out = await run("bruno", { action: "review_resolve", repo: "rfcclub/anima", pr: 5, thread: "PRRT_1" });
    expect(out).toContain("ok");
    const gql = calls.filter((c) => c.url.endsWith("/graphql")).find((c) => JSON.stringify(c.body).includes("mutation"))!;
    expect(JSON.stringify(gql.body)).toContain("resolveReviewThread");
    expect(JSON.stringify(gql.body)).toContain("PRRT_1");
  });

  test("SC resolve: a thread that is not on this PR is refused, 0 mutations (no cross-PR resolve)", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    routeGraphql([thread("PRRT_OTHER_PR_NOT_HERE", false)], { data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } });
    const out = await run("bruno", { action: "review_resolve", repo: "rfcclub/anima", pr: 5, thread: "PRRT_1" });
    expect(out).toContain("not a review thread");
    expect(calls.some((c) => JSON.stringify(c.body ?? "").includes("mutation"))).toBe(false);
  });

  test("SC resolve: with a truncated thread list a missing thread is refused as unverifiable", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    routeGraphql([thread("PRRT_OTHER", false)], {}, true);
    const out = await run("bruno", { action: "review_resolve", repo: "rfcclub/anima", pr: 5, thread: "PRRT_1" });
    expect(out).toContain("refusing to resolve");
    expect(calls.some((c) => JSON.stringify(c.body ?? "").includes("mutation"))).toBe(false);
  });

  test("SC threads: first page sends a null cursor against a nullable $after variable", async () => {
    routeGraphql([thread("PRRT_1", false)], {});
    await run("bruno", { action: "review_threads", repo: "rfcclub/anima", pr: 5 });
    const first = calls.find((c) => c.url.endsWith("/graphql"))!.body as { query: string; variables: { after: unknown } };
    expect(first.variables.after).toBeNull();
    expect(first.query).toContain("$after:String)");
    expect(first.query).not.toContain("$after:String!");
  });

  test("SC resolve: a mutation that does not end resolved is reported as an error", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    routeGraphql([thread("PRRT_1", false)], { data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } } });
    const out = await run("bruno", { action: "review_resolve", repo: "rfcclub/anima", pr: 5, thread: "PRRT_1" });
    expect(out).toContain("not resolved");
  });

  test("SC resolve: non-author refusal names the PR author", async () => {
    route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" } });
    const out = await run("finn", { action: "review_resolve", repo: "rfcclub/anima", pr: 5, thread: "PRRT_1" });
    expect(out).toContain("bruno-gotako[bot]");
  });

  test("SC threads: unknown PR is an error, not an empty list", async () => {
    routes.unshift({ m: "POST", re: /\/graphql$/, res: () => ({ status: 200, json: { data: { repository: { pullRequest: null } } } }) });
    const out = await run("bruno", { action: "review_threads", repo: "rfcclub/anima", pr: 999 });
    expect(out).toContain("not found");
    expect(out).not.toContain('"threads"');
  });

  test("SC threads: more than one page is fetched and a hit page limit is flagged as truncated", async () => {
    routeGraphql([thread("PRRT_1", false)], {}, true);
    const out = await run("bruno", { action: "review_threads", repo: "rfcclub/anima", pr: 5 });
    expect(JSON.parse(out).truncated).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/graphql")).length).toBe(10);
  });

  test("SC reply: a reviewer that is not the PR author may reply too, and non-ASCII text passes through", async () => {
    route("GET", /\/pulls\/comments\/99$/, { pull_request_url: "https://api.github.com/repos/rfcclub/anima/pulls/5" });
    route("POST", /\/pulls\/5\/comments\/99\/replies$/, { id: 100, html_url: "u" }, 201);
    const out = await run("finn", { action: "review_reply", repo: "rfcclub/anima", pr: 5, comment: 99, body: "ok, understood ✓" });
    expect(out).toContain("ok");
    expect(calls.find((c) => c.url.endsWith("/replies"))!.body).toEqual({ body: "ok, understood ✓" });
  });

  test("SC scope: foreign repo is refused (forbidden) for every thread verb, 0 network calls", async () => {
    for (const action of ["review_threads", "review_reply", "review_resolve"]) {
      const out = await run("bruno", { action, repo: "someone/else", pr: 5, comment: 99, thread: "PRRT_1", body: "x" });
      expect(out).toContain("repo not allowed");
    }
    expect(calls.length).toBe(0);
  });

  test("SC log: one line per thread call", async () => {
    route("GET", /\/pulls\/comments\/99$/, { pull_request_url: "https://api.github.com/repos/rfcclub/anima/pulls/5" });
    route("POST", /\/pulls\/5\/comments\/99\/replies$/, { id: 100, html_url: "u" }, 201);
    await run("bruno", { action: "review_reply", repo: "rfcclub/anima", pr: 5, comment: 99, body: "x" });
    expect(logLines.length).toBe(1);
    expect(JSON.parse(logLines[0])).toMatchObject({ agent: "bruno", action: "review_reply", target: "pr#5", ok: true });
  });
});

describe("link addressing", () => {
  test("SC link: review by url alone posts to the repo and PR of the link", async () => {
    route("GET", /\/repos\/rfcclub\/orca\/installation$/, { id: 111 });
    route("GET", /\/repos\/rfcclub\/orca\/pulls\/21$/, { user: { login: "example-author" }, head: { sha: "abc123" } });
    route("POST", /\/repos\/rfcclub\/orca\/pulls\/21\/reviews$/, { id: 1 }, 200);
    const out = await run("finn", { action: "review", url: "https://github.com/rfcclub/orca/pull/21", event: "APPROVE", body: "No findings" });
    expect(out).toContain("ok");
    expect(calls.find((c) => c.url.endsWith("/repos/rfcclub/orca/pulls/21/reviews"))!.body).toEqual({ event: "APPROVE", body: "No findings" });
  });

  test("SC link: issue_comment accepts an issue link and approve_intent an issue link", async () => {
    route("POST", /\/issues\/58\/comments$/, { id: 1, html_url: "u" }, 201);
    const out = await run("finn", { action: "issue_comment", url: "https://github.com/rfcclub/anima/issues/58", body: "x" });
    expect(out).toContain("ok");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/58/comments"))).toBe(true);
  });

  test("SC link: another owner is refused (forbidden), 0 network calls", async () => {
    const out = await run("finn", { action: "review", url: "https://github.com/GotakoVN/seal-gate/pull/1", event: "COMMENT", body: "x" });
    expect(out).toContain("repo not allowed");
    expect(calls.length).toBe(0);
  });

  test("SC link: a url that disagrees with repo, pr or issue is refused, 0 network calls", async () => {
    for (const extra of [{ pr: 22 }, { repo: "rfcclub/anima" }]) {
      const out = await run("finn", { action: "review", url: "https://github.com/rfcclub/orca/pull/21", event: "COMMENT", body: "x", ...extra });
      expect(out).toContain("disagree");
    }
    const out = await run("finn", { action: "issue_comment", url: "https://github.com/rfcclub/anima/issues/58", issue: 59, body: "x" });
    expect(out).toContain("disagree");
    expect(calls.length).toBe(0);
  });

  test("SC link: wrong kind of link or not a GitHub link is refused, 0 network calls", async () => {
    const cases: Array<Record<string, unknown>> = [
      { action: "review", url: "https://github.com/rfcclub/anima/issues/58", event: "COMMENT", body: "x" },
      { action: "approve_intent", url: "https://github.com/rfcclub/anima/pull/5" },
      { action: "review_threads", url: "https://github.com/rfcclub/anima/issues/5" },
      { action: "review", url: "https://example.com/x", event: "COMMENT", body: "x" },
      { action: "review", url: "not a url", event: "COMMENT", body: "x" },
    ];
    for (const c of cases) expect(await run("finn", c)).toContain("Error");
    expect(calls.length).toBe(0);
  });

  test("SC link: thread verbs take a pull link", async () => {
    route("POST", /\/pulls\/5\/comments\/99\/replies$/, { id: 100, html_url: "u" }, 201);
    route("GET", /\/pulls\/comments\/99$/, { pull_request_url: "https://api.github.com/repos/rfcclub/anima/pulls/5" });
    const out = await run("bruno", { action: "review_reply", url: "https://github.com/rfcclub/anima/pull/5", comment: 99, body: "fixed" });
    expect(out).toContain("ok");
  });
});

describe("citation check", () => {
  const prRoute = () => route("GET", /\/pulls\/5$/, { user: { login: "bruno-gotako[bot]" }, head: { sha: "abc123" } });
  const reviews = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/5/reviews"));
  const review = (body: string, extra: Record<string, unknown> = {}) => run("finn", { action: "review", repo: "rfcclub/anima", pr: 5, event: "REQUEST_CHANGES", body, ...extra });
  beforeEach(() => {
    route("POST", /\/pulls\/5\/reviews$/, { id: 1 }, 200);
    prRoute();
  });

  test("SC cite: a file that does not exist at the PR head is refused naming it, 0 review POSTs", async () => {
    const out = await review("1. surface/index.ts:78 resolvePath is unchecked");
    expect(out).toContain("surface/index.ts");
    expect(out).toContain("not found at the PR head");
    expect(reviews().length).toBe(0);
  });

  test("SC cite: an existing file is accepted and the review is posted", async () => {
    fileAt("src/loop.ts");
    const out = await review("1. src/loop.ts:3 the import changed");
    expect(out).toContain("ok");
    expect(reviews().length).toBe(1);
    expect(calls.find((c) => c.url.includes("/contents/src/loop.ts"))!.url).toContain("ref=abc123");
  });

  test("SC cite: a file at the head that the PR does not change is accepted", async () => {
    fileAt("package.json");
    route("GET", /\/pulls\/5\/files/, [{ filename: "src/loop.ts" }]);
    expect(await review("package.json already lists it")).toContain("ok");
    expect(reviews().length).toBe(1);
  });

  test("SC cite: a bare file name is matched against the files of the PR", async () => {
    route("GET", /\/pulls\/5\/files/, [{ filename: "src/loop.ts" }]);
    expect(await review("loop.ts reads the plan")).toContain("ok");
    expect(reviews().length).toBe(1);
  });

  test("SC cite: an inline comment on a missing file is refused, 0 review POSTs", async () => {
    const out = await review("see inline", { comments: [{ path: "nope/missing.ts", line: 3, body: "x" }] });
    expect(out).toContain("nope/missing.ts");
    expect(reviews().length).toBe(0);
  });

  test("SC cite: if GitHub cannot answer the existence check the review is refused, not posted", async () => {
    route("GET", /\/contents\/src\/loop\.ts\?ref=/, { message: `boom ${TOKEN}` }, 500);
    const out = await review("src/loop.ts is fine");
    expect(out).toContain("could not verify");
    expect(out).not.toContain(TOKEN);
    expect(reviews().length).toBe(0);
  });

  test("SC cite: more than 20 distinct cited files is refused, no review POST", async () => {
    const body = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`).join(" ");
    const out = await review(body);
    expect(out).toContain("at most 20");
    expect(reviews().length).toBe(0);
  });

  test("SC cite: a review without any file path makes no existence check", async () => {
    expect(await review("No findings. v1.2.3 is fine, e.g. the tests pass.")).toContain("ok");
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
    expect(reviews().length).toBe(1);
  });

  test("SC cite: product names such as Node.js are prose, not citations", async () => {
    expect(await review("Needs Node.js 22 and Next.js")).toContain("ok");
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
  });

  test("SC cite: URLs and a/ b/ diff prefixes are not mistaken for missing files", async () => {
    fileAt("src/loop.ts");
    const out = await review("see https://github.com/rfcclub/anima/blob/master/docs/x.md and b/src/loop.ts");
    expect(out).toContain("ok");
  });
});

describe("call log", () => {
  test("SC log: one JSON line per call, refused calls included, no credentials", async () => {
    route("POST", /\/repos\/rfcclub\/anima\/issues$/, { number: 1, html_url: "u" }, 201);
    await run("finn", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" });
    await run("finn", { action: "push", repo: "rfcclub/anima", branch: "master" });
    expect(logLines.length).toBe(2);
    const [a, b] = logLines.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ agent: "finn", action: "issue_create", repo: "rfcclub/anima", ok: true });
    expect(b).toMatchObject({ agent: "finn", action: "push", ok: false });
    expect(logLines.join("")).not.toContain(TOKEN);
  });
});

describe("review budget and duplicate guard", () => {
  const NOW = 1_800_000_000_000;
  const BOT = "cleo-gotako[bot]";
  const POST_COMMENT = (c: Call) => c.method === "POST" && /\/issues\/299\/comments$/.test(c.url);
  let budgets: ReviewBudgets;

  const as = (agent: string, args: Record<string, unknown>) =>
    handleGithubTool(args, { agentName: agent, policy: allowed, cwd: "/work/repo", deps: { ...deps(), budgets } });
  const comment = (body: string, issue = 299) => as("cleo", { action: "issue_comment", repo: "rfcclub/anima", issue, body });
  const approve = (issue = 299) => as("cleo", { action: "approve_intent", repo: "rfcclub/anima", issue });
  const posted = () => calls.filter(POST_COMMENT).length;
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const lastAudit = () => JSON.parse(logLines[logLines.length - 1]);

  beforeEach(() => {
    budgets = new ReviewBudgets();
    budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299 });
    route("GET", /\/repos\/rfcclub\/anima\/installation$/, { id: 111 });
    route("POST", /\/issues\/299\/comments$/, { id: 1, html_url: "https://github.com/rfcclub/anima/issues/299#issuecomment-1" }, 201);
    route("GET", /\/issues\/299$/, { user: { login: "example-author" } });
    route("GET", /\/issues\/299\/comments/, [{ id: 42, user: { login: "github-actions[bot]" }, body: "<!-- orca-approve -->\n- [ ] Approve", created_at: ago(500) }]);
    route("PATCH", /\/issues\/comments\/42$/, { id: 42 });
  });

  test("SC-001 a second comment is refused and only one is posted", async () => {
    expect(await comment("first verdict")).toContain("ok");
    const out = await comment("second, different words");
    expect(out).toContain("verdict already recorded");
    expect(posted()).toBe(1);
  });

  test("SC-002 a comment after an approval is refused", async () => {
    expect(await approve()).toContain("ok");
    expect(await comment("too late")).toContain("verdict already recorded");
    expect(posted()).toBe(0);
  });

  test("SC-003 an approval after a comment is refused and nothing is ticked", async () => {
    expect(await comment("objection")).toContain("ok");
    expect(await approve()).toContain("verdict already recorded");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("SC-004 three failures use the attempts; the fourth makes no request", async () => {
    route("POST", /\/issues\/299\/comments$/, { message: "boom" }, 500);
    for (let i = 0; i < 3; i++) expect(await comment(`try ${i}`)).toContain("500");
    const before = calls.length;
    const out = await comment("try 3");
    expect(out).toContain("attempt limit");
    expect(calls.length).toBe(before);
  });

  test("SC-005 a failure then a success; the third call is refused as recorded", async () => {
    route("POST", /\/issues\/299\/comments$/, { message: "boom" }, 500);
    expect(await comment("one")).toContain("500");
    route("POST", /\/issues\/299\/comments$/, { id: 2, html_url: "u" }, 201);
    expect(await comment("two")).toContain("ok");
    expect(await comment("three")).toContain("verdict already recorded");
  });

  test("SC-006 another issue is refused before any request and costs no attempt", async () => {
    const before = calls.length;
    const out = await comment("elsewhere", 300);
    expect(out).toContain("not allowed during an intent review");
    expect(calls.length).toBe(before);
    expect(budgets.active("cleo")!.attemptsLeft).toBe(3);
  });

  test("SC-007 another action is refused", async () => {
    const out = await as("cleo", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" });
    expect(out).toContain("not allowed during an intent review");
    expect(calls.length).toBe(0);
  });

  test("SC-011 with no budget the comment posts as before", async () => {
    budgets.begin("cleo", { repo: "rfcclub/anima", issue: 1 })(); // set then released: no budget
    expect(budgets.active("cleo")).toBeUndefined();
    expect(await comment("a")).toContain("ok");
    expect(await comment("b")).toContain("ok");
    expect(posted()).toBe(2);
    expect(await as("cleo", { action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" })).not.toContain("not allowed");
  });

  describe("duplicates", () => {
    beforeEach(() => budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299 })()); // no budget: duplicates are checked on their own

    test("SC-012 the same body by the same App within the window is refused", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "Not ready: D1 is open.", created_at: ago(5) }]);
      const out = await comment("  not ready:   d1 is open. ");
      expect(out).toContain("duplicate comment");
      expect(posted()).toBe(0);
    });

    test("SC-013 a different body is posted", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "something else", created_at: ago(5) }]);
      expect(await comment("a new body")).toContain("ok");
    });

    test("SC-014 the same body 90 minutes ago is posted", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "same", created_at: ago(90) }]);
      expect(await comment("same")).toContain("ok");
    });

    test("SC-015 another author's identical comment does not count", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: "pia-gotako[bot]" }, body: "same", created_at: ago(5) }]);
      expect(await comment("same")).toContain("ok");
    });

    test("SC-016 unreadable comments: refused, nothing posted", async () => {
      route("GET", /\/issues\/299\/comments/, { message: "nope" }, 500);
      const out = await comment("anything");
      expect(out).toContain("could not verify");
      expect(posted()).toBe(0);
    });

    test("the comments are read with a since bound", async () => {
      await comment("x");
      const read = calls.find((c) => c.method === "GET" && /\/issues\/299\/comments\?/.test(c.url))!;
      expect(read.url).toContain(`since=${encodeURIComponent(ago(60))}`);
      expect(read.url).toContain("per_page=100");
    });

    test("a refused duplicate gives its attempt back and keeps the verdict", async () => {
      budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299 });
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "same", created_at: ago(5) }]);
      expect(await comment("same")).toContain("duplicate comment");
      expect(budgets.active("cleo")).toMatchObject({ attemptsLeft: 3, verdictsLeft: 1 });
      expect(await comment("a different and honest verdict")).toContain("ok");
      expect(budgets.active("cleo")!.verdictsLeft).toBe(0);
    });
  });

  describe("revision-aware duplicates and reserved verdict ", () => {
    const R1 = "aaaaaaaaaaaa";
    const R2 = "bbbbbbbbbbbb";
    const marker = (r: string) => `<!-- anima-review-rev:${r} -->`;
    const approval = (r: string, login: string) => `<!-- anima-review-approval:${r} by:${login} -->`;
    beforeEach(() => { budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299, revision: R1 }); });

    test("the posted verdict carries the revision marker", async () => {
      expect(await comment("Not ready: D1 is open.")).toContain("ok");
      const post = calls.find(POST_COMMENT)!;
      expect((post.body as { body: string }).body).toBe(`Not ready: D1 is open.\n\n${marker(R1)}`);
    });

    test("the same text for the same revision is refused (the earlier verdict is on record)", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: `Not ready: D1 is open.\n\n${marker(R1)}`, created_at: ago(5) }]);
      expect(await comment("Not ready: D1 is open.")).toContain("verdict already recorded");
      expect(posted()).toBe(0);
    });

    test("the same text after the issue was edited (another revision) is posted", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: `Not ready: D1 is open.\n\n${marker(R2)}`, created_at: ago(5) }]);
      expect(await comment("Not ready: D1 is open.")).toContain("ok");
      expect(posted()).toBe(1);
    });

    test("an earlier comment with no marker does not block a review of a known revision", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "Not ready: D1 is open.", created_at: ago(5) }]);
      expect(await comment("Not ready: D1 is open.")).toContain("ok");
    });

    test("a retried job: an earlier verdict for this revision, differently worded, blocks a new comment", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: `Objection: D1 is open.\n\n${marker(R1)}`, created_at: ago(500) }]);
      const out = await comment("A completely different objection");
      expect(out).toContain("verdict already recorded");
      expect(posted()).toBe(0);
      expect(lastAudit().reason).toBe("verdict-recorded");
    });

    test("a retried job cannot approve after an earlier objection for this revision", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: `Objection\n\n${marker(R1)}`, created_at: ago(500) }]);
      expect(await approve()).toContain("verdict already recorded");
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    test("a retried job cannot object after an earlier approval (the ticked box is the record)", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 42, user: { login: "github-actions[bot]" }, body: `<!-- orca-approve -->\n- [x] Approve\n\n${approval(R1, BOT)}`, created_at: ago(500) }]);
      const out = await comment("An objection that contradicts the approval");
      expect(out).toContain("verdict already recorded");
      expect(posted()).toBe(0);
    });

    test("a box ticked for an older revision, by a person, or by another reviewer does not block this reviewer", async () => {
      for (const body of [`<!-- orca-approve -->\n- [x] Approve\n\n${approval(R2, BOT)}`, "<!-- orca-approve -->\n- [x] Approve", `<!-- orca-approve -->\n- [x] Approve\n\n${approval(R1, "pia-gotako[bot]")}`]) {
        budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299, revision: R1 }); // a fresh turn each time
        route("GET", /\/issues\/299\/comments/, [{ id: 42, user: { login: "github-actions[bot]" }, body, created_at: ago(500) }]);
        expect(await comment(`A verdict on the new revision ${body.length}`)).toContain("ok");
      }
    });

    test("a lookalike box by another author, carrying our marker, is not a recorded approval", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 99, user: { login: "someone-else" }, body: `<!-- orca-approve -->\n- [x] Approve\n\n${approval(R1, BOT)}`, created_at: ago(5) }]);
      expect(await comment("An honest objection")).toContain("ok");
    });

    test("the approval tick carries the revision marker so a retry can see it", async () => {
      expect(await approve()).toContain("ok");
      const patch = calls.find((c) => c.method === "PATCH")!;
      expect((patch.body as { body: string }).body).toBe(`<!-- orca-approve -->\n- [x] Approve\n\n${approval(R1, BOT)}`);
    });

    test("an unticked approval box does not block an objection", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 42, user: { login: "github-actions[bot]" }, body: "<!-- orca-approve -->\n- [ ] Approve", created_at: ago(500) }]);
      expect(await comment("An objection")).toContain("ok");
    });

    test("a verdict for another revision, or by another author, does not block", async () => {
      route("GET", /\/issues\/299\/comments/, [
        { id: 7, user: { login: BOT }, body: `Old objection\n\n${marker(R2)}`, created_at: ago(500) },
        { id: 8, user: { login: "pia-gotako[bot]" }, body: `Other reviewer\n\n${marker(R1)}`, created_at: ago(5) },
      ]);
      expect(await comment("Fresh verdict")).toContain("ok");
    });

    test("an unreadable comment list refuses the approval too (fail closed)", async () => {
      route("GET", /\/issues\/299\/comments/, { message: "nope" }, 500);
      expect(await approve()).toContain("could not verify");
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    test("two calls in flight cannot both write a verdict", async () => {
      const [a, b] = await Promise.all([comment("verdict one"), approve()]);
      const ok = [a, b].filter((r) => r.includes('"status":"ok"'));
      expect(ok.length).toBe(1);
      expect([a, b].some((r) => r.includes("verdict already recorded"))).toBe(true);
      expect(posted() + calls.filter((c) => c.method === "PATCH").length).toBe(1);
    });

    test("a failed write gives the verdict back so the reviewer can retry", async () => {
      route("POST", /\/issues\/299\/comments$/, { message: "boom" }, 500);
      expect(await comment("one")).toContain("500");
      expect(budgets.active("cleo")).toMatchObject({ verdictsLeft: 1, attemptsLeft: 2 });
    });

    test("a looping reviewer with a verdict on record stops at the attempt limit", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: `same\n\n${marker(R1)}`, created_at: ago(1) }]);
      const outs: string[] = [];
      for (let i = 0; i < 6; i++) outs.push(await comment("same"));
      expect(outs.slice(0, 3).every((o) => o.includes("verdict already recorded"))).toBe(true);
      expect(outs.slice(3).every((o) => o.includes("attempt limit"))).toBe(true);
      expect(posted()).toBe(0);
    });

    test("without a revision the duplicate rule still refunds once and stops at the limit", async () => {
      budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299 });
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "same", created_at: ago(1) }]);
      const outs: string[] = [];
      for (let i = 0; i < 6; i++) outs.push(await comment("same"));
      expect(outs.filter((o) => o.includes("duplicate comment")).length).toBe(4);
      expect(outs.slice(4).every((o) => o.includes("attempt limit"))).toBe(true);
    });
  });

  describe("the duplicate similarity rule is configuration", () => {
    const KEY = "ANIMA_REVIEW_DUPLICATE_MATCH";
    let saved: string | undefined;
    beforeEach(() => { saved = process.env[KEY]; budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299 })(); });
    afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

    test("by default case and spacing do not make a different comment", async () => {
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "Not ready:  D1 is open.", created_at: ago(5) }]);
      expect(await comment("not ready: d1 is open.")).toContain("duplicate comment");
    });

    test("exact mode treats a changed case or spacing as a new comment", async () => {
      process.env[KEY] = "exact";
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "Not ready:  D1 is open.", created_at: ago(5) }]);
      expect(await comment("not ready: d1 is open.")).toContain("ok");
    });

    test("exact mode still refuses the identical text", async () => {
      process.env[KEY] = "exact";
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "Same text.", created_at: ago(5) }]);
      expect(await comment("Same text.")).toContain("duplicate comment");
    });

    test("an unknown value falls back to the default", async () => {
      process.env[KEY] = "fuzzy";
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "A  B", created_at: ago(5) }]);
      expect(await comment("a b")).toContain("duplicate comment");
    });
  });

  describe("the duplicate window is configuration", () => {
    const KEY = "ANIMA_REVIEW_DUPLICATE_WINDOW_MS";
    let saved: string | undefined;
    beforeEach(() => { saved = process.env[KEY]; budgets.begin("cleo", { repo: "rfcclub/anima", issue: 299 })(); });
    afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

    test("a shorter window from the environment lets an older identical comment through", async () => {
      process.env[KEY] = "300000"; // 5 minutes
      route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "same", created_at: ago(10) }]);
      expect(await comment("same")).toContain("ok");
    });

    test("a nonsense value falls back to one hour", async () => {
      for (const bad of ["abc", "-5", "10", "999999999999"]) {
        process.env[KEY] = bad;
        route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "same", created_at: ago(30) }]);
        expect(await comment("same")).toContain("duplicate comment");
      }
    });
  });

  test("a child told the issue by its environment enforces one verdict without any begin()", async () => {
    budgets = new ReviewBudgets(() => ({ ANIMA_INTENT_REVIEW: "rfcclub/anima#299" }));
    expect(await comment("first")).toContain("ok");
    expect(await comment("second, different")).toContain("verdict already recorded");
    expect(await comment("elsewhere", 300)).toContain("not allowed during an intent review");
    expect(posted()).toBe(1);
  });

  test("SC-017 a refusal is logged with its reason", async () => {
    await comment("first");
    await comment("second");
    expect(lastAudit()).toMatchObject({ agent: "cleo", action: "issue_comment", repo: "rfcclub/anima", target: "issue#299", ok: false, reason: "verdict-recorded" });
  });

  test("SC-017 every reason is logged", async () => {
    await comment("elsewhere", 300);
    expect(lastAudit().reason).toBe("not-allowed");
    route("GET", /\/issues\/299\/comments/, { message: "nope" }, 500);
    await comment("x");
    expect(lastAudit().reason).toBe("unverifiable");
    route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "dup", created_at: ago(1) }]);
    await comment("dup");
    expect(lastAudit().reason).toBe("duplicate");
  });

  test("SC-018 the audit line never contains the comment body", async () => {
    route("GET", /\/issues\/299\/comments/, [{ id: 7, user: { login: BOT }, body: "secret words", created_at: ago(1) }]);
    await comment("secret words");
    expect(logLines.join("\n")).not.toContain("secret words");
  });

  test("regression: 29 scripted calls end with one verdict and one write", async () => {
    const results: string[] = [];
    for (let i = 0; i < 26; i++) results.push(await comment(`review attempt number ${i}`));
    results.push(await approve());
    results.push(await approve());
    results.push(await approve());
    expect(results.length).toBe(29);
    expect(results[0]).toContain("ok");
    expect(results.slice(1).every((r) => r.startsWith("Error"))).toBe(true);
    expect(posted()).toBe(1);
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(0);
    expect(budgets.active("cleo")).toMatchObject({ verdictsLeft: 0 });
  });
});
