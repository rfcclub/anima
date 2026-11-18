import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnimaMeshPresence } from "../mesh-a2a/agent-presence";
import { MeshJobsClient, type MeshClaim, type MeshJobReport } from "./client";
import { MeshJobConsumer, type GitHubReader, type JobsPort } from "./consumer";

/**
 * rfcclub/anima#103 slice 4 (AJ-16, AJ-17) against the real colony-meshd gateway, job store and
 * endpoint registry, and the real identity-runtime, in a child process on temp databases
 * (../mesh-a2a/fixtures/mesh-stack-host.ts). GitHub and the agent turn are fakes.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const HEAD = "abc1234def5678abc1234def5678abc1234def56";

function tempDir(prefix: string): string {
  // Unix socket paths are short; keep homes near the root of tmp.
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function meshStack(agents: string[]): Promise<{ meshUrl: string; identityUrl: string }> {
  const root = tempDir("ms-");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "mesh-a2a", "fixtures", "mesh-stack-host.ts")], {
    env: { ...process.env, MESH_STACK_ROOT: root, MESH_STACK_AGENTS: agents.join(",") },
    stdout: "pipe", stderr: "inherit",
  });
  cleanups.push(async () => { child.kill(); await child.exited; });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const part = await reader.read();
    if (part.done) throw new Error("mesh stack host exited before it was ready");
    text += new TextDecoder().decode(part.value);
  }
  reader.releaseLock();
  return JSON.parse(text.split("\n")[0]!);
}

function presence(stack: { meshUrl: string; identityUrl: string }, agents: string[], animaHome: string): AnimaMeshPresence {
  const created = new AnimaMeshPresence({
    agents, animaHome, identityUrl: stack.identityUrl, meshUrl: stack.meshUrl, heartbeatIntervalMs: 200, joinRetryMs: 200,
    log: () => {},
  });
  cleanups.push(() => created.stop());
  return created;
}

/** jade enqueues a review job for finn's mesh ID, with jade's own mesh credential. */
async function enqueueReview(meshUrl: string, capability: string, worker: string): Promise<{ id: string }> {
  const response = await fetch(`${meshUrl}/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "review", target: { repo: "rfcclub/anima", kind: "pr", number: 80, headSha: "abc1234" },
      slots: 1, eligible: [worker], expiresAt: Date.now() + 3_600_000, idempotencyKey: "pr-80@abc1234",
    }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function github(): GitHubReader {
  return {
    async pullRequest() { return { headSha: HEAD, state: "open", merged: false, title: "Queue", body: "", author: "example-author" }; },
    async diff() { return "diff --git a/src/a.ts b/src/a.ts\n+x\n"; },
    async issue() { return { title: "", body: "" }; },
    async reviews() {
      return [{ commitId: HEAD, body: "Reviewer: finn\nAPPROVE", authorType: "Bot", submittedAt: new Date(Date.now() + 1000).toISOString(), url: "https://github.com/rfcclub/anima/pull/80#pullrequestreview-1" }];
    },
  };
}

/** The real client, with the claims each heartbeat and report returned. */
function recorded(jobs: JobsPort): JobsPort & { heartbeats: MeshClaim[]; reports: MeshClaim[] } {
  const spy = {
    heartbeats: [] as MeshClaim[],
    reports: [] as MeshClaim[],
    pending: () => jobs.pending(),
    claim: () => jobs.claim(),
    getJob: (id: string) => jobs.getJob(id),
    heartbeat: async (id: string) => { const claim = await jobs.heartbeat(id); spy.heartbeats.push(claim); return claim; },
    report: async (id: string, report: MeshJobReport) => { const claim = await jobs.report(id, report); spy.reports.push(claim); return claim; },
  };
  return spy;
}

describe("mesh-jobs worker on the agent's mesh ID", () => {
  test("AJ-16 a job that lists finn's mesh ID is claimed, run and reported with the live credential", async () => {
    const stack = await meshStack(["finn", "jade"]);
    const hosted = presence(stack, ["finn", "jade"], tempDir("ah-"));
    await hosted.start();
    const finn = hosted.meshId("finn")!;
    const job = await enqueueReview(stack.meshUrl, hosted.inbox("jade")!.capability, finn);

    const jobs = recorded(new MeshJobsClient(stack.meshUrl, () => hosted.inbox("finn")?.capability ?? null));
    const turns: string[] = [];
    const lines: string[] = [];
    const consumer = new MeshJobConsumer({
      workers: [{ agent: "finn", jobs }],
      github: github(),
      runTurn: async ({ agent }) => { turns.push(agent); },
      heartbeatMs: 60_000,
      turnTimeoutMs: 10_000,
      log: (level, message) => lines.push(`${level} ${message}`),
    });
    await consumer.tick();

    expect(turns).toEqual(["finn"]);
    expect(jobs.reports).toHaveLength(1);
    expect(jobs.reports[0]).toMatchObject({ jobId: job.id, worker: finn, state: "reported", evidenceRef: "https://github.com/rfcclub/anima/pull/80#pullrequestreview-1" });
    expect(lines).not.toContain("error mesh job tick failed");
  }, 30_000);

  test("AJ-17 the credential rotates between claim and report: heartbeat and report use the new one, the worker is unchanged", async () => {
    const stack = await meshStack(["finn", "jade"]);
    const home = tempDir("ah-");
    let current: AnimaMeshPresence | null = presence(stack, ["finn", "jade"], home);
    await current.start();
    const finn = current.meshId("finn")!;
    const firstCredential = current.inbox("finn")!.capability;
    await enqueueReview(stack.meshUrl, current.inbox("jade")!.capability, finn);

    const jobs = recorded(new MeshJobsClient(stack.meshUrl, () => current?.inbox("finn")?.capability ?? null));
    let secondCredential = "";
    let heartbeatsAfterRejoin = 0;
    const consumer = new MeshJobConsumer({
      workers: [{ agent: "finn", jobs }],
      github: github(),
      runTurn: async () => {
        // A restart of the ANIMA server mid-turn: the agents leave, then join again from the same home.
        const leaving = current!;
        current = null;
        await leaving.stop();
        const rejoined = presence(stack, ["finn", "jade"], home);
        await rejoined.start();
        current = rejoined;
        secondCredential = rejoined.inbox("finn")!.capability;
        // Wait for one heartbeat to succeed on the new credential (bounded, so a failure is an assertion, not a timeout).
        const heartbeats = jobs.heartbeats.length;
        const deadline = Date.now() + 3_000;
        while (jobs.heartbeats.length === heartbeats && Date.now() < deadline) await Bun.sleep(20);
        heartbeatsAfterRejoin = jobs.heartbeats.length - heartbeats;
      },
      heartbeatMs: 50,
      turnTimeoutMs: 10_000,
      log: () => {},
    });
    await consumer.tick();

    expect(current!.meshId("finn")).toBe(finn);
    expect(secondCredential).not.toBe("");
    expect(secondCredential).not.toBe(firstCredential);
    expect(heartbeatsAfterRejoin).toBeGreaterThan(0);
    expect(jobs.heartbeats.at(-1)).toMatchObject({ worker: finn, state: "active" });
    expect(jobs.reports).toHaveLength(1);
    expect(jobs.reports[0]).toMatchObject({ worker: finn, state: "reported" });
  }, 30_000);
});
