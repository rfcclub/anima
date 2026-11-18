import { classifyReviewPath } from "./eligibility";

/** Trusted tool-layer port: authenticate, pin GitHub, refuse redirects and bound bytes before parsing. */
export type ReviewGitHubGet = (path: string, signal: AbortSignal) => Promise<unknown>;
export interface ReviewBranchSnapshot {
  repo: string;
  number: number;
  state: "OPEN";
  draft: false;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  authorLogin: string;
  paths: { complete: true; items: Array<{ path: string; previousPath?: string }> };
  commits: { complete: true; items: Array<{ sha: string; authorLogin: string; committerLogin: string; message: string }> };
}
type Collection = "subject" | "metadata" | "base" | "files" | "commits";
type Reason = "malformed" | "rest_limit" | "count_mismatch" | "duplicate" | "head_missing"
  | "base_metadata_stale" | "snapshot_changed" | "read_failed" | "aborted" | "request_limit";
export type ReviewBranchResult = { ok: true; snapshot: ReviewBranchSnapshot }
  | { ok: false; collection: Collection; reason: Reason };
type Fields = Record<string, unknown>;
const object = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 65_536;
const sha = (v: unknown): v is string => text(v) && /^[a-f0-9]{40}$/.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const login = (v: unknown): v is string => text(v) && /^[a-z0-9][a-z0-9-]*(?:\[bot\])?$/i.test(v);
function branch(v: unknown): v is string {
  return text(v) && v.length <= 255 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(v)
    && !v.includes("..") && !v.includes("@{") && v !== "@"
    && v.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}
class Refusal extends Error { constructor(readonly reason: Reason) { super(reason); } }
function requireFact(ok: unknown, reason: Reason = "malformed"): asserts ok { if (!ok) throw new Refusal(reason); }
function metadata(v: unknown, repo: string, number: number) {
  requireFact(object(v) && v.number === number && v.state === "open" && v.draft === false
    && object(v.head) && sha(v.head.sha) && object(v.base) && sha(v.base.sha) && branch(v.base.ref)
    && object(v.base.repo) && v.base.repo.full_name === repo && object(v.user) && login(v.user.login)
    && integer(v.changed_files) && integer(v.commits));
  return { headSha: v.head.sha, baseSha: v.base.sha, baseBranch: v.base.ref,
    authorLogin: v.user.login, fileCount: v.changed_files, commitCount: v.commits };
}
function liveBase(v: unknown, name: string): string {
  requireFact(object(v) && v.ref === `refs/heads/${name}` && object(v.object)
    && v.object.type === "commit" && sha(v.object.sha));
  return v.object.sha;
}
function file(v: unknown): { path: string; previousPath?: string } {
  requireFact(object(v) && text(v.filename) && text(v.status)
    && ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(v.status));
  requireFact(classifyReviewPath(v.filename) !== "invalid");
  requireFact(v.status !== "renamed" || text(v.previous_filename));
  if (v.previous_filename !== undefined) {
    requireFact(text(v.previous_filename) && classifyReviewPath(v.previous_filename) !== "invalid");
    return { path: v.filename, previousPath: v.previous_filename };
  }
  return { path: v.filename };
}
function commit(v: unknown) {
  requireFact(object(v) && sha(v.sha) && object(v.author) && login(v.author.login)
    && object(v.committer) && login(v.committer.login) && object(v.commit) && text(v.commit.message));
  return { sha: v.sha, authorLogin: v.author.login, committerLogin: v.committer.login, message: v.commit.message };
}

/** Partial observations only. No review/CI/intent/loop proof, credential access or merge action. */
export async function collectReviewBranch(
  get: ReviewGitHubGet, repo: string, number: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReviewBranchResult> {
  let collection: Collection = "subject";
  if (!object(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    return { ok: false, collection, reason: "malformed" };
  }
  const timeout = options.timeoutMs ?? 30_000;
  if (typeof get !== "function" || typeof repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || !integer(number) || !integer(timeout) || timeout > 30_000) return { ok: false, collection, reason: "malformed" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  let requests = 0;
  async function read(path: string): Promise<unknown> {
    requireFact(!signal.aborted, "aborted");
    requireFact(++requests <= 40, "request_limit");
    let interrupted: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      interrupted = () => reject(new Refusal("aborted"));
      signal.addEventListener("abort", interrupted, { once: true });
    });
    try {
      const value = await Promise.race([get(path, signal), cancelled]);
      requireFact(!signal.aborted, "aborted");
      return value;
    } finally { if (interrupted) signal.removeEventListener("abort", interrupted); }
  }
  const root = `/repos/${repo}`, pr = `${root}/pulls/${number}`;
  async function pages<T>(kind: "files" | "commits", count: number, parse: (v: unknown) => T, key: (v: T) => string): Promise<T[]> {
    collection = kind;
    const all: T[] = [], seen = new Set<string>();
    const maxPages = kind === "files" ? 30 : 3;
    for (let page = 1; page <= maxPages; page++) {
      const values = await read(`${pr}/${kind}?per_page=100&page=${page}`);
      requireFact(Array.isArray(values) && values.length <= 100);
      for (const value of values) {
        const item = parse(value), identity = key(item);
        requireFact(!seen.has(identity), "duplicate"); seen.add(identity); all.push(item);
      }
      requireFact(all.length <= count, "count_mismatch");
      if (values.length < 100) { requireFact(all.length === count, "count_mismatch"); return all; }
    }
    throw new Refusal("rest_limit");
  }
  try {
    collection = "metadata";
    const first = metadata(await read(pr), repo, number);
    if (first.fileCount >= 3000) { collection = "files"; throw new Refusal("rest_limit"); }
    if (first.commitCount >= 250) { collection = "commits"; throw new Refusal("rest_limit"); }
    collection = "base";
    const refPath = `${root}/git/ref/heads/${encodeURIComponent(first.baseBranch)}`;
    const base = liveBase(await read(refPath), first.baseBranch);
    requireFact(first.baseSha === base, "base_metadata_stale");
    const files = await pages("files", first.fileCount, file, item => item.path);
    const commits = await pages("commits", first.commitCount, commit, item => item.sha);
    requireFact(commits.some(item => item.sha === first.headSha), "head_missing");
    collection = "metadata";
    const last = metadata(await read(pr), repo, number);
    requireFact(Object.keys(first).every(k => first[k as keyof typeof first] === last[k as keyof typeof last]), "snapshot_changed");
    collection = "base";
    requireFact(liveBase(await read(refPath), first.baseBranch) === base, "snapshot_changed");
    return { ok: true, snapshot: { repo, number, state: "OPEN", draft: false,
      headSha: first.headSha, baseSha: base, baseBranch: first.baseBranch, authorLogin: first.authorLogin,
      paths: { complete: true, items: files }, commits: { complete: true, items: commits } } };
  } catch (error) {
    return { ok: false, collection, reason: signal.aborted ? "aborted" : error instanceof Refusal ? error.reason : "read_failed" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
