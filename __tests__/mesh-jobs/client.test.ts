import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { LeaseLostError, MeshJobsClient, MeshJobsHttpError, MeshJobsOfflineError } from "../../src/mesh-jobs/client";

const CAP = "cap-SECRET-abcdef";
const CLAIM = { id: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", worker: "jade@anima", state: "active", leaseExpiresAt: 1, evidenceRef: null };

// A fake gateway that follows the slice-1 status codes. Each test sets `next` per path.
let server: ReturnType<typeof Bun.serve>;
let seen: Array<{ method: string; path: string; auth: string | null; body: string }>;
let next: Record<string, () => Response>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body: await req.text() });
      return next[path]?.() ?? new Response(null, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => { seen = []; next = {}; });

function client(): MeshJobsClient {
  return new MeshJobsClient(`http://127.0.0.1:${server.port}`, () => CAP);
}

describe("MeshJobsClient", () => {
  test("pending sends the bearer and returns the count", async () => {
    next["/jobs/pending"] = () => Response.json({ count: 2 });
    expect(await client().pending()).toBe(2);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/jobs/pending", auth: `Bearer ${CAP}` });
  });

  test("claim returns the claim on 200 and null on 204", async () => {
    next["/jobs/claim"] = () => Response.json(CLAIM);
    expect(await client().claim()).toEqual(CLAIM as never);
    next["/jobs/claim"] = () => new Response(null, { status: 204 });
    expect(await client().claim()).toBeNull();
    expect(seen.map((r) => r.method)).toEqual(["POST", "POST"]);
  });

  test("getJob reads /jobs/:id", async () => {
    next[`/jobs/${CLAIM.jobId}`] = () => Response.json({ id: CLAIM.jobId, type: "review" });
    expect((await client().getJob(CLAIM.jobId)).type).toBe("review");
  });

  test("heartbeat on 409 throws LeaseLostError", async () => {
    next[`/jobs/claims/${CLAIM.id}/heartbeat`] = () => new Response("lease-lost: claim is lost", { status: 409 });
    await expect(client().heartbeat(CLAIM.id)).rejects.toBeInstanceOf(LeaseLostError);
  });

  test("report posts JSON; on 500 the error has the status and no capability", async () => {
    next[`/jobs/claims/${CLAIM.id}/report`] = () => new Response("internal error", { status: 500 });
    let caught: unknown;
    try { await client().report(CLAIM.id, { outcome: "done", evidenceRef: "https://github.com/x/y/pull/1#pullrequestreview-1" }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MeshJobsHttpError);
    expect((caught as MeshJobsHttpError).status).toBe(500);
    expect(String((caught as Error).message)).not.toContain(CAP);
    expect(JSON.parse(seen[0]!.body)).toEqual({ outcome: "done", evidenceRef: "https://github.com/x/y/pull/1#pullrequestreview-1" });
  });

  // AJ-16/AJ-17: the bearer is the agent's current mesh credential, read on every call.
  test("reads the credential on every call, so a rejoin's new credential is used", async () => {
    let current = "cred-first";
    const rotating = new MeshJobsClient(`http://127.0.0.1:${server.port}`, () => current);
    next["/jobs/pending"] = () => Response.json({ count: 0 });
    await rotating.pending();
    current = "cred-second";
    await rotating.pending();
    expect(seen.map((r) => r.auth)).toEqual(["Bearer cred-first", "Bearer cred-second"]);
  });

  test("while the agent has no credential, a call throws MeshJobsOfflineError and sends nothing", async () => {
    const offline = new MeshJobsClient(`http://127.0.0.1:${server.port}`, () => null);
    await expect(offline.pending()).rejects.toBeInstanceOf(MeshJobsOfflineError);
    expect(seen).toEqual([]);
  });
});
