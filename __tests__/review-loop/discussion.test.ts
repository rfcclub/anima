import { describe, test, expect } from "bun:test";
import { collectReviewDiscussion, DISCUSSION_QUERIES } from "../../src/review-loop/discussion";
import { auditReviewEligibility } from "../../src/review-loop/eligibility";

const H = "a".repeat(40), B = "b".repeat(40);
const binding = { headSha: H, baseSha: B, baseBranch: "feature/base" };
const bot = { __typename: "Bot", login: "reviewer" };
const user = { __typename: "User", login: "rfcclub" };
const rate = () => ({ cost: 1, remaining: 4999, limit: 5000, resetAt: "2100-01-01T00:00:00Z" });
const review = (id = 1) => ({ id: `R${id}`, fullDatabaseId: String(6_000_000_000 + id), author: bot,
  state: "APPROVED", body: "Reviewer: bruno", submittedAt: "2026-10-29T12:00:00Z", commit: { oid: H } });
const comment = (id = 1) => ({ id: `C${id}`, fullDatabaseId: String(7_000_000_000 + id),
  author: user, body: "APPROVE\nReviewer: bruno", createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-10-29T12:00:00Z" });
const association = () => ({ number: 45, repository: { nameWithOwner: "rfcclub/anima" } });
const thread = (id = 1) => ({ id: `T${id}`, isResolved: false, isOutdated: true,
  pullRequest: association(), comments: { totalCount: 1 } });
const page = (nodes: any[], totalCount = nodes.length, more = false, endCursor: string | null = nodes.length ? "cursor1" : null) =>
  ({ nodes, totalCount, pageInfo: { hasNextPage: more, endCursor } });
function anchor() { return { nameWithOwner: "rfcclub/anima", ref: { name: binding.baseBranch, target: { __typename: "Commit", oid: B } },
  pullRequest: { number: 45, state: "OPEN", isDraft: false, headRefOid: H, baseRefOid: B, baseRefName: binding.baseBranch } }; }
type Call = { kind: string; variables: any; signal: AbortSignal };
function fixture(edit?: (data: any, call: Call, index: number) => void) {
  const calls: Call[] = [];
  const read = async (document: string, variables: any, signal: AbortSignal) => {
    const kind = Object.entries(DISCUSSION_QUERIES).find(([, value]) => value === document)?.[0];
    expect(kind).toBeDefined();
    expect(document).not.toMatch(/\b(mutation|subscription)\b/);
    expect(variables.owner).toBe("rfcclub"); expect(variables.name).toBe("anima"); expect(variables.number).toBe(45);
    expect(variables.baseRef).toBe("refs/heads/feature/base");
    const call = { kind: kind!, variables, signal }; calls.push(call);
    const repository: any = anchor();
    if (kind === "reviews") repository.pullRequest.reviews = page([review()]);
    if (kind === "threads") repository.pullRequest.reviewThreads = page([thread()]);
    if (kind === "comments") repository.pullRequest.comments = page([comment()]);
    const data: any = { data: { repository, rateLimit: rate() } };
    if (kind === "threadComments") data.data.node = { ...thread(), comments: page([comment(2)]) };
    edit?.(data, call, calls.length);
    return data;
  };
  return { calls, read };
}
async function run(f = fixture(), options?: any, subject: any = binding) {
  return collectReviewDiscussion("rfcclub/anima", 45, subject, f.read, options);
}
async function refused(f: ReturnType<typeof fixture>, reason: string, collection?: string, options?: any) {
  const result = await run(f, options);
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("refusal required");
  expect(result.reason).toBe(reason);
  if (collection) expect(result.collection).toBe(collection);
  expect(JSON.stringify(result)).not.toContain("secret");
  return result;
}
describe("review discussion collection (DC-1..8)", () => {
  test("DC-4 DC-5 real review identity is normalized; APPROVE comments stay discussion; outdated unresolved remains unresolved", async () => {
    const f = fixture(), r = await run(f);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.snapshot.reviews.items).toEqual([{ id: 6_000_000_001, appLogin: "reviewer[bot]", state: "APPROVED",
      headSha: H, body: "Reviewer: bruno", submittedAt: Date.parse("2026-10-29T12:00:00Z") }]);
    expect(r.snapshot.comments.items[0].authorLogin).toBe("rfcclub");
    expect(r.snapshot.threads.items[0]).toMatchObject({ resolved: false, outdated: true });
    expect(r.snapshot.threads.items[0].comments.items[0].id).toBe(7_000_000_002);
    expect(f.calls.map(c => c.kind)).toEqual(["reviews", "threads", "threadComments", "comments", "anchor"]);
    expect(f.calls.every(c => c.signal.aborted)).toBe(true);
    expect(r.snapshot.rate.observedCost).toBe(5);
  });
  test("DC-5 ordinary comments never create missing reviews", async () => {
    const r = await run(fixture((d, c) => { if (c.kind === "reviews") d.data.repository.pullRequest.reviews = page([]); }));
    expect(r.ok).toBe(true); if (r.ok) expect(r.snapshot.reviews.items).toEqual([]);
  });
  test("DC-7 partial discussion facts cannot authorize eligibility", async () => {
    const r = await run(); expect(r.ok).toBe(true); if (!r.ok) return;
    const a = auditReviewEligibility(r.snapshot, { apps: { bruno: "reviewer[bot]", eli: "author[bot]" },
      bindings: [], now: Date.now(), cooldownMs: 0 });
    expect(a.automaticMerge).toBe(false); expect(a.reasons).toContain("malformed_snapshot");
  });
  test("DC-7 regression: binding extras cannot manufacture a complete eligibility snapshot", async () => {
    const r = await run(fixture(), undefined, { ...binding, state: "OPEN", draft: false,
      observedHeadSha: H, observedBaseSha: B, ownerAgents: ["eli"], authorLogin: "author[bot]",
      paths: { complete: true, items: [{ path: "src/safe.ts" }] },
      commits: { complete: true, items: [{ sha: H, authorLogin: "author[bot]", committerLogin: "author[bot]", message: "Agent: eli" }] },
      ci: { complete: true, configured: false, headSha: H, results: [] },
      issue: { number: 45, type: "enhancement", approved: true }, loop: { complete: true, rounds: 1, lastAttemptAt: 0 } });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const a = auditReviewEligibility(r.snapshot, { apps: { bruno: "reviewer[bot]", eli: "author[bot]" },
      bindings: [{ reviewId: 6_000_000_001, headSha: H, baseSha: B, appLogin: "reviewer[bot]" }], now: 1000, cooldownMs: 0 });
    expect(a.reasons).toContain("malformed_snapshot");
    expect(Object.keys(r.snapshot).sort()).toEqual(["repo", "number", "headSha", "baseSha", "baseBranch", "reviews", "threads", "comments", "rate"].sort());
  });
  test("DC-1 regression: changing the caller binding during a read cannot rebind the observed head", async () => {
    const subject = { ...binding }, changed = "c".repeat(40);
    const f = fixture(d => { subject.headSha = changed; d.data.repository.pullRequest.headRefOid = changed; });
    const r = await run(f, undefined, subject);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("snapshot_changed");
  });
  test("DC-2 page2 for each connection including nested comments, independent cursors and exact count", async () => {
    const f = fixture((d, c) => {
      const next = c.variables.after === "cursor1";
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews = next
        ? page([review(2)], 2, false, "cursor2") : page([review()], 2, true);
      if (c.kind === "threads") d.data.repository.pullRequest.reviewThreads = next
        ? page([thread(2)], 2, false, "cursor2") : page([thread()], 2, true);
      if (c.kind === "threadComments") {
        const id = c.variables.threadId === "T1" ? 10 : 20;
        d.data.node = { ...thread(c.variables.threadId === "T1" ? 1 : 2), comments: next
          ? page([comment(id + 1)], 2, false, "cursor2") : page([comment(id)], 2, true) };
      }
      if (c.kind === "threads") for (const t of d.data.repository.pullRequest.reviewThreads.nodes) t.comments.totalCount = 2;
      if (c.kind === "comments") d.data.repository.pullRequest.comments = next
        ? page([comment(31)], 2, false, "cursor2") : page([comment(30)], 2, true);
    });
    const r = await run(f); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.snapshot.reviews.items).toHaveLength(2); expect(r.snapshot.threads.items).toHaveLength(2);
    expect(r.snapshot.threads.items.every(t => t.comments.items.length === 2)).toBe(true);
    expect(r.snapshot.comments.items).toHaveLength(2); expect(f.calls).toHaveLength(11);
  });
  for (const kind of ["reviews", "threads", "comments", "threadComments"]) {
    function connection(d: any) { return kind === "threadComments" ? d.data.node.comments
      : d.data.repository.pullRequest[kind === "threads" ? "reviewThreads" : kind]; }
    test.each(["count", "duplicate", "empty-next", "repeated-cursor", "missing-cursor", "overlong", "nodes-null"] as const)(
      `DC-2 ${kind} refuses %s pagination`, async shape => {
        const f = fixture((d, c) => {
          if (kind === "threadComments" && c.kind === "threads" && ["repeated-cursor", "missing-cursor"].includes(shape)) {
            d.data.repository.pullRequest.reviewThreads.nodes[0].comments.totalCount = 2;
          }
          if (c.kind !== kind) return;
          const x = connection(d);
          if (shape === "count") x.totalCount = 2;
          if (shape === "duplicate") { x.nodes.push(x.nodes[0]); x.totalCount = 2; }
          if (shape === "empty-next") { x.nodes = []; x.totalCount = 1; x.pageInfo.hasNextPage = true; }
          if (shape === "repeated-cursor") {
            x.totalCount = 2; x.pageInfo.hasNextPage = true;
            if (c.variables.after) {
              x.nodes[0].id += "next";
              if (x.nodes[0].fullDatabaseId) x.nodes[0].fullDatabaseId = String(Number(x.nodes[0].fullDatabaseId) + 1);
            }
          }
          if (shape === "missing-cursor") { x.totalCount = 2; x.pageInfo = { hasNextPage: true, endCursor: null }; }
          if (shape === "overlong") { x.nodes = Array.from({ length: kind === "threadComments" ? 51 : 101 }, () => x.nodes[0]); x.totalCount = x.nodes.length; }
          if (shape === "nodes-null") x.nodes = null;
        });
        const r = await run(f); expect(r.ok).toBe(false);
        if (!r.ok && ["empty-next", "repeated-cursor", "missing-cursor"].includes(shape)) expect(r.reason).toBe("cursor");
      });
  }
  test.each(["errors", "partial-errors", "missing-data", "null-data"] as const)("DC-3 GraphQL %s refuses without text", async shape => {
    const f = fixture(d => {
      if (shape.includes("errors")) d.errors = [{ message: "secret fixture token" }];
      if (shape === "errors" || shape === "null-data") d.data = null;
      if (shape === "missing-data") delete d.data;
    });
    await refused(f, shape.includes("errors") ? "graphql_errors" : "malformed");
    expect(f.calls).toHaveLength(1);
  });
  test.each(["name", "number", "head", "base", "ref", "live", "live-type", "draft", "closed"] as const)(
    "DC-1 wrong %s anchor refuses before accepting records", async shape => {
      await refused(fixture(d => {
        const x = d.data.repository, p = x.pullRequest;
        if (shape === "name") x.nameWithOwner = "evil/anima";
        if (shape === "number") p.number = 46;
        if (shape === "head") p.headRefOid = "c".repeat(40);
        if (shape === "base") p.baseRefOid = "c".repeat(40);
        if (shape === "ref") p.baseRefName = "master";
        if (shape === "live") x.ref.target.oid = "c".repeat(40);
        if (shape === "live-type") x.ref.target.__typename = "Tag";
        if (shape === "draft") p.isDraft = true;
        if (shape === "closed") p.state = "CLOSED";
      }), "snapshot_changed");
    });
  test("DC-1 final live base movement refuses", async () => {
    await refused(fixture((d, c) => { if (c.kind === "anchor") d.data.repository.ref.target.oid = H; }), "snapshot_changed", "anchor");
  });
  test.each(["author", "commit", "submittedAt", "fullDatabaseId", "state", "body"] as const)(
    "DC-3 malformed review %s refuses rather than filtering", async field => {
      await refused(fixture((d, c) => { if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0][field] = null; }), "malformed", "reviews");
    });
  test("DC-3 pending review with null submission refuses", async () => {
    await refused(fixture((d, c) => { if (c.kind === "reviews") Object.assign(d.data.repository.pullRequest.reviews.nodes[0],
      { state: "PENDING", submittedAt: null }); }), "malformed", "reviews");
  });
  test.each(["reviews", "comments", "threadComments"])("DC-3 regression: %s impossible calendar date refuses", async kind => {
    await refused(fixture((d, c) => {
      if (c.kind !== kind) return;
      const x = kind === "threadComments" ? d.data.node.comments.nodes[0] : d.data.repository.pullRequest[kind].nodes[0];
      x[kind === "reviews" ? "submittedAt" : "updatedAt"] = "2026-02-30T12:00:00Z";
    }), "malformed", kind);
  });
  test.each(["reviews", "comments", "threadComments"])("DC-4 %s decimal ID precision and actor type cannot launder identity", async kind => {
    for (const value of ["9007199254740992", "01", "-1", "1e3", 1.5]) {
      const f = fixture((d, c) => {
        if (c.kind !== kind) return;
        const x = kind === "threadComments" ? d.data.node.comments.nodes[0] : d.data.repository.pullRequest[kind].nodes[0];
        x.fullDatabaseId = value;
      });
      await refused(f, "malformed", kind);
    }
    for (const author of [{ __typename: "User", login: "reviewer[bot]" }, { __typename: "Organization", login: "reviewer" },
      { __typename: "Bot", login: "reviewer[bot]" }, null]) {
      await refused(fixture((d, c) => {
        if (c.kind !== kind) return;
        const x = kind === "threadComments" ? d.data.node.comments.nodes[0] : d.data.repository.pullRequest[kind].nodes[0];
        x.author = author;
      }), "malformed", kind);
    }
  });
  test("DC-4 User with App slug is retained as a user, never suffixed", async () => {
    const r = await run(fixture((d, c) => { if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].author =
      { __typename: "User", login: "reviewer" }; }));
    expect(r.ok).toBe(true); if (r.ok) expect(r.snapshot.reviews.items[0].appLogin).toBe("reviewer");
  });
  test("DC-4 exact positive numeric database IDs remain supported in all three tables", async () => {
    const r = await run(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].fullDatabaseId = 42;
      if (c.kind === "comments") d.data.repository.pullRequest.comments.nodes[0].fullDatabaseId = 43;
      if (c.kind === "threadComments") d.data.node.comments.nodes[0].fullDatabaseId = 44;
    }));
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.snapshot.reviews.items[0].id).toBe(42); expect(r.snapshot.comments.items[0].id).toBe(43);
    expect(r.snapshot.threads.items[0].comments.items[0].id).toBe(44);
  });
  test("DC-6 invalid rate reset timestamp text refuses", async () => {
    await refused(fixture(d => { d.data.rateLimit.resetAt = "not-a-date"; }), "malformed", "reviews");
  });
  test("DC-6 regression: impossible calendar rate reset timestamp refuses", async () => {
    await refused(fixture(d => { d.data.rateLimit.resetAt = "2026-02-30T00:00:00Z"; }), "malformed", "reviews");
  });
  test.each(["reviews", "threadComments"])("DC-2 %s unique records still cannot exceed the per-page first bound", async kind => {
    await refused(fixture((d, c) => {
      if (c.kind === "threads" && kind === "threadComments") d.data.repository.pullRequest.reviewThreads.nodes[0].comments.totalCount = 51;
      if (c.kind !== kind) return;
      if (kind === "reviews") d.data.repository.pullRequest.reviews = page(Array.from({ length: 101 }, (_, i) => review(i + 1)));
      else d.data.node.comments = page(Array.from({ length: 51 }, (_, i) => comment(i + 1)));
    }), "malformed", kind);
  });
  test("DC-2 same node ID with distinct database IDs refuses", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews = page([review(), { ...review(2), id: review().id }]);
    }), "duplicate", "reviews");
  });
  test("DC-2 empty intermediate page refuses even with a fresh cursor and a valid next page", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews = c.variables.after
        ? page([review()]) : page([], 1, true, "freshCursor");
    }), "cursor", "reviews");
  });
  test("DC-2 cursor characters cannot carry whitespace", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews = c.variables.after
        ? page([review(2)], 2) : page([review()], 2, true, "bad cursor");
    }), "cursor", "reviews");
  });
  test("DC-2 node ID characters cannot carry whitespace", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].id = "bad node";
    }), "malformed", "reviews");
  });
  test("DC-3 unknown review state refuses", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].state = "INVENTED";
    }), "malformed", "reviews");
  });
  test("DC-3 malformed review commit SHA refuses", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].commit.oid = "z".repeat(40);
    }), "malformed", "reviews");
  });
  test("DC-2 nested outdated flag drift refuses", async () => {
    await refused(fixture((d, c) => { if (c.kind === "threadComments") d.data.node.isOutdated = false; }),
      "snapshot_changed", "threadComments");
  });
  test.each(["evil/anima", "rfcclub/anima/extra"])("DC-1 foreign or malformed repository %s refuses before reading", async repo => {
    let calls = 0;
    const r = await collectReviewDiscussion(repo, 45, binding, async () => { calls++; return null; });
    expect(r).toEqual({ ok: false, collection: "subject", reason: "malformed" }); expect(calls).toBe(0);
  });
  test.each(["feature/a..b", "feature/base.lock", ".feature/base"])("DC-1 invalid branch component %s refuses before reading", async baseBranch => {
    let calls = 0;
    const r = await collectReviewDiscussion("rfcclub/anima", 45, { ...binding, baseBranch }, async () => { calls++; return null; });
    expect(r).toEqual({ ok: false, collection: "subject", reason: "malformed" }); expect(calls).toBe(0);
  });
  test.each(["id", "association", "resolved", "count"] as const)("DC-2 nested thread %s mismatch refuses", async shape => {
    await refused(fixture((d, c) => {
      if (c.kind !== "threadComments") return;
      if (shape === "id") d.data.node.id = "Other";
      if (shape === "association") d.data.node.pullRequest.number = 46;
      if (shape === "resolved") d.data.node.isResolved = true;
      if (shape === "count") d.data.node.comments.totalCount = 2;
    }), shape === "count" ? "count_mismatch" : "snapshot_changed", "threadComments");
  });
  test.each(["cost", "remaining", "limit", "resetAt"] as const)("DC-6 malformed rate %s refuses", async field => {
    await refused(fixture(d => { d.data.rateLimit[field] = null; }), "malformed");
  });
  test("DC-6 observed point budget stops after the over-budget response, not an advance reservation", async () => {
    const f = fixture(d => { d.data.rateLimit.cost = 2; }); await refused(f, "point_limit", "threads", { points: 3 });
    expect(f.calls).toHaveLength(2);
  });
  test("DC-6 request cap stops before next call", async () => {
    const f = fixture(); await refused(f, "request_limit", "threads", { requests: 1 }); expect(f.calls).toHaveLength(1);
  });
  test("DC-6 exact request, observed point and aggregate item boundaries succeed", async () => {
    const r = await run(fixture(), { requests: 5, points: 5, items: 4 });
    expect(r.ok).toBe(true);
    await refused(fixture(), "item_limit", "comments", { items: 3 });
  });
  test("DC-2 equal database IDs across different comment tables are not duplicates", async () => {
    const r = await run(fixture((d, c) => { if (c.kind === "comments") d.data.repository.pullRequest.comments.nodes[0] = comment(2); }));
    expect(r.ok).toBe(true);
  });
  test("DC-2 same review-comment database ID in two threads refuses", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "threads") d.data.repository.pullRequest.reviewThreads = page([thread(1), thread(2)]);
      if (c.kind === "threadComments") d.data.node = { ...thread(c.variables.threadId === "T1" ? 1 : 2), comments: page([comment(2)]) };
    }), "duplicate", "threadComments");
  });
  test("DC-6 exhausted remaining budget refuses", async () => {
    await refused(fixture(d => { d.data.rateLimit.remaining = 0; }), "rate_limited");
  });
  test("DC-6 aggregate text limit refuses without retaining partial facts", async () => {
    await refused(fixture(), "text_limit", undefined, { textChars: 1 });
  });
  test("DC-6 zero reported query cost is valid; observed exact point ceiling permits the final response", async () => {
    const r = await run(fixture((d, c) => { d.data.rateLimit.cost = c.kind === "anchor" ? 5 : 0; }), { points: 5 });
    expect(r.ok).toBe(true); if (r.ok) expect(r.snapshot.rate.observedCost).toBe(5);
  });
  test("DC-6 reaching the point ceiling before the final anchor prevents another query", async () => {
    const f = fixture(); await refused(f, "point_limit", "anchor", { points: 4 });
    expect(f.calls).toHaveLength(4);
  });
  test("DC-2 changing a page count is refused even when final length matches the new count", async () => {
    await refused(fixture((d, c) => {
      if (c.kind !== "reviews") return;
      d.data.repository.pullRequest.reviews = c.variables.after
        ? page([review(2), review(3)], 3) : page([review()], 2, true);
    }), "count_mismatch", "reviews");
  });
  test("DC-2 page count drift refuses even when accumulated length matches the first count", async () => {
    await refused(fixture((d, c) => {
      if (c.kind !== "reviews") return;
      d.data.repository.pullRequest.reviews = c.variables.after
        ? page([review(2)], 3) : page([review()], 2, true);
    }), "count_mismatch", "reviews");
  });
  test("DC-2 nested complete comments must match the independently collected thread count", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "threadComments") d.data.node.comments = page([comment(2), comment(3)], 2);
    }), "count_mismatch", "threadComments");
  });
  test("DC-2 unique nodes sharing one database ID are duplicates", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews = page([review(), { ...review(), id: "anotherNode" }]);
    }), "duplicate", "reviews");
  });
  test("DC-2 a connection over 1000 records is refused before normalization", async () => {
    await refused(fixture((d, c) => { if (c.kind === "reviews") d.data.repository.pullRequest.reviews.totalCount = 1001; }),
      "malformed", "reviews");
  });
  test("DC-2 continuing beyond 20 pages refuses with unique cursors and IDs", async () => {
    const f = fixture((d, c, n) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews = page([review(n)], 21, true, `cursor${n}`);
    });
    await refused(f, "page_limit", "reviews"); expect(f.calls).toHaveLength(20);
  });
  test("DC-6 a synchronous query overrun cannot beat the timeout timer", async () => {
    const f = fixture(() => { const start = performance.now(); while (performance.now() - start < 20) {} });
    await refused(f, "timeout", "reviews", { timeoutMs: 5 }); expect(f.calls).toHaveLength(1);
  });
  test("DC-3 per-record body ceiling is independent of the aggregate text budget", async () => {
    await refused(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].body = "x".repeat(65_537);
    }), "malformed", "reviews");
    const r = await run(fixture((d, c) => {
      if (c.kind === "reviews") d.data.repository.pullRequest.reviews.nodes[0].body = "x".repeat(65_536);
    }));
    expect(r.ok).toBe(true);
  });
  test("DC-6 hung query is raced and abort requested", async () => {
    let signal: AbortSignal | undefined;
    const never = async (_q: string, _v: any, s: AbortSignal) => { signal = s; return new Promise<never>(() => {}); };
    const r = await Promise.race([collectReviewDiscussion("rfcclub/anima", 45, binding, never, { timeoutMs: 20 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error("bounded assertion failed")), 1000))]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("timeout"); expect(signal?.aborted).toBe(true);
  });
  test("DC-6 caller abort and pre-abort issue no later query", async () => {
    const controller = new AbortController(), f = fixture((_d, _c, n) => { if (n === 1) controller.abort(); });
    const r = await run(f, { signal: controller.signal }); expect(r.ok).toBe(false); expect(f.calls).toHaveLength(1);
    const g = fixture(); const p = await run(g, { signal: controller.signal }); expect(p.ok).toBe(false); expect(g.calls).toHaveLength(0);
  });
  test("DC-6 thrown port text is content-free", async () => {
    const r = await collectReviewDiscussion("rfcclub/anima", 45, binding, async () => { throw Error("secret token"); });
    expect(r).toEqual({ ok: false, collection: "reviews", reason: "read_failed" });
  });
  test.each([null, {}, { headSha: H, baseSha: B, baseBranch: "../master" }, { ...binding, headSha: H.toUpperCase() }])(
    "DC-1 malformed binding %j refuses before reads", async value => {
      const f = fixture(); const r = await run(f, undefined, value); expect(r.ok).toBe(false); expect(f.calls).toHaveLength(0);
    });
  test.each([{ timeoutMs: 30001 }, { requests: 201 }, { points: 201 }, { textChars: 4194305 },
    { unknown: 1 }, { signal: {} }, null])("DC-6 malformed options %j refuses before reads", async options => {
      const f = fixture(); const r = await run(f, options); expect(r.ok).toBe(false); expect(f.calls).toHaveLength(0);
    });
});
