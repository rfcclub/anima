import { expect, test } from "bun:test";
import { checkCrashLoop, checkHealth, checkLaunchd, checkMeshJoin, checkPorts } from "./checks.ts";
import { reduceIncidents } from "./incidents.ts";
import type { State } from "./types.ts";

const thresholds = { crashRuns: 5, crashWindowMinutes: 10 };

const emptyState = (): State => ({
  version: 1,
  failCount: {},
  incidents: {},
  restarts: {},
  runSamples: {},
  presenceSince: {},
  queue: [],
});

test("SC-001: loaded launchd jobs pass, missing pid fails, and command failure is unknown", () => {
  expect(checkLaunchd([
    { label: "running", output: "state = running\npid = 123" },
    { label: "loaded", output: "state = waiting" },
    { label: "unavailable", output: null },
  ])).toEqual([
    { id: "launchd.loaded", subject: "running", status: "pass" },
    { id: "launchd.loaded", subject: "loaded", status: "fail", reason: "not running" },
    { id: "launchd.loaded", subject: "unavailable", status: "unknown" },
  ]);
});

test("SC-002: crash growth with nonzero exit fails but clean or below-threshold runs pass", () => {
  const samples = { worker: [{ t: 9_000, runs: 100 }] };
  expect(checkCrashLoop([{ label: "worker", output: "runs = 105\nlast exit code = 1" }], 10_000, thresholds, samples).results[0]).toMatchObject({
    id: "launchd.crashloop", subject: "worker", status: "fail",
  });
  expect(checkCrashLoop([{ label: "worker", output: "runs = 105\nlast exit code = 0" }], 10_000, thresholds, samples).results[0]?.status).toBe("pass");
  expect(checkCrashLoop([{ label: "worker", output: "runs = 104\nlast exit code = 1" }], 10_000, thresholds, samples).results[0]?.status).toBe("pass");
});

test("SC-002: expired samples are removed and missing runs are unknown", () => {
  const expired = checkCrashLoop(
    [{ label: "worker", output: "runs = 2\nlast exit code = 1" }],
    10_000,
    thresholds,
    { worker: [{ t: 399_999, runs: 100 }] },
  );
  expect(expired.samples.worker).toEqual([{ t: 10_000, runs: 2 }]);
  expect(checkCrashLoop([{ label: "worker", output: "state = running" }], 10_000, thresholds, {}).results[0]?.status).toBe("unknown");
});

test("SC-002 regression: a launchd run counter reset starts a fresh growth baseline", () => {
  const result = checkCrashLoop(
    [{ label: "worker", output: "runs = 6\nlast exit code = 1" }],
    10_000,
    thresholds,
    { worker: [{ t: 8_000, runs: 100 }, { t: 9_000, runs: 1 }, { t: 9_500, runs: 3 }] },
  );
  expect(result.results[0]?.status).toBe("fail");
  expect(result.samples.worker).toEqual([{ t: 9_000, runs: 1 }, { t: 9_500, runs: 3 }, { t: 10_000, runs: 6 }]);
});

test("SC-002 regression: launchd exit-code diagnostics parse their numeric prefix", () => {
  const result = checkCrashLoop(
    [{ label: "worker", output: "runs = 105\nlast exit code = 78: EX_CONFIG" }],
    10_000,
    thresholds,
    { worker: [{ t: 9_000, runs: 100 }] },
  );
  expect(result.results[0]?.status).toBe("fail");
});

test("SC-002 regression: descriptive terminating signals fail a crash loop", () => {
  for (const signal of ["Killed: 9", "Terminated: 15", "Segmentation fault: 11"]) {
    const result = checkCrashLoop(
      [{ label: "worker", output: `runs = 105\nlast terminating signal = ${signal}` }],
      10_000,
      thresholds,
      { worker: [{ t: 9_000, runs: 100 }] },
    );
    expect(result.results[0]?.status).toBe("fail");
  }
});

test("SC-002 regression: repeated signal crash probes feed failures to the incident reducer", () => {
  let state = emptyState();
  let samples: Record<string, { t: number; runs: number }[]> = { worker: [{ t: 9_000, runs: 100 }] };
  for (const now of [10_000, 11_000]) {
    const checked = checkCrashLoop(
      [{ label: "worker", output: `runs = ${now === 10_000 ? 105 : 110}\nlast terminating signal = Killed: 9` }],
      now,
      thresholds,
      samples,
    );
    samples = checked.samples;
    state = reduceIncidents(state, checked.results, now).state;
  }
  expect(state.failCount["launchd.crashloop|worker"]).toBe(2);
  expect(state.incidents["launchd.crashloop|worker"]?.reason).toBeDefined();
});

test("SC-002 regression: unrecognized exit status remains unknown", () => {
  const result = checkCrashLoop(
    [{ label: "worker", output: "runs = 105\nlast exit code = not available" }],
    10_000,
    thresholds,
    { worker: [{ t: 9_000, runs: 100 }] },
  );
  expect(result.results[0]?.status).toBe("unknown");
});

test("SC-003: no listener, a foreign listener, and the sole owner are classified", () => {
  expect(checkPorts({ "13541": "com.example.owner" }, [
    { port: 13541, listeners: [] },
    { port: 13541, listeners: ["com.example.other"] },
    { port: 13541, listeners: ["com.example.owner"] },
  ])).toEqual([
    { id: "port.owner", subject: "13541", status: "fail", reason: "nothing listens" },
    { id: "port.owner", subject: "13541", status: "fail", reason: "listener is not com.example.owner" },
    { id: "port.owner", subject: "13541", status: "pass" },
  ]);
});

test("SC-003: an owner plus a foreign listener fails", () => {
  expect(checkPorts({ "13541": "owner" }, [{ port: 13541, listeners: ["owner", "foreign"] }])[0]).toMatchObject({
    status: "fail", reason: "foreign listener present",
  });
});

test("SC-003 regression: a substring impostor is not the owner", () => {
  expect(checkPorts({ "13541": "com.example.owner" }, [{ port: 13541, listeners: ["not-com.example.owner-fake"] }])[0]).toMatchObject({
    status: "fail", reason: "listener is not com.example.owner",
  });
});

test("SC-003 regression: multiple owner entries from distinct processes fail", () => {
  expect(checkPorts({ "13541": "com.example.owner" }, [{
    port: 13541,
    listeners: ["com.example.owner pid 123", "com.example.owner pid 456"],
  }])[0]).toMatchObject({ status: "fail", reason: "foreign listener present" });
});

test("SC-003 regression: IPv4 and IPv6 entries for the same pid count as one process", () => {
  expect(checkPorts({ "13541": "com.example.owner" }, [{
    port: 13541,
    listeners: ["com.example.owner pid 123 (IPv4)", "com.example.owner pid 123 (IPv6)"],
  }])[0]?.status).toBe("pass");
});

test("SC-003 regression: two owner label-only entries remain two listeners", () => {
  expect(checkPorts({ "13541": "com.example.owner" }, [{
    port: 13541,
    listeners: ["com.example.owner", "com.example.owner"],
  }])[0]).toMatchObject({ status: "fail", reason: "foreign listener present" });
});

test("SC-003 regression: natural lsof command and pid columns deduplicate one process", () => {
  expect(checkPorts({ "13541": "com.example.owner" }, [{
    port: 13541,
    listeners: ["com.example.owner 1234 IPv4", "com.example.owner 1234 IPv6"],
  }])[0]?.status).toBe("pass");
});

test("SC-004: mesh join recognizes on, off, unknown, and unexpected status", () => {
  expect(checkMeshJoin(401)).toMatchObject({ status: "pass" });
  expect(checkMeshJoin(404)).toMatchObject({ status: "fail", reason: expect.stringContaining("meshService") });
  expect(checkMeshJoin(null)).toMatchObject({ status: "unknown" });
  expect(checkMeshJoin(503)).toMatchObject({ status: "fail", reason: expect.stringContaining("503") });
});

test("health: only status 200 passes and null is unknown", () => {
  expect(checkHealth("health.ready", 200).status).toBe("pass");
  expect(checkHealth("health.ready", null).status).toBe("unknown");
  expect(checkHealth("health.ready", 503)).toMatchObject({ status: "fail", reason: expect.stringContaining("503") });
});
