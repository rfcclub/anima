import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeshJobsConfig } from "../../src/mesh-jobs/config";
import { issueDigest12 } from "../../src/work/approval";
import { DEFAULT_CAPS, loadWorkConfig, parseStoredCaps } from "../../src/work/config";
import { buildWorkRuntime } from "../../src/work/runtime";
import { WorkStore } from "../../src/work/store";

const BODY = "Approved test issue";
const WORK_ID = "wabc1234ef0";
let dir: string;
let path: string;
let dbPath: string;
let store: WorkStore;
let iterations: number[];
let deadlines: number[];
const EXPECTED_DEFAULTS = { maxSessions: 3, maxIterationsPerSession: 5, sessionWallMs: 600_000, workWallMs: 1_800_000 };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "caps-runtime-")));
  path = join(dir, "mesh-jobs.json");
  dbPath = join(dir, "work.db");
  store = WorkStore.open(dbPath, { rootBase: join(dir, "works") });
  iterations = [];
  deadlines = [];
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function config(caps?: unknown) {
  const work = {
    enabled: true, author: "finn", authorActor: "finn[bot]", authorMeshId: "finn@mac", enqueuer: "bruno", base: "master",
    reviewers: [{ agent: "cleo", meshId: "cleo@mac", login: "cleo[bot]" }],
    ...(caps !== undefined ? { caps } : {}),
  };
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:1526", workers: [{ agent: "finn" }], work }));
  chmodSync(path, 0o600);
  return loadMeshJobsConfig(path)!.work!;
}

async function start(caps?: unknown, bypassParser = false) {
  const workConfig = bypassParser ? { ...config(), caps } as ReturnType<typeof config> : config(caps);
  const deps = {
    store,
    executor: {
      ready: () => ({ ok: true as const }),
      runSession: async (input: { maxIterations: number; deadlineMs: number }) => {
        iterations.push(input.maxIterations);
        deadlines.push(input.deadlineMs);
        return { stopCause: "max_reached" as const, iterations: input.maxIterations, execMs: 1, cessation: "proven" as const };
      },
    },
    github: { issue: async () => ({ title: "test", body: BODY }) },
    workGithub: { findPullRequest: async () => null, reviews: async () => [] },
    enqueuer: { enqueue: async () => ({ id: "j" }), confirm: async () => {} },
    heartbeatMs: 1000,
    log: () => {},
  };
  const { handler } = buildWorkRuntime(workConfig, deps as never);
  return handler.run({
    worker: "finn",
    claim: { id: `claim-${iterations.length}`, jobId: "job-1" } as never,
    job: { id: "job-1", type: "start-work", target: { repo: "rfcclub/anima", kind: "issue", number: 255 }, workRef: `${WORK_ID}.${issueDigest12(BODY)}` } as never,
    jobs: { heartbeat: async () => ({}) } as never,
  });
}

function storedCaps() {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT caps_json FROM works WHERE work_id = ?").get(WORK_ID) as { caps_json: string };
    return JSON.parse(row.caps_json);
  } finally { db.close(); }
}

describe("work caps (WC)", () => {
  test("runtime forwards caps to a new work even with a pre-parsed config", async () => {
    await expect(start({ maxSessions: 9, maxIterationsPerSession: 40 }, true)).resolves.toEqual({ kind: "release" });
    expect(storedCaps()).toEqual({ ...DEFAULT_CAPS, maxSessions: 9, maxIterationsPerSession: 40 });
    expect(iterations).toEqual([40]);
  });

  test("partial caps reach the work record and session", async () => {
    await expect(start({ maxSessions: 9, maxIterationsPerSession: 40 })).resolves.toEqual({ kind: "release" });
    expect(storedCaps()).toEqual({ ...EXPECTED_DEFAULTS, maxSessions: 9, maxIterationsPerSession: 40 });
    expect(iterations).toEqual([40]);
    expect(deadlines).toEqual([600_000]);
  });

  test("all four caps reach the work record and session", async () => {
    const caps = { maxSessions: 9, maxIterationsPerSession: 40, sessionWallMs: 120_000, workWallMs: 240_000 };
    await expect(start(caps)).resolves.toEqual({ kind: "release" });
    expect(storedCaps()).toEqual(caps);
    expect(iterations).toEqual([40]);
    expect(deadlines).toEqual([120_000]);
  });

  test("omitted caps default and existing work remains pinned", async () => {
    await expect(start()).resolves.toEqual({ kind: "release" });
    expect(DEFAULT_CAPS).toEqual(EXPECTED_DEFAULTS);
    expect(storedCaps()).toEqual(EXPECTED_DEFAULTS);
    await expect(start({ maxSessions: 9, maxIterationsPerSession: 40 })).resolves.toEqual({ kind: "release" });
    expect(storedCaps()).toEqual(EXPECTED_DEFAULTS);
    expect(iterations).toEqual([5, 5]);
  });

  test("invalid caps are refused without exposing their values", () => {
    const secret = "CAPS-SECRET";
    for (const value of [null, [], secret, 7, { extra: secret }, { maxSessions: 0 },
      { maxIterationsPerSession: -1 }, { maxSessions: 1.5 }, { sessionWallMs: 0 }, { workWallMs: 0 }, { sessionWallMs: secret },
      { sessionWallMs: 1_800_001 }, { workWallMs: 999 }]) {
      try { config(value); throw new Error("expected refusal"); }
      catch (error) {
        expect((error as Error).message).toBe("mesh jobs config: invalid work.caps");
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  test("session wall timer accepts the boundary and rejects overflow", () => {
    const max = 2_147_483_647;
    expect(loadWorkConfig({ caps: { sessionWallMs: max, workWallMs: max + 1 } }).caps.sessionWallMs).toBe(max);
    expect(() => loadWorkConfig({ caps: { sessionWallMs: max + 1, workWallMs: max + 1 } })).toThrow(RangeError);
  });

  test("mesh config rejects session wall timer overflow as work.caps", () => {
    const max = 2_147_483_647;
    expect(config({ sessionWallMs: max, workWallMs: max + 1 }).caps).toEqual({ sessionWallMs: max, workWallMs: max + 1 });
    expect(() => config({ sessionWallMs: max + 1, workWallMs: max + 1 })).toThrow("mesh jobs config: invalid work.caps");
  });

  test("stored work caps reject an overflowing session timer", () => {
    const caps = { ...EXPECTED_DEFAULTS, sessionWallMs: 2_147_483_648, workWallMs: 2_147_483_648 };
    expect(() => parseStoredCaps(JSON.stringify(caps))).toThrow(RangeError);
  });
});
