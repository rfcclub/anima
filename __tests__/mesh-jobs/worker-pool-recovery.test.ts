import { describe, expect, test } from "bun:test";
import { dispatchApprovedIssues, issueDigest, type PipelineConfig } from "../../src/mesh-jobs/pipeline";
import type { MeshJobsWorkConfig } from "../../src/mesh-jobs/config";
import type { WorkRecord } from "../../src/work/store";

const body = "approved work";
const digest = issueDigest(body);
const config: PipelineConfig = {
  repos: ["rfcclub/anima"], reviewRepos: ["rfcclub/anima"], intervalMs: 300_000,
  issueLabel: "orca:approved", intentLabel: "orca:intent", notBefore: 0,
  maxPerPoll: 3, maxIntentPerPoll: 2, maxReviewPerPoll: 3,
};
const work: MeshJobsWorkConfig = {
  author: "finn", authorActor: "finn-gotako[bot]", authorMeshId: "finn@anima",
  enqueuer: "finn", base: "master",
  extraAuthors: [{ agent: "jade", meshId: "jade@anima" }],
  reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }],
  releaseBackoffMs: 30_000, reconcileIntervalMs: 60_000,
  perToolCallMs: 120_000, cloneUrl: "/tmp/{repo}",
};

function queued(author: string): WorkRecord {
  return {
    workId: "w1111111111", repo: "rfcclub/anima", issue: 7, approvedDigest: digest,
    author, provider: "agnes", model: "agnes-3.0-flash", state: "queued",
    generation: 1, branch: "work/7-w1111111111", root: "/tmp/work", caps: {} as WorkRecord["caps"],
    sessionsUsed: 0, iterationsUsed: 0, execMsUsed: 0, blockedReason: null,
    prNumber: null, prHead: null, prUrl: null, startJobId: null,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

async function run(record?: WorkRecord, old?: {
  state: "queued" | "expired";
  eligible: string[];
  claims: Array<{ worker: string; state: "active" | "failed" }>;
}) {
  const inputs: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const count = await dispatchApprovedIssues({
    config, work,
    store: {
      listWorks: () => record ? [record] : [],
      listEvents: () => [],
      appendEvent: (_id, kind) => { events.push(kind); },
      setState: () => { throw new Error("unexpected state change"); },
    },
    mesh: {
      getJob: async () => ({ eligible: old?.eligible ?? [], claims: old?.claims ?? [] }) as never,
      enqueue: async (input) => {
        inputs.push(input);
        return (String(input.idempotencyKey).endsWith(":r1")
          ? { id: "new-job", state: "queued", createdAt: 1_000 }
          : { id: "old-job", state: old?.state ?? "expired", createdAt: 0 }) as never;
      },
    },
    gh: async () => JSON.stringify([{
      number: 7, title: "issue 7", body, createdAt: "2026-11-01T00:00:00Z",
      labels: [{ name: "orca:approved" }],
    }]),
    log: () => {}, now: () => 1_000,
  });
  return { count, events, inputs };
}

describe("worker pool and expired start jobs", () => {
  test("a replacement before a work exists keeps every configured author eligible", async () => {
    const { count, inputs } = await run();
    expect(count).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.eligible).toEqual(["finn@anima", "jade@anima"]);
  });

  test("a replacement for an existing queued work targets its pinned author", async () => {
    const { count, events, inputs } = await run(queued("jade"));
    expect(count).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.eligible).toEqual(["jade@anima"]);
    expect(events).toEqual(["start-job-redispatched"]);
  });

  test("an existing work with no matching author identity is not redispatched", async () => {
    const { count, events, inputs } = await run(queued("unknown"));
    expect(count).toBe(0);
    expect(inputs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("a failed pinned author cannot be rescued by other eligible authors", async () => {
    const { count, inputs } = await run(queued("jade"), {
      state: "queued", eligible: ["finn@anima", "jade@anima"],
      claims: [{ worker: "jade@anima", state: "failed" }],
    });
    expect(count).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.eligible).toEqual(["jade@anima"]);
  });

  test("an active claim prevents redispatch even after the pinned author failed", async () => {
    const { count, inputs } = await run(queued("jade"), {
      state: "queued", eligible: ["finn@anima", "jade@anima"],
      claims: [
        { worker: "jade@anima", state: "failed" },
        { worker: "finn@anima", state: "active" },
      ],
    });
    expect(count).toBe(0);
    expect(inputs).toHaveLength(1);
  });
});
