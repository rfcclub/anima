import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnimaMeshPresence, type AnimaMeshPresenceOptions } from "./agent-presence";

type Line = { level: string; message: string; [key: string]: unknown };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("presence observation did not arrive");
}

function setup(options: { log?: AnimaMeshPresenceOptions["log"]; pending?: boolean; urlMarker?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "presence-incident-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const logs: Line[] = [];
  const sentinels = {
    token: "sentinel-session-token", credential: "sentinel-heartbeat-credential", proof: "sentinel-proof",
    header: "sentinel-response-header", body: "sentinel-response-body", url: "sentinel-url-component",
    error: "sentinel-transport-error",
  };
  let now = 1_000;
  let mode: "healthy" | "retry" | "fail" | "throw" | "empty-id" | "join-fail" | "rejoin-fail" | "gap-fail" = "healthy";
  let joinAttempts = 0;
  const fetchImpl = (async (input: string | Request, init?: RequestInit) => {
    const request = typeof input === "string" ? new Request(input, init) : input;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/identity-runtime/fixture-agent/join")) {
      return Response.json({
        leaseId: "lease", sessionToken: sentinels.token, ignored: sentinels.body,
        meshEnrollment: options.pending
          ? { status: "pending" }
          : { status: "enrolled", meshId: "test-agent-anima@local", heartbeatCredential: sentinels.credential },
      }, { headers: { "x-sentinel": sentinels.header } });
    }
    if (path.endsWith("/mesh-proof")) return Response.json({ proof: sentinels.proof, ignored: sentinels.body });
    if (path.endsWith("/mesh/v1/join")) {
      joinAttempts++;
      if (mode === "join-fail" || mode === "rejoin-fail") return new Response(null, { status: 503 });
      if (mode === "gap-fail") {
        const deadline = performance.now() + 150;
        while (performance.now() < deadline) { /* delay the next observation while the join fails */ }
        return new Response(null, { status: 401 });
      }
      if (mode === "fail") return new Response(sentinels.body, { status: 401 });
      if (mode === "empty-id") return Response.json({ meshId: "", heartbeatCredential: sentinels.credential });
      return Response.json({ meshId: "test-agent-anima@local", heartbeatCredential: sentinels.credential, ignored: sentinels.body });
    }
    if (path.endsWith("/heartbeat")) {
      if (mode === "throw") throw new Error(sentinels.error);
      if (mode === "fail" || mode === "empty-id" || mode === "rejoin-fail" || mode === "gap-fail") return new Response(sentinels.body, { status: 401 });
      if (mode === "retry") return new Response(sentinels.body, { status: 503, headers: { "x-sentinel": sentinels.header } });
      return Response.json({ status: "online", ignored: sentinels.body });
    }
    if (path.endsWith("/leave")) return Response.json({ status: "offline" });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const make = () => {
    const marker = options.urlMarker ? `/${sentinels.url}` : "";
    const created = new AnimaMeshPresence({
      agents: ["fixture-agent"], animaHome: home, fetch: fetchImpl, machine: "local",
      identityUrl: `http://identity.test${marker}`, meshUrl: `http://mesh.test${marker}`,
      heartbeatIntervalMs: 10, joinRetryMs: 100, joinDeadlineMs: 20, joinGraceMs: 20,
      monotonicNow: () => now,
      log: options.log ?? ((level, message, fields) => logs.push({ level, message, ...fields })),
    } as AnimaMeshPresenceOptions);
    cleanups.push(() => created.stop());
    return created;
  };
  const incident = () => logs.filter((line) => line.message === "mesh presence incident");
  const transitions = () => logs.filter((line) => line.message === "mesh presence");
  return { make, incident, transitions, logs, sentinels, joinAttempts: () => joinAttempts, setMode: (value: typeof mode) => { mode = value; }, setNow: (value: number) => { now = value; } };
}

async function observeRetry(fixture: ReturnType<typeof setup>) {
  fixture.setMode("retry");
  await until(() => fixture.transitions().some((line) => line.outcome === "retrying"));
}

test("presence regression: ANIMA observes retrying and then online ten monotonic seconds later", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  f.setNow(11_000);
  f.setMode("healthy");
  await until(() => f.transitions().filter((line) => line.outcome === "online").length === 2);
  const events = f.incident();
  expect(events.map((line) => [line.phase, line.result, line.observedMs, line.cause])).toEqual([
    ["retrying", "unknown", 0, "unknown"], ["recovered", "recovered", 10_000, "unknown"],
  ]);
  expect(events[0]!.incidentId).toEqual(events[1]!.incidentId);
  expect(f.transitions().find((line) => line.outcome === "retrying")?.incidentId).toEqual(events[0]!.incidentId);
});

test("ANIMA observes the same retry for at least 60000 ms and later observes online", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  f.setNow(60_999);
  await Bun.sleep(30);
  expect(f.incident().filter((line) => line.phase === "persistent")).toHaveLength(0);
  f.setNow(61_000);
  for (let i = 0; i < 200 && !f.incident().some((line) => line.phase === "persistent"); i++) await Bun.sleep(5);
  expect(f.incident().filter((line) => line.phase === "persistent")).toHaveLength(1);
  f.setNow(126_000);
  await Bun.sleep(30);
  f.setMode("healthy");
  await until(() => f.transitions().filter((line) => line.outcome === "online").length === 2);
  const events = f.incident();
  expect(events.map((line) => [line.phase, line.observedMs])).toEqual([
    ["retrying", 0], ["persistent", 60_000], ["recovered", 125_000],
  ]);
  expect(new Set(events.map((line) => line.incidentId)).size).toBe(1);
});

test("failed sidecar ends an incident unknown and a later rejoin is not its recovery", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  f.setNow(11_000);
  f.setMode("fail");
  await until(() => f.transitions().some((line) => line.outcome === "failed"));
  f.setMode("healthy");
  await until(() => f.transitions().filter((line) => line.outcome === "online").length === 2);
  expect(f.incident().map((line) => [line.phase, line.result, line.observedMs])).toEqual([
    ["retrying", "unknown", 0], ["ended", "unknown", 10_000],
  ]);
});

test("an online sidecar without an online identity does not prove recovery", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  f.setNow(11_000);
  f.setMode("empty-id");
  await until(() => f.transitions().filter((line) => line.outcome === "online").length === 2);
  expect(f.incident().map((line) => [line.phase, line.result])).toEqual([
    ["retrying", "unknown"], ["ended", "unknown"],
  ]);
});

test("stop and a new presence instance do not turn an unresolved incident into recovery", async () => {
  const f = setup();
  const first = f.make();
  await first.start();
  await observeRetry(f);
  f.setNow(8_000);
  await first.stop();
  f.setMode("healthy");
  const second = f.make();
  await second.start();
  expect(f.incident().map((line) => [line.phase, line.result, line.observedMs])).toEqual([
    ["retrying", "unknown", 0], ["ended", "unknown", 7_000],
  ]);
});

test("a missed observation window closes the old incident unknown", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  const incidentId = f.incident()[0]?.incidentId;
  f.setNow(11_000);
  f.setMode("healthy");
  const until = performance.now() + 150;
  while (performance.now() < until) { /* simulate a blocked event loop */ }
  await Bun.sleep(80);
  const events = f.incident().filter((line) => line.incidentId === incidentId);
  expect(events.some((line) => line.phase === "ended" && line.result === "unknown")).toBe(true);
  expect(events.some((line) => line.result === "recovered")).toBe(false);
});

test("review regression: retry after a sampling gap keeps agent on every incident event", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  const originalId = f.incident()[0]!.incidentId;
  f.setNow(11_000);
  const deadline = performance.now() + 150;
  while (performance.now() < deadline) { /* simulate a blocked event loop */ }
  await until(() => f.incident().some((line) => line.phase === "retrying" && line.incidentId !== originalId));
  const newId = f.incident().find((line) => line.phase === "retrying" && line.incidentId !== originalId)!.incidentId;
  f.setNow(71_000);
  await until(() => f.incident().some((line) => line.incidentId === newId && line.phase === "persistent"));
  f.setNow(72_000);
  await host.stop();
  const events = f.incident().filter((line) => line.incidentId === newId);
  expect(events.map((line) => line.phase)).toEqual(["retrying", "persistent", "ended"]);
  expect(events.map((line) => line.agent)).toEqual(["fixture-agent", "fixture-agent", "fixture-agent"]);
});

for (const path of ["no lease", "401 rejoin"] as const) {
  test(`review regression: ${path} join exhaustion is explicitly reported before a new sidecar`, async () => {
    const pending = path === "no lease";
    const f = setup({ pending });
    if (pending) f.setMode("join-fail");
    const host = f.make();
    await host.start();
    if (!pending) f.setMode("rejoin-fail");
    await until(() => f.transitions().some((line) => line.outcome === "retrying"));
    const incidentId = f.incident().find((line) => line.phase === "retrying")!.incidentId;
    f.setNow(41_000);
    await until(() => f.transitions().some((line) => line.outcome === "failed"));
    expect(f.joinAttempts()).toBe(5);
    const ended = f.incident().find((line) => line.incidentId === incidentId && line.phase === "ended");
    expect(ended).toMatchObject({
      agent: "fixture-agent", phase: "ended", result: "unknown", reason: "sidecar-failed",
      observedMs: 40_000, cause: "unknown",
    });
    f.setMode("healthy");
    await until(() => f.transitions().at(-1)?.outcome === "online");
    expect(f.incident().some((line) => line.incidentId === incidentId && line.phase === "recovered")).toBe(false);
  });
}

test("review regression: failed sidecar is identified after an observation gap", async () => {
  const f = setup();
  const host = f.make();
  await host.start();
  await observeRetry(f);
  const incidentId = f.incident()[0]!.incidentId;
  f.setNow(11_000);
  await Bun.sleep(30);
  f.setMode("gap-fail");
  await until(() => f.transitions().some((line) => line.outcome === "failed"));
  const ended = f.incident().find((line) => line.incidentId === incidentId && line.phase === "ended");
  expect(ended).toMatchObject({
    agent: "fixture-agent", phase: "ended", result: "unknown", reason: "sidecar-failed",
    observedMs: 10_000, cause: "unknown",
  });
});

test("incident diagnostics exclude credential, proof, header, body, URL and error sentinels", async () => {
  const f = setup({ pending: true, urlMarker: true });
  const host = f.make();
  await host.start();
  f.setMode("throw");
  await until(() => f.transitions().some((line) => line.outcome === "retrying"));
  f.setNow(11_000);
  f.setMode("healthy");
  await until(() => f.transitions().filter((line) => line.outcome === "online").length === 2);
  expect(f.incident()).toHaveLength(2);
  expect(f.incident().every((line) => line.cause === "unknown")).toBe(true);
  for (const value of Object.values(f.sentinels)) expect(JSON.stringify(f.logs)).not.toContain(value);
});

test("logger exceptions do not prevent presence start, retry or stop", async () => {
  const f = setup({ log: () => { throw new Error("logger broke"); } });
  const host = f.make();
  let startError: unknown = null;
  try { await host.start(); } catch (error) { startError = error; }
  expect(startError).toBeNull();
  expect(host.meshId("fixture-agent")).not.toBeNull();
  f.setMode("retry");
  await Bun.sleep(50);
  f.setMode("healthy");
  await Bun.sleep(50);
  expect(host.meshId("fixture-agent")).not.toBeNull();
  let stopError: unknown = null;
  try { await host.stop(); } catch (error) { stopError = error; }
  expect(stopError).toBeNull();
});
