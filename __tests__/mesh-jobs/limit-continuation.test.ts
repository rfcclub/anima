import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchApprovedIssues, issueDigest, type PipelineConfig } from "../../src/mesh-jobs/pipeline";
import type { MeshJobsWorkConfig } from "../../src/mesh-jobs/config";
import { loadWorkConfig } from "../../src/work/config";
import { WorkStore } from "../../src/work/store";

const body = "approved issue";
const digest = issueDigest(body);
const config: PipelineConfig = { repos: ["example/repo"], reviewRepos: ["example/repo"], intervalMs: 300_000,
  issueLabel: "orca:approved", intentLabel: "orca:intent", notBefore: 0, maxPerPoll: 1, maxIntentPerPoll: 1, maxReviewPerPoll: 1 };
const workConfig = { author: "worker", authorMeshId: "worker@mesh", reviewers: [] } as unknown as MeshJobsWorkConfig;
let root: string;
let store: WorkStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "continuation-dispatch-")); store = WorkStore.open(":memory:", { rootBase: root }); });
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function stopped(issue = 7, blocked = false, trusted = true, author = "worker") {
  const work = store.createWork({ repo: "example/repo", issue, approvedDigest: digest,
    config: loadWorkConfig({ author, caps: { maxSessions: 1, workWallMs: 1000, sessionWallMs: 1000 } }) }).work;
  const reserved = store.reserveSession(work.workId, { jobId: `old-${issue}`, claimId: `claim-${issue}` });
  if (!reserved.ok) throw new Error(reserved.reason);
  store.closeSession(reserved.session.sessionId, { iterations: 1, execMs: 1000, stopCause: "deadline" });
  store.recordStop({ sessionId: reserved.session.sessionId, workId: work.workId, adapter: "loop", stopCause: "deadline",
    cessation: "proven", cessationCheck: null, head: "a".repeat(40), status: "", evidence: "unavailable", trusted, interrupted: false });
  mkdirSync(work.root, { recursive: true });
  if (blocked) store.setState(work.workId, "blocked", "execution time limit reached; publish fallback declined: no commit ahead");
  return store.getWork(work.workId)!;
}

function gateway(oldState: "expired" | "queued", active = false) {
  const enqueued: Array<Record<string, unknown>> = [];
  const known = new Map<string, { id: string; state: string; createdAt: number }>();
  return { enqueued, mesh: {
    async getJob(id: string) { return { id, state: id.startsWith("old-") ? oldState : "queued", claims: active ? [{ state: "active" }] : [], eligible: ["worker@mesh"] } as never; },
    async enqueue(input: Record<string, unknown>) {
      enqueued.push(input);
      const key = String(input.idempotencyKey);
      if (!known.has(key)) known.set(key, { id: `new-${known.size + 1}`, state: "queued", createdAt: 1000 });
      return known.get(key)! as never;
    },
  } };
}
const gh = async (args: string[]) => args[0] === "issue"
  ? JSON.stringify([{ number: 7, body, labels: [{ name: "orca:approved" }], createdAt: "2026-11-01T00:00:00Z" }])
  : JSON.stringify({ data: { repository: { issue: { state: "OPEN", body, labels: { nodes: [{ name: "orca:approved" }], pageInfo: { hasNextPage: false } }, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } });

async function dispatch(mesh: ReturnType<typeof gateway>["mesh"], ghRunner = gh) {
  return dispatchApprovedIssues({ config, work: workConfig, store, mesh, gh: ghRunner, log: () => {}, now: () => 1000 });
}

describe("Slice 1 checkpointed work dispatch", () => {
  for (const blocked of [false, true]) {
    test(`a ${blocked ? "limit-blocked" : "checkpointed"} work is recovered for its pinned extra author`, async () => {
      const work = stopped(7, blocked, true, "vesta");
      const { mesh, enqueued } = gateway("expired");
      const multiAuthor = { ...workConfig, extraAuthors: [{ agent: "vesta", meshId: "vesta@mesh" }] };
      expect(await dispatchApprovedIssues({ config, work: multiAuthor, store, mesh, gh, log: () => {}, now: () => 1000 })).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ workRef: `${work.workId}.${digest}`, eligible: ["vesta@mesh"] });
    });
  }

  test("a failed claim by the pinned author is recovered even if another eligible author has not failed", async () => {
    stopped(7, false, true, "vesta");
    const { mesh, enqueued } = gateway("queued");
    mesh.getJob = async (id: string) => ({ id, state: "queued", claims: [{ state: "failed", worker: "vesta@mesh" }],
      eligible: ["worker@mesh", "vesta@mesh"] }) as never;
    const multiAuthor = { ...workConfig, extraAuthors: [{ agent: "vesta", meshId: "vesta@mesh" }] };
    expect(await dispatchApprovedIssues({ config, work: multiAuthor, store, mesh, gh, log: () => {}, now: () => 1000 })).toBe(1);
    expect(enqueued[0]?.eligible).toEqual(["vesta@mesh"]);
  });

  test("a failed claim by another author does not replace the pinned author's queued job", async () => {
    stopped(7, false, true, "vesta");
    const { mesh, enqueued } = gateway("queued");
    mesh.getJob = async (id: string) => ({ id, state: "queued", claims: [{ state: "failed", worker: "worker@mesh" }],
      eligible: ["worker@mesh", "vesta@mesh"] }) as never;
    const multiAuthor = { ...workConfig, extraAuthors: [{ agent: "vesta", meshId: "vesta@mesh" }] };
    expect(await dispatchApprovedIssues({ config, work: multiAuthor, store, mesh, gh, log: () => {}, now: () => 1000 })).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("a limit-blocked work with an unconfigured author is not continued or enqueued", async () => {
    const work = stopped(7, true, true, "vesta");
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.getWork(work.workId)?.state).toBe("blocked");
    expect(store.listEvents(work.workId).some((event) => event.kind === "limit-continuation")).toBe(false);
  });

  test("Slice 1 a dead start job gets one replacement for the same work", async () => {
    const work = stopped();
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.workRef).toBe(`${work.workId}.${digest}`);
    expect(store.listEvents(work.workId).filter((event) => event.kind === "start-job-redispatched")).toHaveLength(1);
    expect(await dispatch(mesh)).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  test("Slice 1 a live claim is never duplicated", async () => {
    stopped();
    const { mesh, enqueued } = gateway("expired", true);
    expect(await dispatch(mesh)).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("Slice 1 a qualifying blocked work continues and dispatches", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(1);
    expect(store.getWork(work.workId)).toMatchObject({ state: "checkpointed", caps: { maxSessions: 2 } });
    expect(enqueued).toHaveLength(1);
  });

  test("Slice 1 the blocked backlog waits while two works are already in flight", async () => {
    const blocked = stopped(7, true);
    for (const issue of [20, 21]) {
      const other = store.createWork({ repo: "example/repo", issue, approvedDigest: digest, config: loadWorkConfig({}) }).work;
      expect(other.state).toBe("queued");
    }
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(0);
    expect(store.getWork(blocked.workId)?.state).toBe("blocked");
    expect(enqueued).toHaveLength(0);
  });

  test("Slice 1 the blocked backlog continues while fewer than two works are in flight", async () => {
    const blocked = stopped(7, true);
    store.createWork({ repo: "example/repo", issue: 20, approvedDigest: digest, config: loadWorkConfig({}) });
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(1);
    expect(store.getWork(blocked.workId)?.state).toBe("checkpointed");
    expect(enqueued).toHaveLength(1);
  });

  test("Slice 1 a checkpoint retry rechecks the issue before enqueueing", async () => {
    const work = stopped(7);
    const { mesh, enqueued } = gateway("expired");
    const merged = async (args: string[]) => args[0] === "issue" ? gh(args) : JSON.stringify({ data: { repository: { issue: {
      state: "OPEN", body, labels: { nodes: [{ name: "orca:approved" }], pageInfo: { hasNextPage: false } },
      closedByPullRequestsReferences: { nodes: [{ merged: true }], pageInfo: { hasNextPage: false } },
    } } } });
    expect(await dispatch(mesh, merged)).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.getWork(work.workId)?.state).toBe("checkpointed");
  });

  test("Slice 1 stale checkpoints outside the poll do not hold the backlog slots", async () => {
    store.close();
    let clock = Date.parse("2026-11-01T00:00:00Z");
    store = WorkStore.open(":memory:", { rootBase: root, now: () => clock });
    stopped(30);
    stopped(31);
    clock += 3 * 24 * 3_600_000;
    const blocked = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatchApprovedIssues({ config, work: workConfig, store, mesh, gh, log: () => {}, now: () => clock })).toBe(1);
    expect(store.getWork(blocked.workId)?.state).toBe("checkpointed");
    expect(enqueued).toHaveLength(1);
  });

  test("Slice 1 a blocked work that cannot continue makes no remote call", async () => {
    const work = stopped(7, true);
    store.setState(work.workId, "blocked", "worker reported blocked: needs a decision");
    const { mesh, enqueued } = gateway("expired");
    let reads = 0;
    mesh.getJob = async (id: string) => { reads += 1; return { id, state: "expired", claims: [], eligible: ["worker@mesh"] } as never; };
    let graphql = 0;
    const counting = async (args: string[]) => { if (args[0] !== "issue") graphql += 1; return gh(args); };
    expect(await dispatch(mesh, counting)).toBe(0);
    expect(reads).toBe(0);
    expect(graphql).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("Slice 1 a failed claim on a queued start job is recovered", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("queued");
    mesh.getJob = async (id: string) => ({ id, state: "queued", claims: [{ state: "failed", worker: "worker@mesh" }],
      eligible: ["worker@mesh"] }) as never;
    expect(await dispatch(mesh)).toBe(1);
    expect(store.getWork(work.workId)?.state).toBe("checkpointed");
    expect(enqueued).toHaveLength(1);
  });

  test("Slice 1 a merged closing PR prevents blocked-work recovery", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    const merged = async (args: string[]) => args[0] === "issue" ? gh(args) : JSON.stringify({ data: { repository: { issue: {
      state: "OPEN", body, labels: { nodes: [{ name: "orca:approved" }], pageInfo: { hasNextPage: false } },
      closedByPullRequestsReferences: { nodes: [{ merged: true }], pageInfo: { hasNextPage: false } },
    } } } });
    expect(await dispatch(mesh, merged)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("blocked");
    expect(enqueued).toHaveLength(0);
  });

  test("Slice 1 an unreadable current job is not replaced", async () => {
    const work = stopped();
    const { mesh, enqueued } = gateway("expired");
    mesh.getJob = async () => { throw new Error("gateway unavailable"); };
    expect(await dispatch(mesh)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("checkpointed");
    expect(enqueued).toHaveLength(0);
  });

  test("Slice 1 the poll stops after one checkpoint recovery", async () => {
    const first = stopped(7);
    const second = stopped(8);
    const { mesh, enqueued } = gateway("expired");
    const issues = async (args: string[]) => args[0] === "issue" ? JSON.stringify([7, 8].map((number) => ({
      number, body, labels: [{ name: "orca:approved" }], createdAt: "2026-11-01T00:00:00Z",
    }))) : gh(args);
    expect(await dispatch(mesh, issues)).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.workRef).toBe(`${first.workId}.${digest}`);
    expect(store.listEvents(second.workId).some((event) => event.kind === "start-job-redispatched")).toBe(false);
  });

  test("Slice 1 a job that becomes reported during the dead-job check is not replaced", async () => {
    const work = stopped();
    const { mesh, enqueued } = gateway("queued");
    let reads = 0;
    mesh.getJob = async (id: string) => ({ id, state: ++reads === 1 ? "queued" : "reported",
      claims: [{ state: reads === 1 ? "failed" : "reported", worker: "worker@mesh" }], eligible: ["worker@mesh"] }) as never;
    expect(await dispatch(mesh)).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.getWork(work.workId)?.state).toBe("checkpointed");
  });

  test("Slice 1 a missing existing work root is not recreated or dispatched", async () => {
    const work = stopped();
    rmSync(work.root, { recursive: true, force: true });
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("Slice 1 continuation counts against the poll limit even when enqueue fails", async () => {
    const first = stopped(7, true);
    const second = stopped(8, true);
    const { mesh } = gateway("expired");
    mesh.enqueue = async () => { throw new Error("gateway unavailable"); };
    const issues = async (args: string[]) => args[0] === "issue" ? JSON.stringify([7, 8].map((number) => ({
      number, body, labels: [{ name: "orca:approved" }], createdAt: "2026-11-01T00:00:00Z",
    }))) : gh(args);
    expect(await dispatch(mesh, issues)).toBe(1);
    expect(store.getWork(first.workId)?.state).toBe("checkpointed");
    expect(store.getWork(second.workId)?.state).toBe("blocked");
  });

  test("Slice 1 a continuation resets old redispatch attempts", async () => {
    const work = stopped(7, true);
    store.appendEvent(work.workId, "start-job-redispatched", { attempt: 1, jobId: "old-7" });
    store.appendEvent(work.workId, "start-job-redispatched", { attempt: 2, jobId: "old-7" });
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(String(enqueued[0]!.idempotencyKey)).toMatch(/:c[0-9]+:r1$/);
  });

  test("Slice 1 an exhausted redispatch budget blocks a dead checkpointed work", async () => {
    const work = stopped();
    store.appendEvent(work.workId, "start-job-redispatched", { attempt: 1, jobId: "old-7" });
    const { mesh, enqueued } = gateway("expired");
    const count = await dispatchApprovedIssues({ config: { ...config, maxStartRedispatch: 1 }, work: workConfig,
      store, mesh, gh, log: () => {}, now: () => 1000 });
    expect(count).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.getWork(work.workId)?.blockedReason).toContain("start job expired");
  });

  test("Slice 1 a state change while reading a dead job prevents dispatch", async () => {
    const work = stopped();
    const { mesh, enqueued } = gateway("expired");
    const read = mesh.getJob;
    mesh.getJob = async (id: string) => {
      store.setState(work.workId, "blocked", "approval changed");
      return read(id);
    };
    expect(await dispatch(mesh)).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.getWork(work.workId)?.blockedReason).toBe("approval changed");
  });

  test("Slice 1 a missing approval or unreadable issue check leaves blocked work unchanged", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    const unavailable = async (args: string[]) => { if (args[0] === "issue") return gh(args); throw new Error("unavailable"); };
    expect(await dispatch(mesh, unavailable)).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.getWork(work.workId)?.state).toBe("blocked");
    expect(store.listEvents(work.workId).some((event) => event.kind === "limit-continuation")).toBe(false);
  });

  test("Slice 1 each continuation uses a fresh idempotency-key namespace", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(1);
    const firstKey = enqueued[0]!.idempotencyKey;
    const next = store.reserveSession(work.workId, { jobId: "new-1", claimId: "claim-next" });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.reason);
    store.closeSession(next.session.sessionId, { iterations: 1, execMs: 1000, stopCause: "deadline" });
    store.recordStop({ sessionId: next.session.sessionId, workId: work.workId, adapter: "loop", stopCause: "deadline",
      cessation: "proven", cessationCheck: null, head: "a".repeat(40), status: "", evidence: "unavailable", trusted: true, interrupted: false });
    store.setState(work.workId, "blocked", "execution time limit reached; publish fallback declined: no commit ahead");
    mesh.getJob = async (id: string) => ({ id, state: "expired", claims: [], eligible: ["worker@mesh"] }) as never;
    expect(await dispatch(mesh)).toBe(1);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]!.idempotencyKey).not.toBe(firstKey);
    expect(store.listEvents(work.workId).filter((event) => event.kind === "limit-continuation")).toHaveLength(2);
  });

  test("Slice 1 an untrusted blocked stop stays blocked", async () => {
    const work = stopped(7, true, false);
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("blocked");
    expect(enqueued).toHaveLength(0);
  });
});


describe("Backlog label parks an approved issue", () => {
  const ghBacklog = async (args: string[]) => args[0] === "issue"
    ? JSON.stringify([{ number: 7, body, labels: [{ name: "orca:approved" }, { name: "orca:backlog" }], createdAt: "2026-11-01T00:00:00Z" }])
    : JSON.stringify({ data: { repository: { issue: { state: "OPEN", body, labels: { nodes: [{ name: "orca:approved" }, { name: "orca:backlog" }], pageInfo: { hasNextPage: false } }, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } });

  test("a backlog issue with no work is not dispatched", async () => {
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh, ghBacklog)).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(store.listWorks()).toHaveLength(0);
  });

  test("a qualifying blocked work on a backlog issue is not continued", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh, ghBacklog)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("blocked");
    expect(enqueued).toHaveLength(0);
  });

  test("a checkpointed work with a dead start job on a backlog issue is not re-dispatched", async () => {
    const work = stopped();
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh, ghBacklog)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("checkpointed");
    expect(enqueued).toHaveLength(0);
  });
});

describe("Backlog label added between listing and recheck", () => {
  const ghLate = async (args: string[]) => args[0] === "issue"
    ? JSON.stringify([{ number: 7, body, labels: [{ name: "orca:approved" }], createdAt: "2026-11-01T00:00:00Z" }])
    : JSON.stringify({ data: { repository: { issue: { state: "OPEN", body, labels: { nodes: [{ name: "orca:approved" }, { name: "orca:backlog" }], pageInfo: { hasNextPage: false } }, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } });

  test("a blocked work is not continued when only the recheck sees the backlog label", async () => {
    const work = stopped(7, true);
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh, ghLate)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("blocked");
    expect(enqueued).toHaveLength(0);
  });

  test("a checkpointed work is not re-dispatched when only the recheck sees the backlog label", async () => {
    const work = stopped();
    const { mesh, enqueued } = gateway("expired");
    expect(await dispatch(mesh, ghLate)).toBe(0);
    expect(store.getWork(work.workId)?.state).toBe("checkpointed");
    expect(enqueued).toHaveLength(0);
  });
});
