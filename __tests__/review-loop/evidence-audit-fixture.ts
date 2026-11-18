// Synthetic native HTTP fixture copied from the unchanged bundle test; no live I/O.
import { expect } from "bun:test";
import { DISCUSSION_QUERIES } from "../../src/review-loop/discussion";

export const H = "a".repeat(40), B = "b".repeat(40), X = "c".repeat(40);
export const REPO = "rfcclub/anima", ROOT = `/repos/${REPO}`, PR = `${ROOT}/pulls/45`;
export const AUTHOR = "eli-gotako[bot]", SECRET = "fixture-credential-not-a-live-token";
export const config = () => ({ repo: REPO, number: 45, authorLogin: AUTHOR });
const page = (nodes: unknown[]) => ({ nodes, totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: nodes.length ? "cursor1" : null } });
interface Call { path: string; init: RequestInit; occurrence: number; kind?: string }
export function fixture(edit?: (call: Call, value: any) => unknown | Promise<unknown>) {
  const calls: Call[] = [], signals: AbortSignal[] = [];
  const counts = new Map<string, number>();
  let credentials = 0;
  const metadata = { number: 45, state: "open", draft: false,
    head: { sha: H, repo: { full_name: REPO } },
    base: { sha: B, ref: "feature/base", repo: { full_name: REPO } },
    user: { type: "Bot", login: AUTHOR }, changed_files: 1, commits: 1 };
  const records: Record<string, unknown> = {
    [PR]: metadata,
    [`${ROOT}/git/ref/heads/feature%2Fbase`]: { ref: "refs/heads/feature/base", object: { type: "commit", sha: B } },
    [`${PR}/files?per_page=100&page=1`]: [{ filename: "src/safe.ts", status: "modified" }],
    [`${PR}/commits?per_page=100&page=1`]: [{ sha: H, author: { login: AUTHOR },
      committer: { login: AUTHOR }, commit: { message: "change\n\nAgent: eli" } }],
    [`${ROOT}/git/trees/${B}?recursive=1`]: { sha: B, truncated: false,
      tree: [{ path: ".github/workflows/ci.yml", type: "blob", mode: "100644", sha: X }] },
    [`${ROOT}/actions/runs?head_sha=${H}&per_page=100&page=1`]: { total_count: 0, workflow_runs: [] },
    [`${ROOT}/commits/${H}/check-suites?per_page=100&page=1`]: { total_count: 1,
      check_suites: [{ id: 21, head_sha: H, app: { id: 7, slug: "external-ci" } }] },
    [`${ROOT}/check-suites/21/check-runs?filter=all&per_page=100&page=1`]: { total_count: 1,
      check_runs: [{ id: 31, name: "test", head_sha: H, check_suite: { id: 21 },
        app: { id: 7, slug: "external-ci" }, status: "completed", conclusion: "success",
        started_at: null, completed_at: null }] },
    [`${ROOT}/commits/${H}/status?per_page=100&page=1`]: { sha: H, state: "pending", total_count: 0, statuses: [] },
  };
  const deps = {
    credential: async (signal: AbortSignal) => { credentials++; signals.push(signal); return SECRET; },
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      expect(new URL(url).origin).toBe("https://api.github.com");
      const path = url.slice("https://api.github.com".length);
      const occurrence = (counts.get(path) ?? 0) + 1; counts.set(path, occurrence);
      const call: Call = { path, init, occurrence }; calls.push(call);
      let value: any;
      if (path === "/graphql") {
        expect(init.method).toBe("POST");
        const request = JSON.parse(String(init.body));
        call.kind = Object.entries(DISCUSSION_QUERIES).find(([, text]) => text === request.query)?.[0];
        expect(call.kind).toBeDefined();
        expect(request.variables).toMatchObject({ owner: "rfcclub", name: "anima", number: 45,
          baseRef: "refs/heads/feature/base" });
        const pullRequest: any = { number: 45, state: "OPEN", isDraft: false,
          headRefOid: H, baseRefOid: B, baseRefName: "feature/base" };
        if (call.kind === "reviews") pullRequest.reviews = page([{ id: "R1", fullDatabaseId: "6000000001",
          author: { __typename: "Bot", login: "reviewer" }, body: "Reviewer: bruno", state: "APPROVED",
          submittedAt: "2026-10-29T12:00:00Z", commit: { oid: H } }]);
        if (call.kind === "threads") pullRequest.reviewThreads = page([{ id: "T1", isResolved: false,
          isOutdated: true, pullRequest: { number: 45, repository: { nameWithOwner: REPO } },
          comments: { totalCount: 1 } }]);
        if (call.kind === "comments") pullRequest.comments = page([]);
        value = { data: { repository: { nameWithOwner: REPO,
          ref: { name: "feature/base", target: { __typename: "Commit", oid: B } }, pullRequest },
          rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: "2100-01-01T00:00:00Z" } } };
        if (call.kind === "threadComments") value.data.node = { id: "T1", isResolved: false, isOutdated: true,
          pullRequest: { number: 45, repository: { nameWithOwner: REPO } }, comments: page([{ id: "C1",
            fullDatabaseId: "7000000001", author: { __typename: "User", login: "rfcclub" }, body: "discuss",
            createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-10-29T12:00:00Z" }]) };
      } else {
        expect(init.method).toBe("GET"); expect(init.body).toBeUndefined();
        if (!(path in records)) throw Error("Unexpected fixture path");
        value = structuredClone(records[path]);
      }
      const result = edit ? await edit(call, value) : value;
      return result instanceof Response ? result : Response.json(result);
    },
  };
  return { calls, records, metadata, deps, signals, get credentials() { return credentials; } };
}
