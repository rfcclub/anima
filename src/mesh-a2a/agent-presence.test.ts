import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidecarClient } from "colony-mesh/a2a/mesh-sidecar-socket";
import { AnimaMeshPresence, presenceSocketPath } from "./agent-presence";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SECRET = "registration-secret-value";

/** Identity and Mesh answers by path; records every call. Requests may be a URL plus init, or a Request. */
function scripted(answer: (path: string, body: any) => Response | Promise<Response>) {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (input: string | Request, init?: RequestInit) => {
    const request = typeof input === "string" ? new Request(input, init) : input;
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    const path = new URL(request.url).pathname;
    calls.push({ path, body });
    return answer(path, body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function enrolledAnswer(path: string, body: any): Response {
  if (path.endsWith("/join")) {
    const agent = path.split("/")[2];
    return Response.json({ leaseId: `lease-${agent}`, sessionToken: `session-${agent}`, meshEnrollment: { status: "enrolled", meshId: `${agent}-anima-x@m`, heartbeatCredential: SECRET, leaseExpiresAt: Date.now() + 60_000 } });
  }
  if (path.endsWith("/heartbeat")) return Response.json({ status: "online" });
  if (path.endsWith("/leave")) return Response.json({ status: "offline" });
  if (path.endsWith("/mesh/list")) return Response.json({ listed: body.leaseId });
  return new Response(null, { status: 404 });
}

function presence(options: { animaHome: string; fetchImpl: typeof fetch; agents?: string[]; logs?: Array<Record<string, unknown>> }) {
  const created = new AnimaMeshPresence({
    agents: options.agents ?? ["finn", "jade"], animaHome: options.animaHome, fetch: options.fetchImpl,
    identityUrl: "http://identity.test", meshUrl: "http://mesh.test", machine: "Test-Host.local",
    heartbeatIntervalMs: 60_000, joinRetryMs: 60_000,
    // A short admission deadline: stop() after an unanswered join holds the home only this long.
    joinDeadlineMs: 50, joinGraceMs: 50,
    log: (level, message, fields) => options.logs?.push({ level, message, ...fields }),
  });
  cleanups.push(() => created.stop());
  return created;
}

describe("AnimaMeshPresence failures", () => {
  test("AJ-3 an unreachable identity-runtime leaves start resolved, with one log line per agent and no mesh fallback", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { calls, fetchImpl } = scripted(() => { throw new Error("connection refused"); });
    const hosted = presence({ animaHome: home(), fetchImpl, logs });
    await hosted.start();
    expect(hosted.meshId("finn")).toBeNull();
    expect(logs.map((line) => [line.agent, line.outcome])).toEqual([["finn", "identity-unreachable"], ["jade", "identity-unreachable"]]);
    expect(calls.every((call) => call.path.startsWith("/identity-runtime/"))).toBe(true);
    expect((await hosted.send("finn", { target: "x@m", content: "hi" })).status).toBe(503);
  });

  test("AJ-3 a rejected enrollment is logged once and not retried", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { calls, fetchImpl } = scripted(() => Response.json({ leaseId: "l", sessionToken: "s", meshEnrollment: { status: "rejected" } }));
    const hosted = presence({ animaHome: home(), fetchImpl, logs, agents: ["finn"] });
    await hosted.start();
    expect(logs).toEqual([{ level: "error", message: "mesh presence", agent: "finn", outcome: "rejected" }]);
    expect(calls).toHaveLength(1);
  });

  test("AJ-3 no log line or reply carries the registration credential", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { fetchImpl } = scripted(enrolledAnswer);
    const hosted = presence({ animaHome: home(), fetchImpl, logs });
    await hosted.start();
    expect(hosted.meshId("finn")).toBe("finn-anima-x@m");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify((await hosted.list("finn")).body)).not.toContain(SECRET);
  });

  test("AJ-4 each agent's calls use its own identity session", async () => {
    const { fetchImpl } = scripted(enrolledAnswer);
    const hosted = presence({ animaHome: home(), fetchImpl });
    await hosted.start();
    expect((await hosted.list("finn")).body).toEqual({ listed: "lease-finn" });
    expect((await hosted.list("jade")).body).toEqual({ listed: "lease-jade" });
  });

  test("AJ-20 a second presence on a busy home does not join and leaves the first one's sockets in place", async () => {
    const animaHome = home();
    const first = scripted(enrolledAnswer);
    const owner = presence({ animaHome, fetchImpl: first.fetchImpl });
    await owner.start();
    const logs: Array<Record<string, unknown>> = [];
    const second = scripted(enrolledAnswer);
    const intruder = presence({ animaHome, fetchImpl: second.fetchImpl, logs });
    await intruder.start();
    expect(intruder.state).toBe("busy");
    expect(second.calls).toHaveLength(0);
    expect(logs).toEqual([{ level: "error", message: "mesh presence not started", agent: "finn", outcome: "home-in-use" }]);
    await intruder.stop();
    for (const agent of ["finn", "jade"]) {
      expect(existsSync(presenceSocketPath(animaHome, agent))).toBe(true);
      expect((await sidecarClient(presenceSocketPath(animaHome, agent)).list()).status).toBe(200);
    }
  });
});

describe("AnimaMeshPresence shutdown during a join (Eli, review of ea7696b8)", () => {
  /** An identity join that answers only when released, with an enrolled lease. */
  function gatedJoin() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => {};
    const joinStarted = new Promise<void>((resolve) => { entered = resolve; });
    const { calls, fetchImpl } = scripted(async (path, body) => {
      if (path.endsWith("/join")) { entered(); await gate; }
      return enrolledAnswer(path, body);
    });
    return { calls, fetchImpl, joinStarted, release };
  }

  test("AJ-2 stop during an in-flight join drains it, leaves the lease it returns, and only then releases the socket", async () => {
    const animaHome = home();
    const g = gatedJoin();
    const hosted = presence({ animaHome, fetchImpl: g.fetchImpl, agents: ["finn"] });
    const starting = hosted.start();
    await g.joinStarted;
    let stopped = false;
    const stopping = hosted.stop().then(() => { stopped = true; });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    expect(existsSync(presenceSocketPath(animaHome, "finn"))).toBe(true);
    g.release();
    await Promise.all([starting, stopping]);
    const leaves = g.calls.filter((call) => call.path.endsWith("/leave"));
    expect(leaves.map((call) => call.path)).toEqual([`/mesh/v1/${encodeURIComponent("finn-anima-x@m")}/leave`]);
    expect(g.calls.some((call) => call.path.endsWith("/heartbeat"))).toBe(false);
    expect(hosted.meshId("finn")).toBeNull();
    expect(hosted.state).toBe("stopped");
    expect(existsSync(presenceSocketPath(animaHome, "finn"))).toBe(false);
  });

  test("AJ-20 a replacement on the same home cannot start while the old presence is still draining its join", async () => {
    const animaHome = home();
    const g = gatedJoin();
    const old = presence({ animaHome, fetchImpl: g.fetchImpl, agents: ["finn"] });
    const starting = old.start();
    await g.joinStarted;
    const stopping = old.stop();
    const early = scripted(enrolledAnswer);
    const replacement = presence({ animaHome, fetchImpl: early.fetchImpl, agents: ["finn"] });
    await replacement.start();
    expect(replacement.state).toBe("busy");
    expect(early.calls).toHaveLength(0);
    g.release();
    await Promise.all([starting, stopping]);
    const later = scripted(enrolledAnswer);
    const next = presence({ animaHome, fetchImpl: later.fetchImpl, agents: ["finn"] });
    await next.start();
    expect(next.meshId("finn")).toBe("finn-anima-x@m");
  });

  test("stop is complete and memoized: a second stop waits for the same shutdown, and start after stop does nothing", async () => {
    const { calls, fetchImpl } = scripted(enrolledAnswer);
    const hosted = presence({ animaHome: home(), fetchImpl, agents: ["finn"] });
    await hosted.start();
    const first = hosted.stop();
    const second = hosted.stop();
    expect(second).toBe(first);
    await first;
    const before = calls.length;
    await hosted.start();
    expect(calls).toHaveLength(before);
    expect(calls.filter((call) => call.path.endsWith("/leave"))).toHaveLength(1);
  });
});

describe("AnimaMeshPresence join deadline (Eli, review of bce805e5)", () => {
  test("a join carries a deadline, and an expired join is logged, retried and never heartbeated", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const before = Date.now();
    const { calls, fetchImpl } = scripted((path) => path.endsWith("/join")
      ? Response.json({ leaseId: "l", sessionToken: "s", meshEnrollment: { status: "expired" } })
      : new Response(null, { status: 404 }));
    const hosted = new AnimaMeshPresence({
      agents: ["finn"], animaHome: home(), fetch: fetchImpl, identityUrl: "http://identity.test", meshUrl: "http://mesh.test",
      machine: "m", joinDeadlineMs: 5_000, joinRetryMs: 20, log: (level, message, fields) => logs.push({ level, message, ...fields }),
    });
    cleanups.push(() => hosted.stop());
    await hosted.start();
    const notAfter = calls[0]!.body.mesh.notAfter as number;
    expect(notAfter).toBeGreaterThanOrEqual(before + 5_000);
    expect(notAfter).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(logs).toEqual([{ level: "error", message: "mesh presence", agent: "finn", outcome: "join-expired" }]);
    await Bun.sleep(60);
    expect(calls.filter((call) => call.path.endsWith("/join")).length).toBeGreaterThan(1);
    expect(calls.some((call) => call.path.endsWith("/heartbeat"))).toBe(false);
  });

  test("the client waits past the deadline by the grace, so an enrollment identity started in time is still seen", async () => {
    const { fetchImpl } = scripted(async (path, body) => {
      if (path.endsWith("/join")) await Bun.sleep(80);
      return enrolledAnswer(path, body);
    });
    const hosted = new AnimaMeshPresence({
      agents: ["finn"], animaHome: home(), fetch: fetchImpl, identityUrl: "http://identity.test", meshUrl: "http://mesh.test",
      machine: "m", joinDeadlineMs: 50, joinGraceMs: 100, heartbeatIntervalMs: 60_000, log: () => {},
    });
    cleanups.push(() => hosted.stop());
    await hosted.start();
    expect(hosted.meshId("finn")).toBe("finn-anima-x@m");
  });
});

describe("AnimaMeshPresence admission fence (Eli, review of a89b9027)", () => {
  test("after an ambiguous join, stop keeps the home until the join's deadline has passed, and proofs carry a deadline", async () => {
    const animaHome = home();
    const { calls, fetchImpl } = scripted((path) => {
      if (path.endsWith("/join") && path.startsWith("/identity-runtime/")) return Response.json({ leaseId: "l", sessionToken: "s", meshEnrollment: { status: "pending", retryable: true } });
      if (path.endsWith("/mesh-proof")) return Response.json({ proof: "p" });
      return new Response(null, { status: 503 });
    });
    const hosted = new AnimaMeshPresence({
      agents: ["finn"], animaHome, fetch: fetchImpl, identityUrl: "http://identity.test", meshUrl: "http://mesh.test",
      machine: "m", joinDeadlineMs: 250, heartbeatIntervalMs: 60_000, log: () => {},
    });
    cleanups.push(() => hosted.stop());
    await hosted.start();
    const proofRequest = calls.find((call) => call.path.endsWith("/mesh-proof"));
    expect(typeof proofRequest?.body.notAfter).toBe("number");
    let stopped = false;
    const stopping = hosted.stop().then(() => { stopped = true; });
    await Bun.sleep(80);
    expect(stopped).toBe(false);
    expect(existsSync(presenceSocketPath(animaHome, "finn"))).toBe(true);
    await stopping;
    const deadline = Math.max(calls[0]!.body.mesh.notAfter, proofRequest!.body.notAfter);
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect(existsSync(presenceSocketPath(animaHome, "finn"))).toBe(false);
  });
});

describe("AnimaMeshPresence after start (live deploy, abel offline at 19:58 Toronto)", () => {
  test("a sidecar that fails is logged, dropped and joined again from identity, and comes back online", async () => {
    const logs: Array<Record<string, unknown>> = [];
    let meshJoins = 0;
    const { calls, fetchImpl } = scripted((path) => {
      if (path.startsWith("/identity-runtime/") && path.endsWith("/join")) {
        return Response.json({ leaseId: "l", sessionToken: "s", meshEnrollment: { status: "pending", retryable: true } });
      }
      if (path.endsWith("/mesh-proof")) return Response.json({ proof: "p" });
      if (path === "/mesh/v1/join") {
        meshJoins += 1;
        // The first five Mesh joins fail (as abel's did); the sidecar gives up; the rejoin then works.
        return meshJoins <= 5
          ? new Response(null, { status: 500 })
          : Response.json({ meshId: "abel-anima-x@m", heartbeatCredential: SECRET, leaseExpiresAt: Date.now() + 60_000 });
      }
      if (path.endsWith("/heartbeat")) return Response.json({ status: "online" });
      if (path.endsWith("/leave")) return Response.json({ status: "offline" });
      return new Response(null, { status: 404 });
    });
    const hosted = new AnimaMeshPresence({
      agents: ["abel"], animaHome: home(), fetch: fetchImpl, identityUrl: "http://identity.test", meshUrl: "http://mesh.test",
      machine: "m", heartbeatIntervalMs: 10, joinRetryMs: 20, joinDeadlineMs: 50, log: (level, message, fields) => logs.push({ level, message, ...fields }),
    });
    cleanups.push(() => hosted.stop());
    await hosted.start();
    for (let n = 0; n < 200 && hosted.meshId("abel") === null; n++) await Bun.sleep(10);
    expect(hosted.meshId("abel")).toBe("abel-anima-x@m");
    const outcomes = logs.map((line) => line.outcome);
    expect(outcomes).toContain("failed");
    expect(outcomes.indexOf("failed")).toBeLessThan(outcomes.lastIndexOf("online"));
    expect(calls.filter((call) => call.path === "/identity-runtime/abel/join").length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  test("each later change of the sidecar's state is logged once", async () => {
    const logs: Array<Record<string, unknown>> = [];
    let healthy = true;
    const { fetchImpl } = scripted((path, body) => {
      if (path.endsWith("/heartbeat")) return healthy ? Response.json({ status: "online" }) : new Response(null, { status: 503 });
      return enrolledAnswer(path, body);
    });
    const hosted = new AnimaMeshPresence({
      agents: ["finn"], animaHome: home(), fetch: fetchImpl, identityUrl: "http://identity.test", meshUrl: "http://mesh.test",
      machine: "m", heartbeatIntervalMs: 10, log: (level, message, fields) => logs.push({ level, message, ...fields }),
    });
    cleanups.push(() => hosted.stop());
    await hosted.start();
    healthy = false;
    await Bun.sleep(80);
    healthy = true;
    await Bun.sleep(80);
    expect(logs.filter((line) => line.message === "mesh presence").map((line) => line.outcome)).toEqual(["online", "retrying", "online"]);
  });
});
