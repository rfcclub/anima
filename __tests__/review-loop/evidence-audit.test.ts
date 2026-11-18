import { expect, test } from "bun:test";
import { collectAndAuditReviewEvidence } from "../../src/review-loop/evidence-audit";
import { captureReviewAuditContext } from "../../src/review-loop/eligibility";
import { fixture, config, H, B, X, PR, ROOT, AUTHOR, SECRET } from "./evidence-audit-fixture";

const context = () => ({ apps: { eli: AUTHOR, bruno: "reviewer[bot]" },
  bindings: [{ reviewId: 6000000001, headSha: H, baseSha: B, appLogin: "reviewer[bot]" }],
  now: Date.parse("2026-10-30T12:00:00Z"), cooldownMs: 1000 });
const run = (f = fixture(), c: unknown = context(), options = {}, input: unknown = config()) =>
  collectAndAuditReviewEvidence(input, f.deps, c, options);
async function audit(f = fixture(), c: unknown = context()) {
  const r = await run(f, c); expect(r.ok).toBe(true);
  if (!r.ok) throw Error(JSON.stringify(r));
  expect(r.candidate).toBeNull(); expect(r.automaticMerge).toBe(false);
  expect(r).not.toHaveProperty("ready"); expect(r).not.toHaveProperty("ownerAgents");
  expect(r.unproven).toEqual(["issuer", "custody", "owner", "issue", "loop", "atomic_merge"]);
  return r;
}
test("EA-2 native coherent facts reach the audit rather than malformed_snapshot", async () => {
  const f = fixture(), r = await audit(f);
  expect(r.binding).toEqual({ ...config(), headSha: H, baseSha: B, baseBranch: "feature/base" });
  expect(r.audit.reasons).toEqual(["atomic_base_guard_unproven", "foreign_commit", "intent_unverified",
    "loop_state_unproven", "owner_unverified", "unresolved_thread"]);
  expect(r.requests).toBe(29); expect(f.calls).toHaveLength(29);
  expect(f.credentials).toBe(29); expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(f.calls.every(c => c.path === "/graphql" ? c.init.method === "POST" : c.init.method === "GET")).toBe(true);
});
for (const reason of ["owner_unverified", "intent_unverified", "loop_state_unproven", "atomic_base_guard_unproven"])
  test(`EA-5 ${reason} is independently retained with genuine review receipt`, async () => {
    expect((await audit()).audit.reasons).toContain(reason);
  });

for (const [index, value] of [null, [], {}, { ...context(), apps: {} }, { ...context(), apps: { eli: AUTHOR, bruno: AUTHOR } },
  { ...context(), now: NaN }, { ...context(), cooldownMs: -1 }, { ...context(), bindings: null },
  { ...context(), bindings: Array(10001).fill(context().bindings[0]) },
  { ...context(), bindings: Array(1) },
  { ...context(), apps: { "wrong agent": AUTHOR } },
  { ...context(), bindings: [{ ...context().bindings[0], headSha: X + "a" }] }].entries())
  test(`EA-3 invalid audit context case ${index} refuses before fetch and credential`, async () => {
  const f = fixture(), r = await run(f, value);
  expect(r).toEqual({ ok: false, stage: "config", reason: "audit_context_invalid", requests: 0, elapsedMs: 0 });
  expect(f.calls).toEqual([]); expect(f.credentials).toBe(0); expect(r).not.toHaveProperty("audit");
});
for (const key of ["apps", "bindings", "now", "cooldownMs"]) {
  test(`EA-3 throwing context ${key} getter is content-free and zero I/O`, async () => {
    const c = context(); Object.defineProperty(c, key, { get() { throw Error(SECRET); } });
    const f = fixture(), r = await run(f, c);
    expect(r).toMatchObject({ ok: false, reason: "audit_context_invalid", requests: 0 });
    expect(JSON.stringify(r)).not.toContain(SECRET); expect(f.credentials).toBe(0);
  });
}
test("EA-3 nested getters throw before I/O", async () => {
  for (const c of [ { ...context(), apps: { get eli() { throw Error(SECRET); } } },
    { ...context(), bindings: [{ get reviewId() { throw Error(SECRET); } }] } ]) {
    const f = fixture(); expect(await run(f, c)).toMatchObject({ ok: false, reason: "audit_context_invalid" });
    expect(f.credentials).toBe(0);
  }
});
test("EA-3 context capture reads each scalar once and returns a detached copy", () => {
  const original = context(), reads: Record<string, number> = {};
  const once = (o: object, label: string) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, { enumerable: true, get() { const key = label + k; reads[key] = (reads[key] ?? 0) + 1;
      if (reads[key] !== 1) throw Error("read twice"); return v; } }]));
  const apps = Object.defineProperties({}, once(original.apps, "apps."));
  const binding = Object.defineProperties({}, once(original.bindings[0]!, "binding."));
  const c = Object.defineProperties({}, once({ ...original, apps, bindings: [binding] }, "root."));
  const captured = captureReviewAuditContext(c);
  expect(captured).toEqual(original); expect(Object.values(reads).every(n => n === 1)).toBe(true);
  expect(captured).not.toBe(c); expect(captured!.bindings[0]).not.toBe(binding);
});
test("EA-3 over-limit context containers refuse before reading item getters", async () => {
  let reads = 0;
  const hugeBindings = Array(10001); Object.defineProperty(hugeBindings, "0", { get() { reads++; return context().bindings[0]; } });
  const apps: Record<string, unknown> = Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`a${i}`, AUTHOR]));
  Object.defineProperty(apps, "a0", { get() { reads++; return AUTHOR; } });
  for (const c of [{ ...context(), bindings: hugeBindings }, { ...context(), apps }]) {
    const f = fixture(); expect(await run(f, c)).toMatchObject({ ok: false, reason: "audit_context_invalid" });
    expect(f.calls).toEqual([]); expect(f.credentials).toBe(0);
  }
  expect(reads).toBe(0);
});
test.each(["reviewId", "headSha", "baseSha", "appLogin"])("EA-3 malformed binding %s refuses before I/O", async field => {
  const c = context(); (c.bindings[0] as any)[field] = field === "reviewId" ? 0 : null;
  const f = fixture(); expect(await run(f, c)).toMatchObject({ ok: false, reason: "audit_context_invalid" });
  expect(f.credentials).toBe(0);
});
test("EA-3 symbol registry keys and case-colliding logins are invalid", async () => {
  for (const apps of [{ ...context().apps, [Symbol("owner")]: AUTHOR }, { eli: AUTHOR, bruno: AUTHOR.toUpperCase() }]) {
    const f = fixture(); expect(await run(f, { ...context(), apps })).toMatchObject({ ok: false, reason: "audit_context_invalid" });
    expect(f.credentials).toBe(0);
  }
});
test("EA-3 caller mutations during credential await cannot replace trusted receipts or registry", async () => {
  const c = context(), f = fixture(), old = f.deps.credential; let changed = false;
  f.deps.credential = async signal => {
    if (!changed) { changed = true; c.bindings[0]!.baseSha = X; c.bindings.length = 0; c.apps.bruno = "other[bot]";
      c.now = 0; c.cooldownMs = Number.MAX_SAFE_INTEGER; }
    return old(signal);
  };
  const r = await audit(f, c);
  expect(r.audit.reasons).not.toContain("review_base_unbound"); expect(r.audit.reasons).not.toContain("reviewer_unverified");
});

for (const path of ["src/secret.ts", "src/Credential.ts", ".github/workflows/test.yml"]) {
  test(`EA-4 collected human path ${path} blocks`, async () => {
    const f = fixture((call, v) => { if (call.path.includes("/files?")) v[0].filename = path; return v; });
    expect((await audit(f)).audit.reasons).toContain("human_path");
  });
}
test("EA-4 rename previous path is not dropped", async () => {
  const f = fixture((call, v) => { if (call.path.includes("/files?")) Object.assign(v[0], {
    filename: "src/safe.ts", previous_filename: "src/Secrets.ts", status: "renamed" }); return v; });
  expect((await audit(f)).audit.reasons).toContain("human_path");
});
test("EA-4 unresolved outdated thread stays blocking and resolved state clears only that reason", async () => {
  const f = fixture((call, v) => {
    if (call.kind === "threads") v.data.repository.pullRequest.reviewThreads.nodes[0].isResolved = true;
    if (call.kind === "threadComments") v.data.node.isResolved = true;
    return v;
  });
  expect((await audit()).audit.reasons).toContain("unresolved_thread");
  expect((await audit(f)).audit.reasons).not.toContain("unresolved_thread");
});
test.each(["failure", "neutral", "skipped", "cancelled"])("EA-4 CI %s is preserved as non-green", async conclusion => {
  const f = fixture((call, v) => { if (call.path.includes("/check-runs?")) v.check_runs[0].conclusion = conclusion; return v; });
  expect((await audit(f)).audit.reasons).toContain("ci_not_green");
});
test.each(["CHANGES_REQUESTED", "COMMENTED", "DISMISSED"])("EA-4 latest real review state %s reaches audit", async state => {
  const f = fixture((call, v) => { if (call.kind === "reviews") v.data.repository.pullRequest.reviews.nodes[0].state = state; return v; });
  expect((await audit(f)).audit.reasons).toContain("latest_review_not_approved");
});
test("EA-4 latest review ordering is preserved", async () => {
  const f = fixture((call, v) => { if (call.kind === "reviews") {
    const list = v.data.repository.pullRequest.reviews.nodes;
    list.push({ ...list[0], id: "R2", fullDatabaseId: "6000000000", state: "CHANGES_REQUESTED", submittedAt: "2026-10-30T12:00:00Z" });
    v.data.repository.pullRequest.reviews.totalCount = 2;
  } return v; });
  const r = await audit(f); expect(r.audit.reasons).toContain("latest_review_not_approved");
  expect(r.audit.reasons).toContain("review_base_unbound");
});
test.each([[], [{ ...context().bindings[0], baseSha: X }], [{ ...context().bindings[0], appLogin: "other[bot]" }]].map(bindings => ({ bindings })))
("EA-4 no forged or missing base binding is manufactured %j", async ({ bindings }) => {
  expect((await audit(fixture(), { ...context(), bindings })).audit.reasons).toContain("review_base_unbound");
});
test("EA-4 old-head approval never becomes current-head approval", async () => {
  const f = fixture((call, v) => { if (call.kind === "reviews") v.data.repository.pullRequest.reviews.nodes[0].commit.oid = X; return v; });
  expect((await audit(f)).audit.reasons).toContain("approval_missing");
});
test("EA-8 receipt-shaped issue comments cannot be promoted into approval", async () => {
  const f = fixture((call, v) => {
    if (call.kind === "reviews") Object.assign(v.data.repository.pullRequest.reviews, { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } });
    if (call.kind === "comments") Object.assign(v.data.repository.pullRequest.comments, { totalCount: 1, nodes: [
      { id: "I1", fullDatabaseId: "8000000001", author: { __typename: "Bot", login: "reviewer" },
        body: JSON.stringify({ ...context().bindings[0], state: "APPROVED", ownerAgents: ["eli"], issue: { approved: true } }),
        createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-10-29T12:00:00Z" } ], pageInfo: { hasNextPage: false, endCursor: "cursor1" } });
    return v;
  });
  expect((await audit(f)).audit.reasons).toContain("approval_missing");
});
for (const stage of ["branch", "discussion", "ci"]) {
  test(`EA-6 ${stage} collection refusal keeps original collection field and has no partial audit`, async () => {
    const f = fixture((call, v) => {
      if (stage === "branch" && call.path.includes("/files?")) return [];
      if (stage === "discussion" && call.kind === "reviews") v.data.repository.pullRequest.reviews.totalCount = 2;
      if (stage === "ci" && call.path.includes("/git/trees/")) v.truncated = true;
      return v;
    });
    const r = await run(f); expect(r).toMatchObject({ ok: false, stage, collection: stage === "branch" ? "files" : stage === "discussion" ? "reviews" : "tree" });
    expect(r).not.toHaveProperty("audit"); expect(r).not.toHaveProperty("binding");
  });
}
test("EA-6 root request bound is preserved without partial audit", async () => {
  const r = await run(fixture(), context(), { requests: 1 });
  expect(r).toMatchObject({ ok: false, stage: "branch", reason: "request_limit", requests: 1 }); expect(r).not.toHaveProperty("audit");
});
test("EA-6 fixed transport facts are preserved without leaked body", async () => {
  const r = await run(fixture(() => new Response(SECRET, { status: 403, headers: { "retry-after": "10" } })));
  expect(r).toMatchObject({ ok: false, stage: "branch", reason: "read_failed", transport: { code: "rate_limited", status: 403, retryAfterSeconds: 10 } });
  expect(r).not.toHaveProperty("audit"); expect(JSON.stringify(r)).not.toContain(SECRET);
});
for (const source of ["discussion", "ci", "final_anchor"]) {
  test(`EA-7 ${source} head drift refuses entire bundle`, async () => {
    const f = fixture((call, v) => {
      if (source === "discussion" && call.kind === "reviews") v.data.repository.pullRequest.headRefOid = X;
      if (source === "ci" && call.path === PR && call.occurrence === 4) v.head.sha = X;
      if (source === "final_anchor" && call.path === PR && call.occurrence === 6) v.head.sha = X;
      return v;
    });
    const r = await run(f); expect(r.ok).toBe(false); expect(r).not.toHaveProperty("audit");
  });
}
test("EA-8 caller Candidate fields are ignored and serialized bundle input cannot bypass native collection", async () => {
  const f = fixture(); const input = { ...config(), ownerAgents: ["eli"], loop: { complete: true, rounds: 1, lastAttemptAt: 0 },
    issue: { number: 45, type: "bug", approved: true }, ok: true, binding: config(), candidate: { ready: true } };
  const r = await run(f, context(), {}, input); expect(r.ok).toBe(true);
  if (r.ok) { expect(r.candidate).toBeNull(); expect(r.audit.reasons).toContain("owner_unverified"); expect(r.audit.reasons).toContain("intent_unverified"); expect(r.audit.reasons).toContain("loop_state_unproven"); }
  expect(f.calls).toHaveLength(29);
});
