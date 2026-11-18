/**
 * castle-work-loop: the `gh`-backed read adapter for the reconciler, and the Mesh client's
 * enqueue and confirm. Scripted runners and a fake fetch; nothing reaches GitHub or a gateway.
 */

import { test, expect, describe } from "bun:test";
import { ghWorkGitHub } from "../../src/work/gh-adapter";
import { MeshJobsClient, LeaseLostError } from "../../src/mesh-jobs/client";

const prJson = (over: Record<string, unknown> = {}) => ({
  number: 12, html_url: "https://github.com/rfcclub/anima/pull/12", state: "open", merged_at: null,
  head: { sha: "a".repeat(40), ref: "work/7-wabc" }, base: { ref: "master", repo: { full_name: "rfcclub/anima" } },
  body: "Closes #7", user: { login: "finn-gotako[bot]" }, ...over,
});

describe("ghWorkGitHub", () => {
  test("finds the pull request by head branch and maps it", async () => {
    const calls: string[][] = [];
    const gh = ghWorkGitHub(async (args) => { calls.push(args); return JSON.stringify([prJson()]); });
    const pr = await gh.findPullRequest("rfcclub/anima", "work/7-wabc");
    expect(calls[0]!.join(" ")).toContain("repos/rfcclub/anima/pulls");
    expect(calls[0]!.join(" ")).toContain("head=rfcclub:work/7-wabc");
    expect(pr).toEqual({
      repo: "rfcclub/anima", number: 12, url: "https://github.com/rfcclub/anima/pull/12", state: "open", merged: false,
      headSha: "a".repeat(40), headRef: "work/7-wabc", baseRef: "master", body: "Closes #7", authorLogin: "finn-gotako[bot]",
    });
  });

  test("mergeable keeps GitHub's null (unknown) instead of dropping it", async () => {
    const unknown = await ghWorkGitHub(async () => JSON.stringify(prJson({ mergeable: null }))).pullRequest("rfcclub/anima", 12);
    expect(unknown.mergeable).toBeNull();
    const yes = await ghWorkGitHub(async () => JSON.stringify(prJson({ mergeable: true }))).pullRequest("rfcclub/anima", 12);
    expect(yes.mergeable).toBe(true);
    const no = await ghWorkGitHub(async () => JSON.stringify(prJson({ mergeable: false }))).pullRequest("rfcclub/anima", 12);
    expect(no.mergeable).toBe(false);
  });

  test("none found is null; a merged one is state closed and merged", async () => {
    expect(await ghWorkGitHub(async () => "[]").findPullRequest("rfcclub/anima", "x")).toBeNull();
    const merged = await ghWorkGitHub(async () => JSON.stringify(prJson({ state: "closed", merged_at: "2026-10-22T13:00:00Z" }))).pullRequest("rfcclub/anima", 12);
    expect([merged.state, merged.merged]).toEqual(["closed", true]);
  });

  test("a head branch that is not a plain branch name is refused before any call", async () => {
    let called = 0;
    const gh = ghWorkGitHub(async () => { called++; return "[]"; });
    await expect(gh.findPullRequest("rfcclub/anima", "a b; rm")).rejects.toThrow(/branch/);
    await expect(gh.findPullRequest("not a repo", "x")).rejects.toThrow(/repository/);
    expect(called).toBe(0);
  });

  test("merge picks a strategy the repository allows", async () => {
    const calls: string[][] = [];
    const gh = ghWorkGitHub(async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "repos/rfcclub/anima") {
        return JSON.stringify({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false });
      }
      return "";
    });
    await gh.merge!("rfcclub/anima", 12, "a".repeat(40));
    expect(calls[1]!.join(" ")).toContain("--squash");
    expect(calls[1]!.join(" ")).toContain("--match-head-commit");
  });

  test("reviews carry id, state, commit, login, type, url, time and body; a pending review is left out", async () => {
    const gh = ghWorkGitHub(async () => JSON.stringify([
      { id: 5, state: "CHANGES_REQUESTED", commit_id: "a".repeat(40), user: { login: "cleo-gotako[bot]", type: "Bot" }, html_url: "https://github.com/x/pull/12#pullrequestreview-5", submitted_at: "2026-10-22T12:00:00Z", body: "add a test" },
      { id: 6, state: "PENDING", commit_id: "a".repeat(40), user: { login: "x", type: "User" }, html_url: "u", submitted_at: null, body: "" },
    ]));
    const reviews = await gh.reviews("rfcclub/anima", 12);
    expect(reviews.length).toBe(1);
    expect(reviews[0]).toMatchObject({ id: 5, state: "CHANGES_REQUESTED", commitId: "a".repeat(40), authorLogin: "cleo-gotako[bot]", authorType: "Bot", body: "add a test" });
  });

  test("inline feedback is bound to its review, author, head, and source location", async () => {
    const calls: string[][] = [];
    const gh = ghWorkGitHub(async (args) => {
      calls.push(args);
      return JSON.stringify([{ pull_request_review_id: 42, commit_id: "a".repeat(40), user: { login: "rfcclub" },
        path: "scripts/deploy.sh", line: 271, body: "verify dispatcher" }]);
    });
    expect(typeof gh.reviewComments).toBe("function");
    const comments = await gh.reviewComments!("rfcclub/anima", 12);
    expect(calls[0]).toContain("--paginate");
    expect(comments).toEqual([{ reviewId: 42, commitId: "a".repeat(40), authorLogin: "rfcclub",
      path: "scripts/deploy.sh", line: 271, body: "verify dispatcher" }]);
  });

  test.each([
    { kind: "reviews", count: 0 }, { kind: "reviews", count: 1 }, { kind: "reviews", count: 3 },
    { kind: "review comments", count: 0 }, { kind: "review comments", count: 1 }, { kind: "review comments", count: 3 },
  ])("reads $count NDJSON items from paginated $kind", async ({ kind, count }) => {
    const head = "a".repeat(40);
    const calls: string[][] = [];
    const items = Array.from({ length: count }, (_, i) => i + 1);
    const gh = ghWorkGitHub(async (args) => {
      calls.push(args);
      const rows = args[1]!.includes("/comments?")
        ? items.map((id) => ({ pull_request_review_id: id, commit_id: head, user: { login: `reviewer${id}` },
          path: `file${id}.ts`, line: id, body: `comment ${id}\nsecond line` }))
        : items.map((id) => ({ id, state: "CHANGES_REQUESTED", commit_id: head, user: { login: `reviewer${id}`, type: "User" },
          html_url: `url${id}`, submitted_at: "2026-11-07T12:00:00Z", body: `review ${id}\nsecond line` }));
      return rows.map((row) => JSON.stringify(row)).join("\n");
    });
    if (kind === "reviews") {
      expect(await gh.reviews("rfcclub/anima", 12)).toEqual(items.map((id) => ({
        id, state: "CHANGES_REQUESTED", commitId: head, authorLogin: `reviewer${id}`, authorType: "User",
        url: `url${id}`, submittedAt: "2026-11-07T12:00:00Z", body: `review ${id}\nsecond line`,
      })));
    } else {
      expect(await gh.reviewComments!("rfcclub/anima", 12)).toEqual(items.map((id) => ({
        reviewId: id, commitId: head, authorLogin: `reviewer${id}`, path: `file${id}.ts`, line: id, body: `comment ${id}\nsecond line`,
      })));
    }
    expect(calls).toEqual([["api", `repos/rfcclub/anima/pulls/12/${kind === "reviews" ? "reviews" : "comments"}?per_page=100`,
      "--paginate", "--jq", ".[]"]]);
  });

  test.each(["reviews", "review comments"])("reads a single JSON array from paginated %s", async (kind) => {
    const head = "a".repeat(40);
    const rows = [1, 2].map((id) => kind === "reviews"
      ? { id, state: "APPROVED", commit_id: head, user: { login: `reviewer${id}`, type: "User" },
        html_url: `url${id}`, submitted_at: "2026-11-07T12:00:00Z", body: `review ${id}` }
      : { pull_request_review_id: id, commit_id: head, user: { login: `reviewer${id}` },
        path: `file${id}.ts`, line: id, body: `comment ${id}` });
    for (const output of [JSON.stringify(rows), JSON.stringify(rows, null, 2)]) {
      const gh = ghWorkGitHub(async () => output);
      const result = kind === "reviews"
        ? await gh.reviews("rfcclub/anima", 12)
        : await gh.reviewComments!("rfcclub/anima", 12);
      expect(result.map((item) => "id" in item ? item.id : item.reviewId)).toEqual([1, 2]);
    }
  });
});

describe("MeshJobsClient enqueue and confirm", () => {
  function client(handler: (url: string, init: RequestInit) => Response) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return handler(url, init); }) as unknown as typeof fetch;
    return { seen, c: new MeshJobsClient("http://127.0.0.1:1526", () => "cap-SECRET", fetchImpl) };
  }

  test("enqueue posts the job as the caller and returns the gateway's job", async () => {
    const { c, seen } = client(() => Response.json({ id: "job-9", state: "queued" }, { status: 201 }));
    const job = await c.enqueue({ type: "review", target: { repo: "a/b", kind: "pr", number: 1, headSha: "abc1234" }, slots: 1, expiresAt: 1, idempotencyKey: "k" });
    expect(job.id).toBe("job-9");
    expect(seen[0]!.url).toBe("http://127.0.0.1:1526/jobs");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer cap-SECRET");
  });

  test("confirm posts to the job's confirm route", async () => {
    const { c, seen } = client(() => Response.json({ id: "job-9", state: "completed" }));
    await c.confirm("job-9");
    expect(seen[0]!.url).toBe("http://127.0.0.1:1526/jobs/job-9/confirm");
  });

  test("a 409 is reported as such and the capability never appears in an error", async () => {
    const { c } = client(() => new Response("job job-9 is not reported (state completed) cap-SECRET", { status: 409 }));
    try {
      await c.confirm("job-9");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LeaseLostError);
      expect(String((error as Error).message)).not.toContain("cap-SECRET");
      expect((error as Error).message).toContain("is not reported");
    }
  });
});
