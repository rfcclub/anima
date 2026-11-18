/** Trusted, byte-bounded read-only GraphQL port. No default HTTP client or credential issuer. */
export type ReviewDiscussionQuery = (document: string, variables: Record<string, string | number | null>,
  signal: AbortSignal) => Promise<unknown>;
type Fields = Record<string, unknown>;
interface Binding { headSha: string; baseSha: string; baseBranch: string }
interface Limits { requests: number; points: number; items: number; textChars: number; timeoutMs: number }
interface Options extends Partial<Limits> { signal?: AbortSignal }
interface Review { id: number; appLogin: string; state: string; headSha: string; body: string; submittedAt: number }
interface Comment { id: number; authorLogin: string; body: string; createdAt: number; updatedAt: number }
interface Thread { id: string; resolved: boolean; outdated: boolean; comments: { complete: true; items: Comment[] } }
interface Snapshot extends Binding {
  repo: string; number: number;
  reviews: { complete: true; items: Review[] };
  threads: { complete: true; items: Thread[] };
  comments: { complete: true; items: Comment[] };
  rate: { observedCost: number; remaining: number; resetAt: string };
}
export type ReviewDiscussionResult = { ok: true; snapshot: Snapshot }
  | { ok: false; collection: string; reason: string };
const ANCHOR = `nameWithOwner ref(qualifiedName:$baseRef){name target{__typename ... on Commit{oid}}}
  pullRequest(number:$number){number state isDraft headRefOid baseRefOid baseRefName`;
const RATE = "rateLimit{cost remaining limit resetAt}";
const ACTOR = "author{__typename login}";
const COMMENT = `id fullDatabaseId ${ACTOR} body createdAt updatedAt`;
const ASSOC = "pullRequest{number repository{nameWithOwner}}";
const THREAD = `id isResolved isOutdated ${ASSOC}`;
const PAGE = "totalCount pageInfo{hasNextPage endCursor}";
function query(name: string, selection: string, node = ""): string {
  const paging = name === "Anchor" ? "" : ",$after:String";
  const id = name === "ThreadComments" ? ",$threadId:ID!" : "";
  return `query ReviewDiscussion${name}($owner:String!,$name:String!,$number:Int!,$baseRef:String!${paging}${id}){
    repository(owner:$owner,name:$name){${ANCHOR} ${selection}}} ${node} ${RATE}}`;
}
/** Documents contain only fixed query selections; returned text/cursors are never interpolated. */
export const DISCUSSION_QUERIES = Object.freeze({
  reviews: query("Reviews", `reviews(first:100,after:$after){${PAGE} nodes{id fullDatabaseId ${ACTOR}
    body state submittedAt commit{oid}}}`),
  threads: query("Threads", `reviewThreads(first:100,after:$after){${PAGE}
    nodes{${THREAD} comments(first:1){totalCount}}}`),
  comments: query("Comments", `comments(first:100,after:$after){${PAGE} nodes{${COMMENT}}}`),
  threadComments: query("ThreadComments", "", `node(id:$threadId){... on PullRequestReviewThread{
    ${THREAD} comments(first:50,after:$after){${PAGE} nodes{${COMMENT}}}}}`),
  anchor: query("Anchor", ""),
});
const CEILINGS: Limits = { requests: 200, points: 200, items: 10_000, textChars: 4 * 1024 * 1024, timeoutMs: 30_000 };
const object = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const nat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => nat(v) && v > 0;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9+/_=:-]{1,4096}$/.test(v);
function branch(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 255 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(v)
    && !v.includes("..") && !v.includes("@{") && v !== "@"
    && v.split("/").every(p => !!p && !p.startsWith(".") && !p.endsWith(".") && !p.endsWith(".lock"));
}
class Refusal extends Error { constructor(readonly reason: string) { super(reason); } }
function fact(v: unknown, reason = "malformed"): asserts v { if (!v) throw new Refusal(reason); }

/** Complete discussion observations, still missing CI/issue/loop/base-at-review facts and never actionable. */
export async function collectReviewDiscussion(repo: string, number: number, binding: Binding,
  read: ReviewDiscussionQuery, options: Options = {}): Promise<ReviewDiscussionResult> {
  let collection = "subject";
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let caller: AbortSignal | undefined, abort: (() => void) | undefined;
  try {
    fact(typeof repo === "string" && /^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo) && positive(number)
      && object(binding) && sha(binding.headSha) && sha(binding.baseSha) && branch(binding.baseBranch)
      && typeof read === "function" && object(options));
    const expected = { headSha: binding.headSha, baseSha: binding.baseSha, baseBranch: binding.baseBranch };
    const limits = { ...CEILINGS };
    for (const key of Object.keys(options)) {
      if (key === "signal") continue;
      const value = options[key as keyof Limits];
      fact(Object.hasOwn(CEILINGS, key) && positive(value) && value <= CEILINGS[key as keyof Limits]);
      limits[key as keyof Limits] = value;
    }
    fact(options.signal === undefined || options.signal instanceof AbortSignal);
    caller = options.signal;
    fact(!caller?.aborted, "aborted");
    controller = new AbortController();
    let timeout = false;
    abort = () => controller!.abort();
    caller?.addEventListener("abort", abort, { once: true });
    const started = performance.now();
    timer = setTimeout(() => { timeout = true; controller!.abort(); }, limits.timeoutMs);
    let requests = 0, observedCost = 0, retained = 0, items = 0;
    let remaining = 0, resetAt = "";
    const variables = { owner: "rfcclub", name: repo.slice(8), number, baseRef: `refs/heads/${expected.baseBranch}` };
    function deadline(): void {
      if (performance.now() - started >= limits.timeoutMs) { timeout = true; controller!.abort(); }
      fact(!controller!.signal.aborted, timeout ? "timeout" : "aborted");
    }
    function text(v: unknown, max = 65_536): string {
      fact(typeof v === "string" && v.length <= max);
      retained += v.length; fact(retained <= limits.textChars, "text_limit");
      return v;
    }
    function id(v: unknown): number {
      fact((typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v)) || positive(v));
      const n = Number(v); fact(positive(n)); return n;
    }
    function date(v: unknown): number {
      fact(typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v));
      const n = Date.parse(v); fact(nat(n));
      fact(new Date(n).toISOString() === (v.includes(".") ? v : v.replace("Z", ".000Z")));
      return n;
    }
    function actor(v: unknown): string {
      fact(object(v) && (v.__typename === "Bot" || v.__typename === "User") && typeof v.login === "string"
        && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(v.login));
      return text(v.login + (v.__typename === "Bot" ? "[bot]" : ""), 105);
    }
    function association(v: unknown): void {
      fact(object(v) && v.number === number && object(v.repository) && v.repository.nameWithOwner === repo, "snapshot_changed");
    }
    function anchor(v: unknown): Fields {
      fact(object(v) && v.nameWithOwner === repo && object(v.ref) && v.ref.name === expected.baseBranch
        && object(v.ref.target) && v.ref.target.__typename === "Commit" && v.ref.target.oid === expected.baseSha
        && object(v.pullRequest), "snapshot_changed");
      const p = v.pullRequest;
      fact(p.number === number && p.state === "OPEN" && p.isDraft === false && p.headRefOid === expected.headSha
        && p.baseRefOid === expected.baseSha && p.baseRefName === expected.baseBranch, "snapshot_changed");
      return p;
    }
    async function call(kind: keyof typeof DISCUSSION_QUERIES, extra: Record<string, string | null> = {}): Promise<Fields> {
      deadline(); fact(++requests <= limits.requests, "request_limit");
      fact(observedCost < limits.points, "point_limit");
      let stop: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        stop = () => reject(new Refusal(timeout ? "timeout" : "aborted"));
        controller!.signal.addEventListener("abort", stop, { once: true });
      });
      let result: unknown;
      try {
        result = await Promise.race([read(DISCUSSION_QUERIES[kind], { ...variables, ...extra }, controller!.signal), interrupted]);
      } catch { throw new Refusal(controller!.signal.aborted ? (timeout ? "timeout" : "aborted") : "read_failed"); }
      finally { if (stop) controller!.signal.removeEventListener("abort", stop); }
      deadline();
      fact(object(result));
      if (result.errors !== undefined) fact(Array.isArray(result.errors) && result.errors.length === 0, "graphql_errors");
      fact(object(result.data));
      const data = result.data, rate = data.rateLimit;
      fact(object(rate) && nat(rate.cost) && positive(rate.limit) && nat(rate.remaining) && rate.remaining <= rate.limit
        && rate.cost <= rate.limit && typeof rate.resetAt === "string");
      date(rate.resetAt);
      observedCost += rate.cost; remaining = rate.remaining; resetAt = rate.resetAt;
      fact(observedCost <= limits.points, "point_limit");
      fact(remaining > 0, "rate_limited");
      anchor(data.repository);
      return data;
    }
    async function walk<T extends { id: number | string }>(name: string, first: number,
      fetchPage: (after: string | null) => Promise<unknown>, normalize: (v: unknown) => T, expected?: number): Promise<T[]> {
      collection = name;
      const output: T[] = [], ids = new Set<number | string>(), nodeIds = new Set<string>(), cursors = new Set<string>();
      let after: string | null = null, total: number | undefined;
      for (let page = 0; page < 20; page++) {
        const c = await fetchPage(after);
        fact(object(c) && nat(c.totalCount) && c.totalCount <= 1000 && Array.isArray(c.nodes)
          && c.nodes.length <= first && object(c.pageInfo) && typeof c.pageInfo.hasNextPage === "boolean");
        total ??= c.totalCount;
        fact(c.totalCount === total && (expected === undefined || total === expected), "count_mismatch");
        for (const raw of c.nodes) {
          fact(object(raw) && opaque(raw.id));
          fact(!nodeIds.has(raw.id), "duplicate"); nodeIds.add(raw.id);
          const normalized = normalize(raw);
          fact(!ids.has(normalized.id), "duplicate"); ids.add(normalized.id);
          fact(++items <= limits.items, "item_limit"); output.push(normalized);
        }
        fact(output.length <= total, "count_mismatch");
        if (!c.pageInfo.hasNextPage) { fact(output.length === total, "count_mismatch"); deadline(); return output; }
        fact(c.nodes.length > 0 && opaque(c.pageInfo.endCursor), "cursor");
        fact(!cursors.has(c.pageInfo.endCursor), "cursor");
        cursors.add(c.pageInfo.endCursor); after = c.pageInfo.endCursor;
      }
      throw new Refusal("page_limit");
    }
    const reviews = await walk("reviews", 100, async after => {
      const d = await call("reviews", { after }); return (d.repository as Fields).pullRequest &&
        ((d.repository as Fields).pullRequest as Fields).reviews;
    }, raw => {
      fact(object(raw) && object(raw.commit) && sha(raw.commit.oid) && typeof raw.state === "string"
        && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(raw.state));
      return { id: id(raw.fullDatabaseId), appLogin: actor(raw.author), state: raw.state,
        headSha: raw.commit.oid, body: text(raw.body), submittedAt: date(raw.submittedAt) };
    });
    const metadata = await walk("threads", 100, async after => {
      const d = await call("threads", { after }); return ((d.repository as Fields).pullRequest as Fields).reviewThreads;
    }, raw => {
      fact(object(raw) && opaque(raw.id) && typeof raw.isResolved === "boolean" && typeof raw.isOutdated === "boolean"
        && object(raw.comments) && nat(raw.comments.totalCount) && raw.comments.totalCount <= 1000);
      association(raw.pullRequest);
      return { id: text(raw.id, 4096), resolved: raw.isResolved, outdated: raw.isOutdated, count: raw.comments.totalCount };
    });
    const commentIds = new Set<number>();
    function comment(raw: unknown): Comment {
      fact(object(raw)); const key = id(raw.fullDatabaseId);
      fact(!commentIds.has(key), "duplicate"); commentIds.add(key);
      return { id: key, authorLogin: actor(raw.author), body: text(raw.body),
        createdAt: date(raw.createdAt), updatedAt: date(raw.updatedAt) };
    }
    const threads: Thread[] = [];
    for (const t of metadata) {
      const comments = await walk("threadComments", 50, async after => {
        const d = await call("threadComments", { after, threadId: t.id }), n = d.node;
        fact(object(n) && n.id === t.id && n.isResolved === t.resolved && n.isOutdated === t.outdated, "snapshot_changed");
        association(n.pullRequest); return n.comments;
      }, comment, t.count);
      threads.push({ id: t.id, resolved: t.resolved, outdated: t.outdated, comments: { complete: true, items: comments } });
    }
    // IssueComment and PullRequestReviewComment IDs live in different database tables.
    const discussionIds = new Set<number>();
    const comments = await walk("comments", 100, async after => {
      const d = await call("comments", { after }); return ((d.repository as Fields).pullRequest as Fields).comments;
    }, raw => {
      fact(object(raw)); const key = id(raw.fullDatabaseId);
      fact(!discussionIds.has(key), "duplicate"); discussionIds.add(key);
      return { id: key, authorLogin: actor(raw.author), body: text(raw.body),
        createdAt: date(raw.createdAt), updatedAt: date(raw.updatedAt) };
    });
    collection = "anchor"; await call("anchor"); deadline();
    return { ok: true, snapshot: { repo, number, ...expected, reviews: { complete: true, items: reviews },
      threads: { complete: true, items: threads }, comments: { complete: true, items: comments },
      rate: { observedCost, remaining, resetAt } } };
  } catch (error) {
    return { ok: false, collection, reason: error instanceof Refusal ? error.reason : "malformed" };
  } finally {
    if (timer) clearTimeout(timer);
    if (caller && abort) caller.removeEventListener("abort", abort);
    controller?.abort();
  }
}
