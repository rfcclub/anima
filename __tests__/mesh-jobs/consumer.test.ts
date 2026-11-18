import { describe, expect, test } from "bun:test";
import { LeaseLostError, type MeshClaim, type MeshJob, type MeshJobReport } from "../../src/mesh-jobs/client";
import { findReview, MeshJobConsumer, type GitHubReader, type IssueState, type JobsPort, type PullRequestReview, type TurnRunner } from "../../src/mesh-jobs/consumer";

const CLAIM_AT = Date.parse("2026-10-14T01:00:00.000Z");
const HEAD = "abc1234def5678abc1234def5678abc1234def56";

function job(overrides: Partial<MeshJob> = {}): MeshJob {
  return {
    id: "job-1", enqueuer: "poller@mesh", type: "review",
    target: { repo: "rfcclub/anima", kind: "pr", number: 80, headSha: "abc1234" },
    slots: 2, expiresAt: CLAIM_AT + 3_600_000, state: "queued", createdAt: CLAIM_AT - 1000,
    ...overrides,
  };
}

const CLAIM: MeshClaim = { id: "claim-1", jobId: "job-1", worker: "jade@anima", state: "active", leaseExpiresAt: CLAIM_AT + 300_000, evidenceRef: null };

/** Records every call; behaviour is set per test. */
class FakeJobs implements JobsPort {
  calls: string[] = [];
  reports: MeshJobReport[] = [];
  pendingCount = 1;
  claimResult: MeshClaim | null = CLAIM;
  jobResult: MeshJob = job();
  heartbeatError: Error | null = null;
  async pending() { this.calls.push("pending"); return this.pendingCount; }
  async claim() { this.calls.push("claim"); return this.claimResult; }
  async getJob(id: string) { this.calls.push(`getJob:${id}`); return this.jobResult; }
  async heartbeat(id: string) {
    this.calls.push(`heartbeat:${id}`);
    if (this.heartbeatError) throw this.heartbeatError;
    return CLAIM;
  }
  async report(id: string, report: MeshJobReport) { this.calls.push(`report:${id}`); this.reports.push(report); return CLAIM; }
}

function github(reviews: PullRequestReview[] = [], headSha = HEAD): GitHubReader & { reviewReads: number } {
  return {
    reviewReads: 0,
    async pullRequest() { return { headSha, state: "open", merged: false, title: "Queue", body: "closes #76", author: "example-author" }; },
    async diff() { return "diff --git a/src/a.ts b/src/a.ts\n+x\n"; },
    async issue() { return { title: "Intent", body: "INTENT" }; },
    async reviews() { this.reviewReads += 1; return reviews; },
  };
}

function review(overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    commitId: HEAD, body: "Reviewer: Jade\nAPPROVE\nNo findings", authorType: "Bot",
    submittedAt: "2026-10-14T01:02:00Z", url: "https://github.com/rfcclub/anima/pull/80#pullrequestreview-9",
    ...overrides,
  };
}

interface FakeTurn { run: TurnRunner; calls: Array<{ agent: string; message: string; provider?: string; model?: string; intent?: { repo: string; issue: number; revision?: string } }>; aborted: boolean }

function turn(behaviour: (signal: AbortSignal) => Promise<void> = async () => {}): FakeTurn {
  const fake: FakeTurn = {
    calls: [],
    aborted: false,
    run: async ({ agent, message, signal, provider, model, intent }) => {
      fake.calls.push({ agent, message, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(intent ? { intent } : {}) });
      signal.addEventListener("abort", () => { fake.aborted = true; });
      await behaviour(signal);
    },
  };
  return fake;
}

function consumer(jobs: FakeJobs, gh: GitHubReader, t: FakeTurn, opts: { heartbeatMs?: number; turnTimeoutMs?: number; provider?: string; model?: string; intentReviewers?: Array<{ agent: string; login: string }> } = {}) {
  const lines: string[] = [];
  const c = new MeshJobConsumer({
    workers: [{ agent: "jade", jobs, ...(opts.provider ? { provider: opts.provider, model: opts.model } : {}) }],
    github: gh,
    runTurn: t.run,
    heartbeatMs: opts.heartbeatMs ?? 60_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? 600_000,
    ...(opts.intentReviewers ? { intentReviewers: opts.intentReviewers } : {}),
    now: () => CLAIM_AT,
    log: (level, message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`),
  });
  return { c, lines };
}

const untilAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve());
});

describe("MeshJobConsumer: pull path", () => {
  test("nothing pending → no claim, no turn", async () => {
    const jobs = new FakeJobs(); jobs.pendingCount = 0;
    const t = turn();
    await consumer(jobs, github(), t).c.tick();
    expect(jobs.calls).toEqual(["pending"]);
    expect(t.calls.length).toBe(0);
  });

  test("pending but nothing claimable → no job read, no turn", async () => {
    const jobs = new FakeJobs(); jobs.claimResult = null;
    const t = turn();
    await consumer(jobs, github(), t).c.tick();
    expect(jobs.calls).toEqual(["pending", "claim"]);
    expect(t.calls.length).toBe(0);
  });

  test("busy worker → a second tick makes no request", async () => {
    const jobs = new FakeJobs();
    let release!: () => void;
    const t = turn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { c } = consumer(jobs, github([review()]), t);
    const first = c.tick();
    while (t.calls.length === 0) await Bun.sleep(1);
    const before = jobs.calls.length;
    await c.tick();
    expect(jobs.calls.length).toBe(before);
    release();
    await first;
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: review().url }]);
  });
});

describe("MeshJobConsumer: job filtering", () => {
  test("not a review job → failed, no turn", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = job({ type: "revise" });
    const t = turn();
    await consumer(jobs, github(), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
    expect(t.calls.length).toBe(0);
  });

  test("review without a head → failed, no turn", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = job({ target: { repo: "rfcclub/anima", kind: "pr", number: 80 } });
    const t = turn();
    await consumer(jobs, github(), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
    expect(t.calls.length).toBe(0);
  });

  test("stale head → failed, no turn", async () => {
    const jobs = new FakeJobs();
    const t = turn();
    await consumer(jobs, github([], "def5678000000000000000000000000000000000"), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
    expect(t.calls.length).toBe(0);
  });
});

describe("MeshJobConsumer: evidence", () => {
  test("PR review jobs choose the headless review profile and retain the repository target", async () => {
    const jobs = new FakeJobs();
    let input: unknown;
    const c = new MeshJobConsumer({
      workers: [{ agent: "jade", jobs }],
      github: github([review()]),
      runTurn: async (value) => { input = value; },
      heartbeatMs: 60_000, turnTimeoutMs: 600_000, now: () => CLAIM_AT,
    });
    await c.tick();
    expect(input).toMatchObject({ profile: "review", repo: "rfcclub/anima", agent: "jade" });
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: review().url }]);
  });

  test("matching review → done with its URL; the turn got the review message", async () => {
    const jobs = new FakeJobs();
    const t = turn();
    await consumer(jobs, github([review()]), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: review().url }]);
    expect(t.calls[0]!.agent).toBe("jade");
    expect(t.calls[0]!.message).toContain("PR #80 on rfcclub/anima");
    expect(t.calls[0]!.message).toContain("INTENT");
  });

  test("no matching review → failed, whatever the agent said", async () => {
    const jobs = new FakeJobs();
    const reviews = [
      review({ commitId: "fff0000000000000000000000000000000000000" }),
      review({ body: "Reviewer: finn\nAPPROVE" }),
      review({ submittedAt: "2026-10-14T00:59:58Z" }),
    ];
    const t = turn(async () => { /* the agent replies "I approved it", which is not evidence */ });
    await consumer(jobs, github(reviews), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("real body shapes: a `Reviewer:` first line or an `Agent:` trailer line", () => {
    // Shapes: a `Reviewer:` first line, and an `Agent:` trailer line placed last.
    const finn = review({ body: "Reviewer: finn\n\nApproved. I read the PR description" });
    const jade = review({ body: "**Conclusion: Approve** head `abc1234`.\n\n### Checked\n- ok\n\nAgent: jade" });
    const quoted = review({ body: "**Approve.** Jade's earlier note said\n> Agent: jade\nwas fine." });
    expect(findReview([finn], "finn", "abc1234", CLAIM_AT)).toBe(finn);
    expect(findReview([jade], "jade", "abc1234", CLAIM_AT)).toBe(jade);
    expect(findReview([jade], "finn", "abc1234", CLAIM_AT)).toBeNull();
    expect(findReview([quoted], "jade", "abc1234", CLAIM_AT)).toBeNull();
  });

  test("a signed review submitted by a person (not an App) is not evidence", () => {
    expect(findReview([review({ authorType: "User" })], "jade", "abc1234", CLAIM_AT)).toBeNull();
  });

  test("a head shorter than 7 characters matches nothing and is not run", async () => {
    expect(findReview([review()], "jade", "abc", CLAIM_AT)).toBeNull();
    const jobs = new FakeJobs(); jobs.jobResult = job({ target: { repo: "rfcclub/anima", kind: "pr", number: 80, headSha: "abc" } });
    const t = turn();
    await consumer(jobs, github([review()]), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
    expect(t.calls.length).toBe(0);
  });

  test("a review in the same second as the claim counts", async () => {
    const jobs = new FakeJobs();
    await consumer(jobs, github([review({ submittedAt: "2026-10-14T01:00:00Z" })]), turn()).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: review().url }]);
  });

  test("turn error with a review on GitHub → done", async () => {
    const jobs = new FakeJobs();
    const t = turn(async () => { throw new Error("cli exited 1"); });
    await consumer(jobs, github([review()]), t).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: review().url }]);
  });
});

describe("MeshJobConsumer: lease", () => {
  test("heartbeats while the turn runs", async () => {
    const jobs = new FakeJobs();
    const t = turn(() => Bun.sleep(45));
    await consumer(jobs, github([review()]), t, { heartbeatMs: 10 }).c.tick();
    const heartbeats = jobs.calls.filter((call) => call === "heartbeat:claim-1").length;
    expect(heartbeats).toBeGreaterThanOrEqual(2);
    expect(jobs.calls.lastIndexOf("heartbeat:claim-1")).toBeLessThan(jobs.calls.indexOf("report:claim-1"));
  });

  test("lease lost during the turn → abort, no report, free for the next tick", async () => {
    const jobs = new FakeJobs();
    jobs.heartbeatError = new LeaseLostError(409, "lease-lost");
    const gh = github([review()]);
    const t = turn(untilAborted);
    const { c, lines } = consumer(jobs, gh, t, { heartbeatMs: 5 });
    await c.tick();
    expect(t.aborted).toBe(true);
    expect(jobs.calls.some((call) => call.startsWith("report:"))).toBe(false);
    expect(lines.some((line) => line.includes("lease lost"))).toBe(true);
    jobs.heartbeatError = null; jobs.pendingCount = 0;
    await c.tick();
    expect(jobs.calls.at(-1)).toBe("pending");
  });

  test("turn timeout → abort, then failed without a matching review", async () => {
    const jobs = new FakeJobs();
    const t = turn(untilAborted);
    await consumer(jobs, github([]), t, { turnTimeoutMs: 15 }).c.tick();
    expect(t.aborted).toBe(true);
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });
});

describe("MeshJobConsumer: review model", () => {
  test("WM-4 runs the review turn with the worker's provider and model", async () => {
    const jobs = new FakeJobs();
    const t = turn();
    await consumer(jobs, github(), t, { provider: "hypercharm", model: "prism" }).c.tick();
    expect(t.calls.map(({ agent, provider, model }) => ({ agent, provider, model }))).toEqual([{ agent: "jade", provider: "hypercharm", model: "prism" }]);
  });
});

describe("MeshJobConsumer: intent review", () => {
  const BUTTON = "<!-- orca-approve -->\n- [ ] Approve\n\nA reviewer ticks the box above to approve this issue as the intent of record.";
  const BUTTON_URL = "https://github.com/rfcclub/anima/issues/7#issuecomment-1";

  function intentState(ticked: boolean, labels = ["orca:intent"], authorLogin = "rfcclub"): IssueState {
    return {
      title: "Intent", body: "INTENT", labels, authorLogin,
      comments: [{
        id: 1, author: "github-actions[bot]", url: BUTTON_URL,
        body: BUTTON.replace("- [ ] Approve", ticked ? "- [x] Approve" : "- [ ] Approve"),
        updatedAt: ticked ? "2026-10-14T01:03:00Z" : "2026-10-14T00:59:00Z",
      }],
    };
  }

  function intentJob(): MeshJob {
    return job({ type: "review-intent", target: { repo: "rfcclub/anima", kind: "issue", number: 7 } });
  }

  function intentGitHub(states: IssueState[]): GitHubReader {
    let index = 0;
    return {
      async pullRequest() { throw new Error("not used"); },
      async diff() { return ""; },
      async issue() { return { title: "Intent", body: "INTENT" }; },
      async reviews() { return []; },
      async issueState() { return states[Math.min(index++, states.length - 1)]!; },
    };
  }

  test("a ticked approval box at or after the claim is evidence; the agent is told to approve", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    await consumer(jobs, intentGitHub([intentState(false), intentState(true, ["orca:intent", "orca:approved"])]), t, {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(t.calls[0]!.message).toContain("action=approve_intent");
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: BUTTON_URL }]);
  });

  test("the workflow label is required, not just a ticked box", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    await consumer(jobs, intentGitHub([intentState(false), intentState(true)]), turn(), {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("a lookalike button from a non-workflow author is not evidence", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const planted = intentState(true, ["orca:intent", "orca:approved"]);
    planted.comments[0]!.author = "fake-github-actions";
    await consumer(jobs, intentGitHub([intentState(false), planted]), turn(), {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("an intent with no author login fails closed before any turn", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    await consumer(jobs, intentGitHub([intentState(false, ["orca:intent"], "")]), t, {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(t.calls).toHaveLength(0);
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("a reviewer who authored the intent cannot review it", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    await consumer(jobs, intentGitHub([intentState(false, ["orca:intent"], "jade-gotako[bot]")]), t, {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(t.calls).toHaveLength(0);
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("an unticked box is a failed review, even after the turn", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    await consumer(jobs, intentGitHub([intentState(false), intentState(false)]), turn(), {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("without a configured intent reviewer the job fails without a turn", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    await consumer(jobs, intentGitHub([intentState(false)]), t).c.tick();
    expect(t.calls).toHaveLength(0);
    expect(jobs.reports).toEqual([{ outcome: "failed" }]);
  });

  test("an intent that is already approved reports done without a turn", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    await consumer(jobs, intentGitHub([intentState(false, ["orca:intent", "orca:approved"])]), t, {
      intentReviewers: [{ agent: "jade", login: "jade-gotako[bot]" }],
    }).c.tick();
    expect(t.calls).toHaveLength(0);
    expect(jobs.reports).toEqual([{ outcome: "done", evidenceRef: "https://github.com/rfcclub/anima/issues/7" }]);
  });
});

describe("MeshJobConsumer: intent review budget", () => {
  const REVIEWERS = [{ agent: "jade", login: "jade-gotako[bot]" }];
  const state: IssueState = { title: "Intent", body: "INTENT", labels: ["orca:intent"], authorLogin: "rfcclub", comments: [] };
  const intentJob = () => job({ type: "review-intent", target: { repo: "rfcclub/anima", kind: "issue", number: 7 } });
  const gh = (): GitHubReader => ({
    async pullRequest() { throw new Error("not used"); },
    async diff() { return ""; },
    async issue() { return { title: "Intent", body: "INTENT" }; },
    async reviews() { return []; },
    async issueState() { return state; },
  });

  test("an intent-review turn is told which issue it reviews, so its process can enforce one verdict", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    await consumer(jobs, gh(), t, { intentReviewers: REVIEWERS }).c.tick();
    expect(t.calls[0]!.intent).toEqual({ repo: "rfcclub/anima", issue: 7, revision: expect.stringMatching(/^[0-9a-f]{12}$/) });
  });

  test("each claim's turn carries the target again (SC-019)", async () => {
    const jobs = new FakeJobs(); jobs.jobResult = intentJob();
    const t = turn();
    const { c } = consumer(jobs, gh(), t, { intentReviewers: REVIEWERS });
    await c.tick();
    await c.tick();
    expect(t.calls.map((call) => call.intent)).toEqual([{ repo: "rfcclub/anima", issue: 7, revision: expect.stringMatching(/^[0-9a-f]{12}$/) }, { repo: "rfcclub/anima", issue: 7, revision: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
  });

  test("a pull-request review turn carries no intent target", async () => {
    const jobs = new FakeJobs();
    const t = turn();
    await consumer(jobs, github([review()]), t).c.tick();
    expect(t.calls[0]!.intent).toBeUndefined();
  });
});
