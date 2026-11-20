import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildIntentReviewJob,
  buildStartWorkJob,
  dispatchApprovedIssues,
  dispatchIntentReviews,
  dispatchPrReviews,
  freshJob,
  intentRevision,
  issueDigest,
  loadPipelineConfig,
  type PipelineConfig,
} from "../../src/mesh-jobs/pipeline";
import { issueDigest12 } from "../../src/work/approval";
import type { MeshJobsWorkConfig } from "../../src/mesh-jobs/config";
import type { WorkRecord } from "../../src/work/store";

let dir: string;
let path: string;

function write(value: unknown, mode = 0o600): void {
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, mode);
}

function errorOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a throw");
}

const WORK: MeshJobsWorkConfig = {
  author: "finn",
  authorActor: "finn-gotako[bot]",
  authorMeshId: "finn-anima-cab0dbd4@host-1",
  enqueuer: "finn",
  base: "master",
  reviewers: [{ agent: "cleo", meshId: "cleo-anima-cab0dbd4@host-1", login: "cleo-gotako[bot]" }],
  releaseBackoffMs: 30_000,
  reconcileIntervalMs: 60_000,
  perToolCallMs: 120_000,
  cloneUrl: "/Users/user/work/{repo}",
};

const CONFIG: PipelineConfig = {
  repos: ["rfcclub/anima"], reviewRepos: ["rfcclub/anima"], intervalMs: 300_000,
  issueLabel: "orca:approved", intentLabel: "orca:intent", notBefore: 0,
  maxPerPoll: 3, maxIntentPerPoll: 2, maxReviewPerPoll: 3,
};

function issue(number: number, body: string, labels = ["orca:intent", "orca:approved"], createdAt = "2026-11-01T00:00:00Z") {
  return { number, title: `issue ${number}`, body, createdAt, labels: labels.map((name) => ({ name })) };
}

function workRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    workId: "w13873f3ae3", repo: "rfcclub/anima", issue: 7, approvedDigest: "abcdef123456",
    author: "finn", provider: "agnes", model: "agnes-3.0-flash", state: "accepted",
    generation: 1, branch: "work/7-w13873f3ae3", root: "/tmp/work", caps: {} as WorkRecord["caps"],
    sessionsUsed: 0, iterationsUsed: 0, execMsUsed: 0, blockedReason: null,
    prNumber: null, prHead: null, prUrl: null, startJobId: null,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function logLines(): Array<{ level: string; message: string; fields?: Record<string, unknown> }> {
  return [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipeline-config-"));
  path = join(dir, "pipeline.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadPipelineConfig", () => {
  test("absent file → null", () => {
    expect(loadPipelineConfig(path)).toBeNull();
  });

  test("readable by others → throws without echoing content", () => {
    write({ repos: ["rfcclub/anima"], intervalMs: 300_000 }, 0o644);
    const message = errorOf(() => loadPipelineConfig(path));
    expect(message).toContain("mode 0600");
  });

  test("defaults issueLabel, intentLabel, reviewRepos and caps", () => {
    write({ repos: ["rfcclub/anima"], notBefore: "2026-11-01T20:00:00Z" });
    expect(loadPipelineConfig(path)).toEqual({
      repos: ["rfcclub/anima"], reviewRepos: ["rfcclub/anima"], intervalMs: 300_000,
      issueLabel: "orca:approved", intentLabel: "orca:intent",
      notBefore: Date.parse("2026-11-01T20:00:00Z"),
      maxPerPoll: 3, maxIntentPerPoll: 2, maxReviewPerPoll: 3, maxStartRedispatch: 2,
    });
  });

  test("maxStartRedispatch is a bounded integer", () => {
    write({ repos: ["rfcclub/anima"], notBefore: "2026-11-01T20:00:00Z", maxStartRedispatch: 0 });
    expect(loadPipelineConfig(path)!.maxStartRedispatch).toBe(0);
    write({ repos: ["rfcclub/anima"], notBefore: "2026-11-01T20:00:00Z", maxStartRedispatch: 11 });
    expect(errorOf(() => loadPipelineConfig(path))).toContain("maxStartRedispatch");
  });

  test("notBefore is required so a missing field cannot drain the backlog", () => {
    write({ repos: ["rfcclub/anima"] });
    expect(errorOf(() => loadPipelineConfig(path))).toContain("notBefore");
  });

  test("parses notBefore, reviewRepos and caps", () => {
    write({
      repos: ["rfcclub/anima"], reviewRepos: ["rfcclub/anima", "rfcclub/colony-mesh"],
      notBefore: "2026-11-01T20:00:00Z", maxPerPoll: 1, maxIntentPerPoll: 4, maxReviewPerPoll: 2,
    });
    expect(loadPipelineConfig(path)).toMatchObject({
      reviewRepos: ["rfcclub/anima", "rfcclub/colony-mesh"],
      notBefore: Date.parse("2026-11-01T20:00:00Z"), maxPerPoll: 1, maxIntentPerPoll: 4, maxReviewPerPoll: 2,
    });
  });

  test("invalid fields are refused", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ repos: [] }, "repos"],
      [{ repos: ["not-a-repo"] }, "repo"],
      [{ repos: ["a/b", "a/b"] }, "duplicate"],
      [{ repos: ["a/b"], intervalMs: 500 }, "intervalMs"],
      [{ repos: ["a/b"], issueLabel: "bad label" }, "issueLabel"],
      [{ repos: ["a/b"], intentLabel: "bad label" }, "intentLabel"],
      [{ repos: ["a/b"], reviewRepos: ["bad"] }, "review repo"],
      [{ repos: ["a/b"], notBefore: "not a date" }, "notBefore"],
      [{ repos: ["a/b"], maxPerPoll: 0 }, "maxPerPoll"],
      [{ repos: ["a/b"], maxIntentPerPoll: 11 }, "maxIntentPerPoll"],
      [{ repos: ["a/b"], maxReviewPerPoll: 0 }, "maxReviewPerPoll"],
      [{ repos: ["a/b"], extra: true }, "unknown field"],
    ];
    for (const [value, field] of cases) {
      write({ notBefore: "2026-11-01T00:00:00Z", ...value });
      expect(errorOf(() => loadPipelineConfig(path))).toContain(field);
    }
  });
});

describe("issueDigest", () => {
  test("matches the mesh work digest for the same body", () => {
    const body = "Approved body\n";
    expect(issueDigest(body)).toBe(createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12));
    expect(issueDigest(body)).toBe(issueDigest12(body));
    expect(issueDigest(null)).toBe(createHash("sha256").update("", "utf8").digest("hex").slice(0, 12));
  });
});

describe("freshJob", () => {
  test("a replay with the original createdAt does not spend the cap", () => {
    expect(freshJob({ createdAt: 1_000_000 }, 1_000_000)).toBe(true);
    expect(freshJob({ createdAt: 0 }, 1_000_000)).toBe(false);
    expect(freshJob({}, 1_000_000)).toBe(false);
  });
});

describe("buildStartWorkJob", () => {
  test("has the shape the gateway and work runtime expect", () => {
    const job = buildStartWorkJob({ repo: "rfcclub/anima", issue: 7, digest: "abcdef123456", authorMeshId: WORK.authorMeshId, now: 1_000 });
    expect(job).toMatchObject({
      type: "start-work",
      target: { repo: "rfcclub/anima", kind: "issue", number: 7 },
      slots: 1,
      eligible: [WORK.authorMeshId],
      priority: -10,
      expiresAt: 1_000 + 86_400_000,
      idempotencyKey: "work:rfcclub/anima#7:abcdef123456",
    });
    expect(String(job.workRef)).toMatch(/^w[0-9a-f]{10}\.abcdef123456$/);
  });
});

describe("dispatchApprovedIssues", () => {
  test("enqueues one job for an approved issue with no active work", async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const logs = logLines();
    const count = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [workRecord({ issue: 99 })] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-1", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "body")]),
      log: (level, message, fields) => logs.push({ level, message, fields }),
      now: () => 1_000,
    });
    expect(count).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ type: "start-work", target: { repo: "rfcclub/anima", kind: "issue", number: 7 } });
    expect(logs.some((line) => line.message === "issue dispatched")).toBe(true);
  });

  test("skips an issue whose work is still active", async () => {
    const enqueued: unknown[] = [];
    const count = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [workRecord({ issue: 7, state: "in-review" })] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-1", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "body")]),
      log: () => {},
    });
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("skips a blocked work until the approval content changes", async () => {
    const enqueued: unknown[] = [];
    const body = "blocked body";
    const count = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [workRecord({ issue: 7, state: "blocked", approvedDigest: issueDigest(body) })] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-1", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, body)]),
      log: () => {},
    });
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);

    const changed = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [workRecord({ issue: 7, state: "blocked", approvedDigest: issueDigest(body) })] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-2", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "different body")]),
      log: () => {},
    });
    expect(changed).toBe(1);
  });

  test("an accepted work for the same approval is not dispatched again", async () => {
    const enqueued: unknown[] = [];
    const body = "accepted body";
    const count = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [workRecord({ issue: 7, state: "accepted", approvedDigest: issueDigest(body) })] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-1", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, body)]),
      log: () => {},
    });
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  describe("a start job that expired without running (#643)", () => {
    const body = "orphan body";
    const digest = issueDigest(body);
    function fakeStore(works: WorkRecord[], events: Array<{ kind: string }> = []) {
      const recorded: Array<{ workId: string; kind: string; detail: unknown }> = [];
      const states: Array<{ workId: string; state: string; reason?: string }> = [];
      return {
        recorded, states,
        store: {
          listWorks: () => works,
          listEvents: () => events as never,
          appendEvent: (workId: string, kind: string, detail: unknown) => { recorded.push({ workId, kind, detail }); },
          setState: (workId: string, state: string, reason?: string) => { states.push({ workId, state, reason }); },
        },
      };
    }
    const queuedWork = (over: Partial<WorkRecord> = {}) => workRecord({
      issue: 7, state: "queued", workId: "w1111111111", approvedDigest: digest, sessionsUsed: 0, ...over,
    });

    test("a queued work whose start job expired gets a fresh job for the same work", async () => {
      const keys: string[] = [];
      const refs: string[] = [];
      const { store, recorded } = fakeStore([queuedWork()]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => {
          keys.push(String(input.idempotencyKey)); refs.push(String(input.workRef));
          return (String(input.idempotencyKey).endsWith(":r1")
            ? { id: "new-job", state: "queued", createdAt: 1_000 }
            : { id: "old-job", state: "expired", createdAt: 0 }) as never;
        } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toEqual([`work:rfcclub/anima#7:${digest}`, `work:rfcclub/anima#7:${digest}:r1`]);
      expect(refs[1]).toBe(`w1111111111.${digest}`);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ workId: "w1111111111", kind: "start-job-redispatched" });
    });

    test("a queued work whose start job is still live is left alone", async () => {
      const keys: string[] = [];
      const { store, recorded, states } = fakeStore([queuedWork()]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => { keys.push(String(input.idempotencyKey)); return { id: "live", state: "queued", createdAt: 0 } as never; } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toHaveLength(1);
      expect(recorded).toHaveLength(0);
      expect(states).toHaveLength(0);
    });

    test("after the configured number of re-dispatches the work is blocked with the cause", async () => {
      const keys: string[] = [];
      const { store, states } = fakeStore([queuedWork()], [{ kind: "start-job-redispatched" }, { kind: "start-job-redispatched" }]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => { keys.push(String(input.idempotencyKey)); return { id: "old", state: "expired", createdAt: 0 } as never; } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toEqual([`work:rfcclub/anima#7:${digest}:r2`]);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ workId: "w1111111111", state: "blocked" });
      expect(states[0].reason).toContain("expired");
    });

    test("a never-started work for older issue text is superseded and the edited issue is dispatched", async () => {
      const enqueued: Array<Record<string, unknown>> = [];
      const { store, states } = fakeStore([queuedWork({ approvedDigest: "0123456789ab" })]);
      const count = await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => { enqueued.push(input); return { id: "job-new", state: "queued", createdAt: 1_000 } as never; } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(states).toEqual([{ workId: "w1111111111", state: "blocked", reason: expect.stringContaining("superseded") }]);
      expect(count).toBe(1);
      expect(enqueued[0]).toMatchObject({ type: "start-work", idempotencyKey: `work:rfcclub/anima#7:${digest}` });
    });

    test("an approval whose first job expired before any work existed gets the next attempt, bounded", async () => {
      const keys: string[] = [];
      const { store } = fakeStore([]);
      const count = await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => {
          keys.push(String(input.idempotencyKey));
          return (String(input.idempotencyKey).endsWith(":r1")
            ? { id: "new-job", state: "queued", createdAt: 1_000 }
            : { id: "old-job", state: "expired", createdAt: 0 }) as never;
        } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toEqual([`work:rfcclub/anima#7:${digest}`, `work:rfcclub/anima#7:${digest}:r1`]);
      expect(count).toBe(1);

      const exhausted: string[] = [];
      const none = await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => { exhausted.push(String(input.idempotencyKey)); return { id: "dead", state: "expired", createdAt: 0 } as never; } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(exhausted).toHaveLength(3);
      expect(none).toBe(0);
    });

    test("an expired job that still has an active claim is not re-dispatched, nor blocked (#643)", async () => {
      const keys: string[] = [];
      const { store, recorded, states } = fakeStore([queuedWork()], [{ kind: "start-job-redispatched" }, { kind: "start-job-redispatched" }]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: {
          getJob: async () => ({ claims: [{ id: "c", state: "active" }] }) as never,
          enqueue: async (input: Record<string, unknown>) => { keys.push(String(input.idempotencyKey)); return { id: "old", state: "expired", createdAt: 0 } as never; },
        },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toHaveLength(1);
      expect(recorded).toHaveLength(0);
      expect(states).toHaveLength(0);
    });

    test("when the claim cannot be read the expired job is left alone (fail closed)", async () => {
      const keys: string[] = [];
      const { store, recorded } = fakeStore([queuedWork()]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { enqueue: async (input: Record<string, unknown>) => { keys.push(String(input.idempotencyKey)); return { id: "old", state: "expired", createdAt: 0 } as never; } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toHaveLength(1);
      expect(recorded).toHaveLength(0);
    });

    test("a recovery job counts toward maxPerPoll", async () => {
      const keys: string[] = [];
      const a = queuedWork({ issue: 7, workId: "w1111111111" });
      const b = queuedWork({ issue: 8, workId: "w2222222222" });
      const { store } = fakeStore([a, b]);
      const count = await dispatchApprovedIssues({
        config: { ...CONFIG, maxPerPoll: 1 }, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => {
          keys.push(String(input.idempotencyKey));
          return (String(input.idempotencyKey).endsWith(":r1")
            ? { id: "new-job", state: "queued", createdAt: 1_000 }
            : { id: "old-job", state: "expired", createdAt: 0 }) as never;
        } },
        gh: async () => JSON.stringify([issue(7, body), issue(8, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(count).toBe(1);
      expect(keys.filter((k) => k.endsWith(":r1"))).toHaveLength(1);
    });

    test("a queued job whose only eligible worker already holds a failed claim is dead and gets the next attempt (#643)", async () => {
      const keys: string[] = [];
      const { store, recorded } = fakeStore([queuedWork()]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: {
          getJob: async () => ({ claims: [{ worker: WORK.authorMeshId, state: "failed" }], eligible: [WORK.authorMeshId] }) as never,
          enqueue: async (input: Record<string, unknown>) => {
            keys.push(String(input.idempotencyKey));
            return (String(input.idempotencyKey).endsWith(":r1")
              ? { id: "new-job", state: "queued", createdAt: 1_000 }
              : { id: "stuck-job", state: "queued", createdAt: 0 }) as never;
          },
        },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toEqual([`work:rfcclub/anima#7:${digest}`, `work:rfcclub/anima#7:${digest}:r1`]);
      expect(recorded).toHaveLength(1);
    });

    test("a queued job nobody has claimed yet is alive and left alone", async () => {
      const keys: string[] = [];
      const { store, recorded } = fakeStore([queuedWork()]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: {
          getJob: async () => ({ claims: [], eligible: [WORK.authorMeshId] }) as never,
          enqueue: async (input: Record<string, unknown>) => { keys.push(String(input.idempotencyKey)); return { id: "live", state: "queued", createdAt: 0 } as never; },
        },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(keys).toHaveLength(1);
      expect(recorded).toHaveLength(0);
    });

    test("a work that changed while the job was being read is not touched (#643)", async () => {
      const works = [queuedWork()];
      const { store, recorded, states } = fakeStore(works);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: {
          getJob: async () => { works[0] = queuedWork({ state: "running", sessionsUsed: 1 }); return { claims: [] } as never; },
          enqueue: async () => ({ id: "old", state: "expired", createdAt: 0 }) as never,
        },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(recorded).toHaveLength(0);
      expect(states).toHaveLength(0);
    });

    test("a failing gateway does not use the re-dispatch attempts up (#643)", async () => {
      const { store, recorded } = fakeStore([queuedWork()]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => ({ claims: [] }) as never, enqueue: async (input: Record<string, unknown>) => {
          if (String(input.idempotencyKey).endsWith(":r1")) throw new Error("gateway unavailable");
          return { id: "old", state: "expired", createdAt: 0 } as never;
        } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(recorded).toHaveLength(0);
    });

    test("a getJob failure on a healthy queued job does not hide the dispatch", async () => {
      const { store } = fakeStore([]);
      const count = await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { getJob: async () => { throw new Error("gateway read failed"); }, enqueue: async () => ({ id: "fresh", state: "queued", createdAt: 1_000 }) as never },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(count).toBe(1);
    });

    test("a work that already ran is never re-dispatched by this path", async () => {
      const enqueued: unknown[] = [];
      const { store } = fakeStore([queuedWork({ state: "running", sessionsUsed: 1 })]);
      await dispatchApprovedIssues({
        config: CONFIG, work: WORK, store,
        mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "x", state: "queued", createdAt: 0 } as never; } },
        gh: async () => JSON.stringify([issue(7, body)]),
        log: () => {}, now: () => 1_000,
      });
      expect(enqueued).toHaveLength(0);
    });
  });

  test("skips issues created before notBefore", async () => {
    const enqueued: Array<Record<string, any>> = [];
    const count = await dispatchApprovedIssues({
      config: { ...CONFIG, notBefore: Date.parse("2026-11-01T12:00:00Z") }, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input as Record<string, any>); return { id: "job-1", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([
        issue(7, "old", undefined, "2026-11-01T10:00:00Z"),
        issue(8, "new", undefined, "2026-11-01T13:00:00Z"),
      ]),
      log: () => {},
    });
    expect(count).toBe(1);
    expect(enqueued.map((job) => (job.target as { number: number }).number)).toEqual([8]);
  });

  test("caps the number of start-work jobs in one poll", async () => {
    const enqueued: unknown[] = [];
    const count = await dispatchApprovedIssues({
      config: { ...CONFIG, maxPerPoll: 2 }, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([1, 2, 3, 4, 5].map((n) => issue(n, `body ${n}`))),
      log: () => {},
    });
    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
  });

  test("ignores an issue without the approval label", async () => {
    const enqueued: unknown[] = [];
    await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-1", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "body", ["orca:intent"])]),
      log: () => {},
    });
    expect(enqueued).toHaveLength(0);
  });

  test("a failing gh poll is logged and does not throw", async () => {
    const logs = logLines();
    const count = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async () => ({ id: "job-1", state: "queued", createdAt: Date.now() } as never) },
      gh: async () => { throw new Error("gh failed"); },
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });
    expect(count).toBe(0);
    expect(logs.some((line) => line.message === "issue dispatch poll failed")).toBe(true);
  });

  test("an enqueue failure is logged and does not hide other issues", async () => {
    const logs = logLines();
    let calls = 0;
    const count = await dispatchApprovedIssues({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async () => { calls += 1; if (calls === 1) throw new Error("gateway down"); return { id: "job-2", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "a"), issue(8, "b")]),
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });
    expect(count).toBe(1);
    expect(logs.some((line) => line.message === "issue dispatch enqueue failed")).toBe(true);
  });
});

describe("intent review dispatch", () => {
  test("buildIntentReviewJob is one job per revision for the independent reviewers only", () => {
    const job = buildIntentReviewJob({
      repo: "rfcclub/anima", issue: 7, revision: "abcdef123456",
      reviewerMeshIds: ["cleo@anima", "pia@anima"], authorMeshId: WORK.authorMeshId, now: 1_000,
    });
    expect(job).toMatchObject({
      type: "review-intent",
      target: { repo: "rfcclub/anima", kind: "issue", number: 7 },
      slots: 1,
      eligible: ["cleo@anima", "pia@anima"],
      excluded: [WORK.authorMeshId],
      idempotencyKey: "intent:rfcclub/anima#7@abcdef123456",
    });
    expect(intentRevision("title", "body")).toBe(
      createHash("sha256").update(JSON.stringify(["title", "body"])).digest("hex").slice(0, 12),
    );
  });

  test("enqueues one review-intent job for an unapproved intent", async () => {
    const enqueued: Array<Record<string, any>> = [];
    const count = await dispatchIntentReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input as Record<string, any>); return { id: "job-i", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "body", ["orca:intent"])]),
      log: () => {},
    });
    expect(count).toBe(1);
    expect(enqueued[0]).toMatchObject({ type: "review-intent", target: { repo: "rfcclub/anima", kind: "issue", number: 7 } });
  });

  test("logs each newly created revision once, even when polls are close together", async () => {
    const logs = logLines();
    const jobs = new Map<string, { id: string; state: "queued"; createdAt: number }>();
    let now = 100_000;
    let body = "first";
    const poll = () => dispatchIntentReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] }, now: () => now,
      mesh: { enqueue: async (input) => {
        const key = String(input.idempotencyKey);
        const job = jobs.get(key) ?? { id: `job-${jobs.size + 1}`, state: "queued", createdAt: now };
        jobs.set(key, job);
        return job as never;
      } },
      gh: async () => JSON.stringify([issue(7, body, ["orca:intent"])]),
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });
    expect(await poll()).toBe(1);
    now += 1_000;
    expect(await poll()).toBe(1); // Preserve the count's existing clock skew allowance.
    now += 1_000;
    body = "updated";
    expect(await poll()).toBe(1);
    expect(logs.filter((line) => line.message === "intent review dispatched").map((line) => line.fields?.revision))
      .toEqual([intentRevision("issue 7", "first"), intentRevision("issue 7", "updated")]);
  });

  test("still logs each enqueue failure", async () => {
    const logs = logLines();
    const poll = () => dispatchIntentReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] },
      mesh: { enqueue: async () => { throw new Error("queue unavailable"); } },
      gh: async () => JSON.stringify([issue(7, "body", ["orca:intent"])]),
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });
    expect(await poll()).toBe(0);
    expect(await poll()).toBe(0);
    expect(logs).toEqual(Array.from({ length: 2 }, () => ({
      level: "error", message: "intent review enqueue failed",
      fields: { repo: CONFIG.repos[0], issue: 7, error: "queue unavailable" },
    })));
  });

  test("an intent authored by a configured reviewer excludes that reviewer", async () => {
    const enqueued: Array<Record<string, any>> = [];
    const authored = { ...issue(7, "body", ["orca:intent"]), author: { login: "cleo-gotako[bot]" } };
    await dispatchIntentReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input as Record<string, any>); return { id: "job-i", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([authored]),
      log: () => {},
    });
    expect(enqueued[0]!.excluded).toEqual(["finn-anima-cab0dbd4@host-1", "cleo-anima-cab0dbd4@host-1"]);
  });

  test("does not re-review an already approved intent", async () => {
    const enqueued: unknown[] = [];
    const count = await dispatchIntentReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-i", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([issue(7, "body", ["orca:intent", "orca:approved"])]),
      log: () => {},
    });
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("caps intent-review jobs per poll and honors the cutoff", async () => {
    const enqueued: unknown[] = [];
    const count = await dispatchIntentReviews({
      config: { ...CONFIG, maxIntentPerPoll: 2, notBefore: Date.parse("2026-11-01T12:00:00Z") }, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-i", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([
        issue(1, "old", ["orca:intent"], "2026-11-01T10:00:00Z"),
        issue(2, "a", ["orca:intent"], "2026-11-01T13:00:00Z"),
        issue(3, "b", ["orca:intent"], "2026-11-01T13:00:00Z"),
        issue(4, "c", ["orca:intent"], "2026-11-01T13:00:00Z"),
      ]),
      log: () => {},
    });
    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
  });
});

describe("pull request review dispatch", () => {
  const HEAD = "c".repeat(40);
  function pr(number: number, over: Record<string, unknown> = {}) {
    return {
      number, headRefOid: HEAD, isDraft: false, createdAt: "2026-11-01T20:30:00Z",
      author: { login: "rfcclub" }, ...over,
    };
  }

  test("enqueues one review job per open non-draft PR for the independent reviewers", async () => {
    const enqueued: Array<Record<string, any>> = [];
    const count = await dispatchPrReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input as Record<string, any>); return { id: "job-r", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([pr(230)]),
      log: () => {},
    });
    expect(count).toBe(1);
    expect(enqueued[0]).toMatchObject({
      type: "review",
      target: { repo: "rfcclub/anima", kind: "pr", number: 230, headSha: HEAD },
      idempotencyKey: `review:rfcclub/anima#230@${HEAD}`,
    });
    expect(enqueued[0]!.eligible).toEqual(["cleo-anima-cab0dbd4@host-1"]);
  });

  test("a PR authored by a configured reviewer excludes that reviewer", async () => {
    const enqueued: Array<Record<string, any>> = [];
    await dispatchPrReviews({
      config: CONFIG, work: WORK, store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input as Record<string, any>); return { id: "job-r", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([pr(230, { author: { login: "cleo-gotako[bot]" } })]),
      log: () => {},
    });
    expect(enqueued[0]!.excluded).toEqual(["finn-anima-cab0dbd4@host-1", "cleo-anima-cab0dbd4@host-1"]);
  });

  test("draft PRs and PRs tracked by a work are skipped", async () => {
    const enqueued: unknown[] = [];
    const count = await dispatchPrReviews({
      config: CONFIG, work: WORK,
      store: { listWorks: () => [workRecord({ issue: 231, prNumber: 232, state: "in-review" })] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-r", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([pr(230, { isDraft: true }), pr(232)]),
      log: () => {},
    });
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("honors the cutoff and the per-poll cap", async () => {
    const enqueued: unknown[] = [];
    const count = await dispatchPrReviews({
      config: { ...CONFIG, maxReviewPerPoll: 2, notBefore: Date.parse("2026-11-01T20:00:00Z") }, work: WORK,
      store: { listWorks: () => [] },
      mesh: { enqueue: async (input) => { enqueued.push(input); return { id: "job-r", state: "queued", createdAt: Date.now() } as never; } },
      gh: async () => JSON.stringify([
        pr(1, { createdAt: "2026-11-01T10:00:00Z" }),
        pr(2), pr(3), pr(4),
      ]),
      log: () => {},
    });
    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
  });
});
