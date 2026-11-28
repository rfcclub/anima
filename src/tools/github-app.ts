import { createPrivateKey, createSign } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolPolicy } from "../config/types";
import registry from "../../data/github-apps.json";
import { canonicalize, isPathInside } from "./policy-enforcer";
import { reviewBudgets, type RefusalReason, type ReviewBudgets } from "./review-budget";

export interface GithubDeps {
  fetch: typeof fetch;
  readKeyPem: (slug: string) => string;
  runGit: (args: string[], opts: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; out: string }>;
  now: () => number;
  appendLog: (line: string) => void;
  /** Intent-review budgets. Defaults to the process-wide instance, which adopts ANIMA_INTENT_REVIEW. */
  budgets?: ReviewBudgets;
  /** How far back an identical comment by the same App counts as a duplicate. Default one hour. */
  duplicateWindowMs?: number;
  /** How comments are compared for the duplicate check. Defaults to the environment, else `normalized`. */
  duplicateMatch?: DuplicateMatch;
}

export interface GithubCtx {
  agentName?: string;
  policy?: ToolPolicy | null;
  cwd?: string;
  deps?: Partial<GithubDeps>;
}

const TOOL = "anima_github";
const API = "https://api.github.com";
const PROTECTED_BRANCHES = new Set(["master", "dev"]);
const MAX_INLINE_COMMENTS = 50;
const MAX_CITED_PATHS = 20;
const THREAD_QUERY = "query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:20){nodes{databaseId author{login} body}}}}}}}";
const MAX_THREAD_PAGES = 10;
const DEFAULT_DUPLICATE_WINDOW_MS = 3_600_000;
const MAX_DUPLICATE_PAGES = 5;
const APPS = registry as Record<string, { appId: number; slug: string }>;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function _resetGithubTokenCache(): void {
  tokenCache.clear();
}

type BranchCheck = { ok: true; branch: string } | { ok: false };

/** Only a plain branch name under refs/heads is accepted: no refspec, force marker, option or protected target. */
export function validateBranch(input: unknown): BranchCheck {
  if (typeof input !== "string") return { ok: false };
  const branch = input.startsWith("refs/heads/") ? input.slice("refs/heads/".length) : input;
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) return { ok: false };
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || branch.includes("//")) return { ok: false };
  if (PROTECTED_BRANCHES.has(branch.toLowerCase()) || branch === "HEAD") return { ok: false };
  return { ok: true, branch };
}

function parseRepo(input: unknown): string | null {
  return typeof input === "string" && /^rfcclub\/[A-Za-z0-9._-]+$/.test(input) ? input : null;
}

interface Link { owner: string; name: string; kind: "pull" | "issues"; n: number }

/** `https://github.com/<owner>/<repo>/(pull|issues)/<n>` only; anything else is not a link. */
export function parseLink(input: unknown): Link | null {
  if (typeof input !== "string") return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/.exec(input.trim());
  if (!m) return null;
  const n = Number(m[4]);
  return n > 0 ? { owner: m[1], name: m[2], kind: m[3] as "pull" | "issues", n } : null;
}

const CITED_EXT = "ts|tsx|js|jsx|mjs|cjs|json|md|py|sh|yml|yaml|toml|css|html|rs|go|java|c|h|cpp|sql|lock|txt";
const CITED_PATH = new RegExp(`(?<![\\w@:/.-])((?:[A-Za-z0-9_.-]+/)*[A-Za-z][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9_-]+)*\\.(?:${CITED_EXT}))(?::\\d+(?:-\\d+)?)?(?![\\w/])`, "g");

/** Product names that look like file names ("Node.js") are prose, not citations. */
const PRODUCT_NAMES = /^(node|next|vue|nuxt|react|express|three|d3|deno|bun|chart)\.js$/i;

/** File paths cited in free text: names with a known source extension, optionally with `:line`; URLs are skipped. */
export function extractCitedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(CITED_PATH)) if (!PRODUCT_NAMES.test(m[1])) found.add(m[1]);
  return [...found];
}

function homeDir(): string {
  return process.env.HOME || homedir();
}

export function defaultDeps(): GithubDeps {
  return {
    fetch: globalThis.fetch,
    readKeyPem: (slug) => {
      const dir = join(homeDir(), ".anima", "secrets");
      const files = readdirSync(dir).filter((f) => f.startsWith(`${slug}.`) && f.endsWith(".private-key.pem")).sort();
      if (files.length === 0) throw new Error("no key file");
      return readFileSync(join(dir, files[files.length - 1]), "utf8");
    },
    runGit: async (args, opts) => {
      const proc = Bun.spawn(["git", ...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out: `${out}${err}` };
    },
    now: () => Date.now(),
    appendLog: (line) => {
      const dir = process.env.ANIMA_HOME ? join(process.env.ANIMA_HOME, "logs") : join(homeDir(), ".anima", "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "github-tool.jsonl"), `${line}\n`);
    },
  };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signAppJwt(appId: number, pem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const payload = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }))}`;
  const signature = createSign("RSA-SHA256").update(payload).sign(createPrivateKey(pem));
  return `${payload}.${b64url(signature)}`;
}

type AuditReason = RefusalReason | "duplicate" | "unverifiable" | "not-in-profile";

/** A refusal or API error. `message` is safe to show to the agent; `reason` is written to the audit line. */
class ToolError extends Error {
  constructor(message: string, readonly reason?: AuditReason) {
    super(message);
  }
}

/** Lowercase, runs of whitespace collapsed to one space, trimmed: what "the same comment" means. */
export function normalizeBody(body: string, mode: DuplicateMatch = "normalized"): string {
  const bare = body.replace(REVISION_MARKER_ANY, "");
  return mode === "exact" ? bare.trim() : bare.toLowerCase().replace(/\s+/g, " ").trim();
}

const DUPLICATE_MATCH_ENV = "ANIMA_REVIEW_DUPLICATE_MATCH";
/** How two comments are compared: `normalized` (case and whitespace ignored, the default) or `exact` (trimmed only). */
export type DuplicateMatch = "normalized" | "exact";
function duplicateMatch(override: DuplicateMatch | undefined): DuplicateMatch {
  if (override) return override;
  return process.env[DUPLICATE_MATCH_ENV] === "exact" ? "exact" : "normalized";
}

/** Hidden marker the tool appends to an intent-review comment: which revision of the issue it was written for. */
const REVISION_MARKER_ANY = /<!--\s*anima-review-(?:rev|approval):[0-9a-f]+(?:\s+by:\S+)?\s*-->/g;
const revisionMarker = (revision: string): string => `<!-- anima-review-rev:${revision} -->`;
/** Written on the box we tick: which revision, and which reviewer ticked it. One verdict per reviewer, not per issue. */
const approvalMarker = (revision: string, login: string): string => `<!-- anima-review-approval:${revision} by:${login} -->`;

/** The author of the approval box (the Orca workflow); a comment by anyone else is not the box. */
const WORKFLOW_LOGIN = "github-actions[bot]";

const DUPLICATE_WINDOW_ENV = "ANIMA_REVIEW_DUPLICATE_WINDOW_MS";
/** The duplicate window: the dependency override, else the environment (1 minute to 24 hours), else one hour. */
function duplicateWindow(override: number | undefined): number {
  if (override !== undefined) return override;
  const raw = process.env[DUPLICATE_WINDOW_ENV];
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return value >= 60_000 && value <= 86_400_000 ? value : DEFAULT_DUPLICATE_WINDOW_MS;
}

/** The refusal names the actions the profile does allow, so the model can correct itself instead of retrying. */
function profileRefusal(allowed: readonly string[]): string {
  return `Error: this session may only use anima_github with ${allowed.map((a) => `action=${a}`).join(" or ")}; every other action is refused.`;
}

const BUDGET_MESSAGES: Record<RefusalReason, (issue: number) => string> = {
  "verdict-recorded": () => "Error: verdict already recorded for this intent review. Do not call anima_github again; end your turn.",
  "attempt-limit": () => "Error: attempt limit reached for this intent review. Do not call anima_github again; end your turn.",
  "not-allowed": (issue) => `Error: not allowed during an intent review (only approve_intent or issue_comment on issue #${issue}).`,
};

const basicAuth = (token: string): string => Buffer.from(`x-access-token:${token}`).toString("base64");

export async function handleGithubTool(args: Record<string, unknown>, ctx: GithubCtx): Promise<string> {
  const deps: GithubDeps = { ...defaultDeps(), ...ctx.deps };
  const action = String(args.action ?? "");
  const link = args.url === undefined ? null : parseLink(args.url);
  const repo = parseRepo(link ? `${link.owner}/${link.name}` : (args.repo ?? "rfcclub/anima"));
  const secrets: string[] = [];
  let target = "";
  let status = 0;

  const redact = (text: string): string => {
    let out = text;
    for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
    return out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]");
  };

  const finish = (ok: boolean, text: string, reason?: AuditReason): string => {
    const result = redact(text);
    try {
      deps.appendLog(JSON.stringify({ ts: new Date(deps.now()).toISOString(), agent: ctx.agentName, action, repo, target, ok, status, ...(reason ? { reason } : {}) }));
    } catch {
      // a failing log must not break the call, but the audit relies on it; the executor also logs the call
    }
    return result;
  };

  const budgets = deps.budgets ?? reviewBudgets;
  const agentName = ctx.agentName as string;
  // An admitted call holds the verdict until its write succeeds; every failure path gives it back.
  let holdsVerdict = false;

  try {
    const app = ctx.agentName ? APPS[ctx.agentName] : undefined;
    if (!app) throw new ToolError("Error: unknown agent identity");
    if (!ctx.policy?.allowedTools?.includes(TOOL)) throw new ToolError(`Error: ${TOOL} not in allowedTools for this agent`);
    // The session profile's allowlist, enforced here rather than in the prompt: a review model runs on
    // untrusted text, so anything the profile does not name fails closed before a token is minted.
    const profileActions = ctx.policy?.githubActions;
    if (profileActions && !profileActions.includes(action)) {
      if (Number(args.issue) > 0) target = `issue#${Number(args.issue)}`;
      else if (Number(args.pr) > 0) target = `pr#${Number(args.pr)}`;
      throw new ToolError(profileRefusal(profileActions), "not-in-profile");
    }
    if (!repo) throw new ToolError("Error: repo not allowed (rfcclub/<name> only)");
    if (args.force || args.force_with_lease) throw new ToolError("Error: force not allowed");
    if (args.url !== undefined) {
      if (!link) throw new ToolError("Error: url must be https://github.com/rfcclub/<repo>/pull/<n> or /issues/<n>");
      const needs = ["review", "review_threads", "review_reply", "review_resolve"].includes(action) ? "pull" : action === "approve_intent" ? "issues" : null;
      if (needs && link.kind !== needs) throw new ToolError(`Error: ${action} needs a ${needs === "pull" ? "/pull/" : "/issues/"} link`);
      if (args.repo !== undefined && parseRepo(args.repo) !== repo) throw new ToolError("Error: url and repo disagree");
      const given = link.kind === "pull" ? args.pr : args.issue;
      if (given !== undefined && Number(given) !== link.n) throw new ToolError(`Error: url and ${link.kind === "pull" ? "pr" : "issue"} disagree`);
      args = { ...args, [link.kind === "pull" ? "pr" : "issue"]: link.n };
    }
    const ownLogin = `${app.slug}[bot]`;

    // Intent-review budget: only active while the consumer runs a review-intent turn for this agent.
    budgets.adoptFromEnv(agentName);
    const budget = budgets.active(agentName);
    if (budget) {
      const issueArg = Number(args.issue);
      const verdict = budgets.admit(agentName, { action, repo, issue: issueArg });
      if (!verdict.ok) {
        if (Number.isInteger(issueArg) && issueArg > 0) target = `issue#${issueArg}`;
        throw new ToolError(BUDGET_MESSAGES[verdict.reason](budget.issue), verdict.reason);
      }
      holdsVerdict = true;
    }

    const gh = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const res = await deps.fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "anima-github-tool", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      const text = await res.text();
      let json: any = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
      return { status: res.status, json };
    };
    const must = (r: { status: number; json: any }, what: string): any => {
      if (r.status >= 300) throw new ToolError(`Error: ${what} failed (${r.status}): ${String(r.json?.message ?? "").slice(0, 200)}`);
      return r.json;
    };

    const gql = async (token: string, query: string, variables: Record<string, unknown>): Promise<any> => {
      const r = await gh("POST", "/graphql", token, { query, variables });
      if (r.status >= 300 || r.json?.errors) throw new ToolError(`Error: graphql failed (${r.status}): ${String(r.json?.errors?.[0]?.message ?? r.json?.message ?? "").slice(0, 200)}`);
      return r.json.data;
    };
    const prNumber = (input: unknown): number => {
      const n = Number(input);
      if (!Number.isInteger(n) || n <= 0) throw new ToolError("Error: pr must be a positive integer");
      return n;
    };

    /** All review threads of a PR, paged; `truncated` is true only if the page limit was hit. */
    const fetchThreads = async (token: string, n: number): Promise<{ nodes: any[]; truncated: boolean }> => {
      const [owner, name] = repo.split("/");
      const nodes: any[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        const data = await gql(token, THREAD_QUERY, { owner, name, pr: n, after });
        const threads = data?.repository?.pullRequest?.reviewThreads;
        if (!threads) throw new ToolError(`Error: pull request ${n} not found in ${repo}`);
        nodes.push(...(threads.nodes ?? []));
        if (!threads.pageInfo?.hasNextPage) return { nodes, truncated: false };
        after = threads.pageInfo.endCursor;
      }
      return { nodes, truncated: true };
    };

    const getToken = async (): Promise<string> => {
      const key = `${ctx.agentName}:${repo}`;
      const cached = tokenCache.get(key);
      if (cached && cached.expiresAt - 60_000 > deps.now()) {
        secrets.push(cached.token);
        return cached.token;
      }
      const jwt = signAppJwt(app.appId, deps.readKeyPem(app.slug), deps.now());
      secrets.push(jwt);
      const inst = must(await gh("GET", `/repos/${repo}/installation`, jwt), "installation lookup");
      const tok = must(await gh("POST", `/app/installations/${inst.id}/access_tokens`, jwt, {}), "token exchange");
      secrets.push(tok.token);
      tokenCache.set(key, { token: tok.token, expiresAt: Date.parse(tok.expires_at) });
      return tok.token;
    };

    /**
     * Whether this App already left a verdict comment for the revision of the intent under review. A new review
     * turn (a job retried after a successful write) is a new process with a fresh budget, so the earlier verdict
     * is found on GitHub, where it was written, not in memory. Unreadable comments are refused (fail closed).
     */
    const priorVerdictForRevision = async (token: string, n: number, revision: string): Promise<boolean> => {
      let approved = false;
      for (let page = 1; ; page++) {
        const read = await gh("GET", `/repos/${repo}/issues/${n}/comments?per_page=100&page=${page}`, token);
        if (read.status !== 200 || !Array.isArray(read.json)) throw new ToolError(`Error: could not verify earlier comments (GitHub answered ${read.status}); nothing written`, "unverifiable");
        const earlier = read.json as Array<{ user?: { login?: string }; body?: string }>;
        if (earlier.some((c) => c.user?.login === ownLogin && String(c.body ?? "").includes(revisionMarker(revision)))) return true;
        // Our own approval is the ticked box that carries this revision's approval marker with our login (written in
        // the same edit that ticks it), so another reviewer's approval is not our verdict. A box ticked for an older revision, or by a person, carries none, so it is not our verdict here.
        // Only the workflow's own box counts: anyone can post a lookalike comment with a public marker.
        if (earlier.some((c) => c.user?.login === WORKFLOW_LOGIN && String(c.body ?? "").includes("<!-- orca-approve -->")
          && /- \[x\] Approve/i.test(String(c.body ?? "")) && String(c.body ?? "").includes(approvalMarker(revision, ownLogin)))) approved = true;
        if (earlier.length < 100) return approved;
        if (page >= MAX_DUPLICATE_PAGES) throw new ToolError("Error: could not verify earlier comments (too many comments); nothing written", "unverifiable");
      }
    };
    const REVISION_RECORDED = (n: number): string => `Error: verdict already recorded for this revision of issue #${n} by an earlier review turn (a verdict comment or an approval). Do not call anima_github again; end your turn.`;

    switch (action) {
      case "issue_create": {
        target = String(args.title ?? "");
        const token = await getToken();
        const body: Record<string, unknown> = { title: args.title, body: args.body };
        if (Array.isArray(args.labels)) body.labels = args.labels;
        const out = must(await gh("POST", `/repos/${repo}/issues`, token, body), "issue_create");
        return finish(true, JSON.stringify({ status: "ok", number: out.number, url: out.html_url }));
      }
      case "issue_comment": {
        const n = Number(args.issue);
        if (!Number.isInteger(n) || n <= 0) throw new ToolError("Error: issue must be a positive integer");
        if (typeof args.body !== "string" || !args.body.trim()) throw new ToolError("Error: body must be a non-empty string");
        target = `issue#${n}`;
        const token = await getToken();
        // The same App must not post the same text twice in a window. Fail closed when GitHub cannot say.
        const windowMs = duplicateWindow(deps.duplicateWindowMs);
        // Inside a review of a known revision, only a comment written for that same revision is a duplicate.
        const revision = budget?.revision;
        if (revision && await priorVerdictForRevision(token, n, revision)) throw new ToolError(REVISION_RECORDED(n), "verdict-recorded");
        const cutoff = deps.now() - windowMs;
        const match = duplicateMatch(deps.duplicateMatch);
        const wanted = normalizeBody(args.body, match);
        const since = encodeURIComponent(new Date(cutoff).toISOString());
        for (let page = 1; ; page++) {
          const read = await gh("GET", `/repos/${repo}/issues/${n}/comments?since=${since}&per_page=100&page=${page}`, token);
          if (read.status !== 200 || !Array.isArray(read.json)) throw new ToolError(`Error: could not verify earlier comments (GitHub answered ${read.status}); comment not posted`, "unverifiable");
          const earlier = read.json as Array<{ user?: { login?: string }; body?: string; created_at?: string }>;
          if (earlier.some((c) => c.user?.login === ownLogin && Date.parse(String(c.created_at)) >= cutoff
            && normalizeBody(String(c.body ?? ""), match) === wanted
            && (!revision || String(c.body ?? "").includes(revisionMarker(revision))))) {
            throw new ToolError(`Error: duplicate comment: this App already posted the same text on issue #${n} within the last ${Math.round(windowMs / 60_000)} minutes. Do not post it again.`, "duplicate");
          }
          if (earlier.length < 100) break;
          if (page >= MAX_DUPLICATE_PAGES) throw new ToolError("Error: could not verify earlier comments (too many recent comments); comment not posted", "unverifiable");
        }
        const out = must(await gh("POST", `/repos/${repo}/issues/${n}/comments`, token, { body: revision ? `${args.body}\n\n${revisionMarker(revision)}` : args.body }), "issue_comment");
        if (holdsVerdict) { budgets.commit(agentName); holdsVerdict = false; }
        return finish(true, JSON.stringify({ status: "ok", url: out.html_url }));
      }
      case "pr_create": {
        const head = validateBranch(args.head);
        if (!head.ok) throw new ToolError("Error: branch not allowed");
        target = head.branch;
        const token = await getToken();
        const body: Record<string, unknown> = { title: args.title, body: args.body, head: head.branch, base: String(args.base ?? "master") };
        if (args.draft === true) body.draft = true;
        const out = must(await gh("POST", `/repos/${repo}/pulls`, token, body), "pr_create");
        return finish(true, JSON.stringify({ status: "ok", number: out.number, url: out.html_url }));
      }
      case "push": {
        const branch = validateBranch(args.branch);
        if (!branch.ok) throw new ToolError("Error: branch not allowed");
        target = branch.branch;
        const dir = canonicalize(String(args.dir ?? ctx.cwd ?? ""));
        const roots = (ctx.policy?.allowedRoots ?? []).map((r) => canonicalize(r));
        if (!dir || !roots.some((r) => isPathInside(r, dir))) throw new ToolError("Error: dir not allowed (outside allowedRoots)");
        const token = await getToken();
        const run = await deps.runGit(["push", `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch.branch}`], {
          cwd: dir,
          env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicAuth(token)}`, GIT_TERMINAL_PROMPT: "0" },
        });
        secrets.push(basicAuth(token));
        if (run.code !== 0) throw new ToolError(`Error: push failed (${run.code}): ${run.out.slice(0, 400)}`);
        return finish(true, JSON.stringify({ status: "ok", branch: branch.branch }));
      }
      case "review": {
        const event = String(args.event ?? "");
        if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) throw new ToolError("Error: event must be APPROVE, REQUEST_CHANGES or COMMENT");
        const reviewPr = prNumber(args.pr);
        target = `pr#${reviewPr}`;
        let inline: Array<{ path: string; line: number; body: string; side: string }> | undefined;
        if (args.comments !== undefined) {
          if (!Array.isArray(args.comments)) throw new ToolError("Error: comments must be an array of { path, line, body }");
          if (args.comments.length > MAX_INLINE_COMMENTS) throw new ToolError(`Error: at most ${MAX_INLINE_COMMENTS} inline comments per review`);
          inline = args.comments.map((c: any) => {
            if (typeof c?.path !== "string" || !c.path || !Number.isInteger(c?.line) || c.line <= 0 || typeof c?.body !== "string" || !c.body.trim()) {
              throw new ToolError("Error: each comment needs a path, a positive integer line and a non-empty body");
            }
            return { path: c.path, line: c.line, body: c.body, side: "RIGHT" };
          });
        }
        const token = await getToken();
        const pr = must(await gh("GET", `/repos/${repo}/pulls/${reviewPr}`, token), "pr lookup");
        if (pr.user?.login === ownLogin) throw new ToolError("Error: four-eyes: cannot review a PR authored by the same App");
        const cited = [...new Set([...extractCitedPaths(String(args.body ?? "")), ...(inline ?? []).map((c) => c.path)])];
        if (cited.length > MAX_CITED_PATHS) throw new ToolError(`Error: the review cites ${cited.length} files, at most ${MAX_CITED_PATHS} can be checked`);
        if (cited.length > 0) {
          const headSha = pr.head?.sha;
          if (typeof headSha !== "string" || !headSha) throw new ToolError("Error: could not verify the cited files (no PR head)");
          let prFiles: string[] | null = null;
          const exists = async (path: string): Promise<boolean> => {
            const r = await gh("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${headSha}`, token);
            if (r.status === 200) return true;
            if (r.status === 404) return false;
            throw new ToolError(`Error: could not verify the cited files (GitHub answered ${r.status})`);
          };
          const missing: string[] = [];
          for (const path of cited) {
            let ok = await exists(path);
            if (!ok && /^[ab]\//.test(path)) ok = await exists(path.slice(2));
            if (!ok && !path.includes("/")) {
              if (prFiles === null) {
                prFiles = [];
                for (let page = 1; page <= 10; page++) {
                  const files = await gh("GET", `/repos/${repo}/pulls/${reviewPr}/files?per_page=100&page=${page}`, token);
                  if (files.status !== 200) throw new ToolError(`Error: could not verify the cited files (GitHub answered ${files.status})`);
                  const list: Array<{ filename: string }> = Array.isArray(files.json) ? files.json : [];
                  prFiles.push(...list.map((f) => f.filename));
                  if (list.length < 100) break;
                }
              }
              ok = prFiles.some((f) => f === path || f.endsWith(`/${path}`));
            }
            if (!ok) missing.push(path);
          }
          if (missing.length > 0) throw new ToolError(`Error: not found at the PR head: ${missing.join(", ")}. Cite only files that exist in the PR or the repository, then submit the review again.`);
        }
        must(await gh("POST", `/repos/${repo}/pulls/${reviewPr}/reviews`, token, { event, body: args.body, ...(inline ? { comments: inline } : {}) }), "review");
        return finish(true, JSON.stringify({ status: "ok", event }));
      }
      case "review_threads": {
        const n = prNumber(args.pr);
        target = `pr#${n}`;
        const token = await getToken();
        const { nodes, truncated } = await fetchThreads(token, n);
        const open = nodes.filter((th) => !th.isResolved).map((th) => ({
          thread: th.id,
          path: th.path,
          line: th.line,
          comments: (th.comments?.nodes ?? []).map((c: any) => ({ id: c.databaseId, author: c.author?.login, body: String(c.body ?? "").slice(0, 500) })),
        }));
        return finish(true, JSON.stringify({ status: "ok", threads: open, truncated }));
      }
      case "review_reply": {
        const n = prNumber(args.pr);
        const commentId = Number(args.comment);
        if (!Number.isInteger(commentId) || commentId <= 0) throw new ToolError("Error: comment must be a positive integer");
        if (typeof args.body !== "string" || !args.body.trim()) throw new ToolError("Error: body must be a non-empty string");
        target = `pr#${n}`;
        const token = await getToken();
        const parent = must(await gh("GET", `/repos/${repo}/pulls/comments/${commentId}`, token), "comment lookup");
        if (!String(parent.pull_request_url ?? "").endsWith(`/pulls/${n}`)) throw new ToolError(`Error: comment is not a review comment of pull request ${n}`);
        const out = must(await gh("POST", `/repos/${repo}/pulls/${n}/comments/${commentId}/replies`, token, { body: args.body }), "review_reply");
        return finish(true, JSON.stringify({ status: "ok", url: out.html_url }));
      }
      case "review_resolve": {
        const n = prNumber(args.pr);
        if (typeof args.thread !== "string" || !args.thread) throw new ToolError("Error: thread must be a thread id");
        target = `pr#${n}`;
        const token = await getToken();
        const pr = must(await gh("GET", `/repos/${repo}/pulls/${n}`, token), "pr lookup");
        if (pr.user?.login !== ownLogin) throw new ToolError(`Error: four-eyes: only ${String(pr.user?.login ?? "the PR author")} may resolve a thread on this PR`);
        const { nodes, truncated } = await fetchThreads(token, n);
        if (!nodes.some((th) => th.id === args.thread)) {
          throw new ToolError(truncated ? `Error: thread not found in the first ${MAX_THREAD_PAGES * 100} threads of pull request ${n}; refusing to resolve` : `Error: thread is not a review thread of pull request ${n}`);
        }
        const data = await gql(token, "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}", { thread: args.thread });
        if (data?.resolveReviewThread?.thread?.isResolved !== true) throw new ToolError("Error: thread was not resolved");
        return finish(true, JSON.stringify({ status: "ok", thread: args.thread }));
      }
      case "approve_intent": {
        const n = Number(args.issue);
        target = `issue#${n}`;
        const token = await getToken();
        const issue = must(await gh("GET", `/repos/${repo}/issues/${n}`, token), "issue lookup");
        if (issue.user?.login === ownLogin) throw new ToolError("Error: four-eyes: cannot approve an intent authored by the same App");
        if (budget?.revision && await priorVerdictForRevision(token, n, budget.revision)) throw new ToolError(REVISION_RECORDED(n), "verdict-recorded");
        const comments = must(await gh("GET", `/repos/${repo}/issues/${n}/comments?per_page=100`, token), "comments lookup") as Array<{ id: number; body: string }>;
        const box = comments.find((c) => c.body.includes("<!-- orca-approve -->") && c.body.includes("- [ ] Approve"));
        if (!box) throw new ToolError("Error: no unticked Approve box found on this issue");
        must(await gh("PATCH", `/repos/${repo}/issues/comments/${box.id}`, token, { body: `${box.body.replace("- [ ] Approve", "- [x] Approve")}${budget?.revision ? `\n\n${approvalMarker(budget.revision, ownLogin)}` : ""}` }), "approve");
        if (holdsVerdict) { budgets.commit(agentName); holdsVerdict = false; }
        return finish(true, JSON.stringify({ status: "ok", issue: n }));
      }
      default:
        throw new ToolError("Error: unknown action (issue_create, issue_comment, pr_create, push, review, review_threads, review_reply, review_resolve, approve_intent)");
    }
  } catch (err) {
    if (holdsVerdict) {
      if (err instanceof ToolError && err.reason === "duplicate") budgets.refund(agentName);
      else budgets.release(agentName);
    }
    if (err instanceof ToolError) return finish(false, err.message, err.reason);
    return finish(false, `Error: ${TOOL} failed (${(err as Error).name})`);
  }
}
