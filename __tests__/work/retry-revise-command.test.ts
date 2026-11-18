import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltTest } from "../helpers/seatbelt";
import { issueDigest12 } from "../../src/work/approval";
import { loadWorkConfig } from "../../src/work/config";
import { gitInRecoveryTree, gitInTree } from "../../src/work/production";
import { recoverWork } from "../../src/work/recover";
import { createStopRecorder } from "../../src/work/stops";
import { WorkStore } from "../../src/work/store";
import { prepareWorkspace } from "../../src/work/workspace";

const BODY = "approved intent";
const JOB = "52a16701-2060-4ab5-9afd-920e45131d44";

test("the work CLI exposes retry-revise usage without treating it as recover", () => {
  const proc = Bun.spawnSync({ cmd: ["bun", "src/cli.ts", "work", "retry-revise"], env: { ...process.env, NODE_ENV: "test" } });
  expect(proc.exitCode).not.toBe(0);
  expect(proc.stderr.toString()).toContain("anima work retry-revise");
});

test("the retry command rejects a head SHA that Mesh cannot accept", async () => {
  const { parseRetryRevisionArgs } = await import("../../src/work/retry-revise");
  expect(() => parseRetryRevisionArgs(["retry-revise", "w1", "--job", JOB, "--head", "a".repeat(64)])).toThrow(/head/i);
});

seatbeltTest("regression: a recovered revision rejects unauthorized reviews and dispatches one matching job", async () => {
  const root = mkdtempSync(join(tmpdir(), "retry-revise-command-"));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]): string => {
    const p = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
      cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const dbPath = join(root, "work.db");
  const store = WorkStore.open(dbPath, { rootBase: root });
  try {
    git(source, "init", "-q", "-b", "master");
    writeFileSync(join(source, "tracked.txt"), "checkpoint\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    const head = git(source, "rev-parse", "HEAD");
    const work = store.createWork({ repo: "test/anima", issue: 7, approvedDigest: issueDigest12(BODY), config: loadWorkConfig({}) }).work;
    const ws = await prepareWorkspace({ root: work.root, source, branch: work.branch });
    const pr = { repo: work.repo, number: 12, url: "https://github.com/test/anima/pull/12", state: "open" as const, merged: false,
      headSha: head, headRef: work.branch, baseRef: "master", body: "Closes #7", authorLogin: "finn-gotako[bot]" };
    store.recordPullRequest(work.workId, { number: pr.number, head, url: pr.url });
    const session = store.reserveSession(work.workId, { jobId: "old-job", claimId: "old-claim" });
    if (!session.ok) throw new Error("could not reserve fixture session");
    store.closeSession(session.session.sessionId, { stopCause: "done", iterations: 1, execMs: 1 });
    createStopRecorder({ store, read: gitInTree })({ work, session: store.getSession(session.session.sessionId)!,
      adapter: "loop", stopCause: "done", cessation: "proven", leaseHeld: true, generationCurrent: true });
    store.setState(work.workId, "blocked", "fixture");
    await recoverWork({ store, read: gitInRecoveryTree }, { workId: work.workId, base: head, caps: {} });

    const config = { author: "finn", authorActor: "finn-gotako[bot]", authorMeshId: "finn@anima", base: "master",
      reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }] };
    const reviews = [
      { id: 1, state: "CHANGES_REQUESTED" as const, commitId: head, authorLogin: "cleo-gotako[bot]", authorType: "Bot", url: "u", submittedAt: "t", body: "fix bootout" },
      { id: 2, state: "CHANGES_REQUESTED" as const, commitId: head, authorLogin: "rfcclub", authorType: "User", url: "u", submittedAt: "t", body: "verify readiness" },
    ];
    let currentBody = BODY;
    const github = { findPullRequest: async () => pr, pullRequest: async () => pr, reviews: async () => reviews };
    const deps = { store, read: gitInRecoveryTree, github, issue: async () => ({ title: "issue", body: currentBody }), config };
    const input = { workId: work.workId, head, failedJobId: JOB, reviewers: ["rfcclub"] };

    expect(existsSync(join(import.meta.dir, "../../src/work/retry-revise.ts"))).toBe(true);
    const { requestRevisionRetry } = await import("../../src/work/retry-revise");
    await expect(requestRevisionRetry(deps, { ...input, head: "a".repeat(40) })).rejects.toThrow(/head/i);
    await expect(requestRevisionRetry(deps, { ...input, reviewers: ["stranger"] })).rejects.toThrow(/review/i);
    currentBody = "changed intent";
    await expect(requestRevisionRetry(deps, input)).rejects.toThrow(/issue|approval|digest/i);
    currentBody = BODY;
    writeFileSync(join(ws.tree, "tracked.txt"), "changed\n");
    await expect(requestRevisionRetry(deps, input)).rejects.toThrow(/tree|checkpoint|contents/i);
    writeFileSync(join(ws.tree, "tracked.txt"), "checkpoint\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const fakeIssue = join(root, "issue.json");
    const fakePr = join(root, "pr.json");
    const fakeReviews = join(root, "reviews.json");
    const configPath = join(root, "mesh-jobs.json");
    writeFileSync(fakeIssue, JSON.stringify({ title: "issue", body: BODY }));
    writeFileSync(fakePr, JSON.stringify({ number: pr.number, html_url: pr.url, state: pr.state, merged_at: null,
      head: { sha: head, ref: pr.headRef }, base: { ref: pr.baseRef, repo: { full_name: pr.repo } },
      body: pr.body, user: { login: pr.authorLogin } }));
    writeFileSync(fakeReviews, JSON.stringify(reviews.map((r) => ({
      id: r.id, state: r.state, commit_id: r.commitId, user: { login: r.authorLogin, type: r.authorType },
      html_url: r.url, submitted_at: r.submittedAt, body: r.body,
    }))));
    writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "issue view "*) /bin/cat "$ELI_RETRY_ISSUE" ;;
  "api repos/test/anima/pulls/12") /bin/cat "$ELI_RETRY_PR" ;;
  "api repos/test/anima/pulls/12/reviews?"*) /bin/cat "$ELI_RETRY_REVIEWS" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    writeFileSync(configPath, JSON.stringify({ gatewayUrl: "http://127.0.0.1:1526", workers: [{ agent: "finn" }],
      work: { enabled: true, ...config, enqueuer: "finn" } }), { mode: 0o600 });
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "src/cli.ts", "work", "retry-revise", work.workId, "--job", JOB, "--head", head, "--reviewer", "rfcclub"],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, ANIMA_WORK_DB: dbPath,
        ANIMA_WORK_ROOT: root, ANIMA_MESH_JOBS_CONFIG: configPath, ELI_RETRY_ISSUE: fakeIssue, ELI_RETRY_PR: fakePr,
        ELI_RETRY_REVIEWS: fakeReviews, NODE_ENV: "test" },
    });
    expect({ code: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(proc.stdout.toString()).toContain("the reconciler validates and dispatches");
    const again = await requestRevisionRetry(deps, input);
    expect(again.inserted).toBe(false);
    expect(proc.stdout.toString()).toContain(again.key);
    expect(store.listOutbox(work.workId)).toHaveLength(1);
    expect(store.listEvents(work.workId).filter((e) => e.kind === "operator-revise-retry")).toHaveLength(1);
    await expect(requestRevisionRetry(deps, { ...input, reviewers: [] })).rejects.toThrow(/different|already/i);
    expect(store.getWork(work.workId)!.state).toBe("checkpointed");
    const { Reconciler } = await import("../../src/work/reconciler");
    const sent: Record<string, unknown>[] = [];
    const mesh = {
      getJob: async () => ({ id: JOB, enqueuer: "finn@anima", type: "revise", slots: 1, state: "queued",
        target: { repo: work.repo, kind: "pr", number: 12, headSha: head }, eligible: ["finn@anima"], excluded: [],
        workRef: `${work.workId}.${issueDigest12(BODY)}`, expiresAt: Date.now() + 60_000, createdAt: Date.now(),
        claims: [{ id: "claim", jobId: JOB, worker: "finn@anima", state: "failed", leaseExpiresAt: 0, evidenceRef: null }] }),
      enqueue: async (job: Record<string, unknown>) => { sent.push(job); return { id: "new-job" }; },
      confirm: async () => {},
    };
    await new Reconciler({ store, github, mesh: mesh as any,
      config: { base: "master", authorActor: config.authorActor, authorMeshIds: [config.authorMeshId],
        reviewers: config.reviewers, retryBackoffMs: 60_000 } }).tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "revise", target: { repo: work.repo, kind: "pr", number: 12, headSha: head },
      workRef: `${work.workId}.${issueDigest12(BODY)}`, eligible: ["finn@anima"], idempotencyKey: again.key });
    expect(store.listOutbox(work.workId)[0]!.status).toBe("done");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
