import { expect, test } from "bun:test";
import { decideRestarts } from "./restart.ts";
import type { Config } from "./config.ts";
import type { CheckResult, Incident, State } from "./types.ts";

const emptyState = (): State => ({
  version: 1,
  failCount: {},
  incidents: {},
  restarts: {},
  runSamples: {},
  presenceSince: {},
  queue: [],
});

const config = (owned: string[], restartCap = 3, restartWindowMinutes = 60): Pick<Config, "owned" | "thresholds"> => ({
  owned,
  thresholds: {
    presenceMinutes: 5,
    claimMinutes: 30,
    crashRuns: 5,
    crashWindowMinutes: 10,
    restartCap,
    restartWindowMinutes,
  },
});

const result = (id: string, subject: string, status: CheckResult["status"], detail?: CheckResult["detail"]): CheckResult => ({
  id,
  subject,
  status,
  ...(detail === undefined ? {} : { detail }),
});

const open = (state: State, key: string, values: Partial<Incident> = {}): void => {
  state.incidents[key] = {
    openedAt: 1,
    reason: "failed",
    alertSent: false,
    capAlertSent: false,
    ...values,
  };
};

test("SC-005: an owned job with an open failing incident is kickstarted once", () => {
  const state = emptyState();
  open(state, "launchd.loaded|worker");

  const decision = decideRestarts(state, [result("launchd.loaded", "worker", "fail")], config(["worker"]), 1000);

  expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
  expect(decision.state.restarts.worker).toEqual([1000]);
});

test("SC-006: the fourth restart hits the cap once per job, across its incidents", () => {
  const state = emptyState();
  state.restarts.worker = [100, 200, 300];
  open(state, "launchd.loaded|worker");
  open(state, "health.ready|worker");

  const results = [result("launchd.loaded", "worker", "fail"), result("health.ready", "worker", "fail")];
  const first = decideRestarts(state, results, config(["worker"]), 400);
  expect(first.actions).toEqual([{ kind: "alert-cap", label: "worker" }]);
  expect(first.state.incidents["launchd.loaded|worker"]?.capAlertSent).toBe(true);
  expect(first.state.incidents["health.ready|worker"]?.capAlertSent).toBe(true);

  const second = decideRestarts(first.state, results, config(["worker"]), 500);
  expect(second.actions).toEqual([]);
});

test("a cap alert stays suppressed for another open restartable incident on the same job", () => {
  const state = emptyState();
  state.restarts.worker = [100, 200, 300];
  open(state, "launchd.loaded|worker");
  const first = decideRestarts(state, [result("launchd.loaded", "worker", "fail")], config(["worker"]), 400);
  expect(first.actions).toEqual([{ kind: "alert-cap", label: "worker" }]);

  open(first.state, "health.ready|worker");
  const second = decideRestarts(first.state, [result("health.ready", "worker", "fail")], config(["worker"]), 500);

  expect(second.actions).toEqual([]);
  expect(second.state.incidents["health.ready|worker"]?.capAlertSent).toBe(true);
});

test("SC-007: restarts older than the configured window do not count", () => {
  const state = emptyState();
  state.restarts.worker = [100];
  open(state, "health.ready|worker");

  const decision = decideRestarts(state, [result("health.ready", "worker", "fail")], config(["worker"], 1, 60), 3_600_101);

  expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
  expect(decision.state.restarts.worker).toEqual([3_600_101]);
});

test("SC-008: an open failure for an unowned label has no action", () => {
  const state = emptyState();
  open(state, "health.ready|foreign");

  expect(decideRestarts(state, [result("health.ready", "foreign", "fail")], config(["worker"]), 1000).actions).toEqual([]);
});

test("SC-009: crash loops and foreign port listeners alert once and suppress kickstart", () => {
  const state = emptyState();
  open(state, "launchd.crashloop|worker");
  open(state, "port.owner|worker");
  open(state, "health.ready|worker");
  const results = [
    result("launchd.crashloop", "worker", "fail"),
    result("port.owner", "worker", "fail", { port: "3700" }),
    result("health.ready", "worker", "fail"),
  ];

  const first = decideRestarts(state, results, config(["worker"]), 1000);
  expect(first.actions).toEqual([
    { kind: "alert-crashloop", label: "worker" },
    { kind: "alert-port", label: "worker", port: "3700" },
  ]);
  expect(first.state.restarts.worker).toBeUndefined();
  expect(first.state.incidents["launchd.crashloop|worker"]?.alertSent).toBe(true);
  expect(first.state.incidents["port.owner|worker"]?.alertSent).toBe(true);

  expect(decideRestarts(first.state, results, config(["worker"]), 2000).actions).toEqual([]);
});

test("SC-010: JSON-restored state preserves the per-job restart cap", () => {
  const state = emptyState();
  state.restarts.worker = [100, 200, 300];
  open(state, "health.ready|worker");
  const restored = JSON.parse(JSON.stringify(state)) as State;

  expect(decideRestarts(restored, [result("health.ready", "worker", "fail")], config(["worker"]), 400).actions)
    .toEqual([{ kind: "alert-cap", label: "worker" }]);
});

test("restart decisions do not mutate the input state", () => {
  const state = emptyState();
  state.restarts.worker = [100];
  open(state, "health.ready|worker");
  const before = JSON.stringify(state);

  decideRestarts(state, [result("health.ready", "worker", "fail")], config(["worker"]), 200);

  expect(JSON.stringify(state)).toBe(before);
});

test("one failing launchd and health incident for a job spend one restart slot", () => {
  const state = emptyState();
  open(state, "launchd.loaded|worker");
  open(state, "health.ready|worker");

  const decision = decideRestarts(state, [
    result("launchd.loaded", "worker", "fail"),
    result("health.ready", "worker", "fail"),
  ], config(["worker"]), 1000);

  expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
  expect(decision.state.restarts.worker).toEqual([1000]);
});

test("a failing port-owner incident without port detail alerts as unknown", () => {
  const state = emptyState();
  open(state, "port.owner|worker");

  const decision = decideRestarts(state, [result("port.owner", "worker", "fail")], config(["worker"]), 1000);

  expect(decision.actions).toEqual([{ kind: "alert-port", label: "worker", port: "unknown" }]);
  expect(decision.state.incidents["port.owner|worker"]?.alertSent).toBe(true);
});

test("a foreign subject ending in an owned label cannot spend its restart slot", () => {
  const state = emptyState();
  open(state, "health.ready|foreign|com.example.worker");

  const decision = decideRestarts(
    state,
    [result("health.ready", "foreign|com.example.worker", "fail")],
    config(["com.example.worker"]),
    1000,
  );

  expect(decision.actions).toEqual([]);
  expect(decision.state.restarts["com.example.worker"]).toBeUndefined();
});

test("a result is attributed only to the exactly matching owned subject", () => {
  const state = emptyState();
  open(state, "health.ready|foreign|com.example.worker");
  open(state, "health.ready|com.example.worker");

  const decision = decideRestarts(state, [
    result("health.ready", "foreign|com.example.worker", "fail"),
  ], config(["foreign|com.example.worker", "com.example.worker"]), 1000);

  expect(decision.actions).toEqual([{ kind: "kickstart", label: "foreign|com.example.worker" }]);
  expect(decision.state.restarts["foreign|com.example.worker"]).toEqual([1000]);
  expect(decision.state.restarts["com.example.worker"]).toBeUndefined();
});

test("unknown results do not trigger restart decisions", () => {
  const state = emptyState();
  open(state, "health.ready|worker");

  expect(decideRestarts(state, [result("health.ready", "worker", "unknown")], config(["worker"]), 1000).actions).toEqual([]);
});

test("duplicate owned labels spend only one restart slot with no prior history", () => {
  const state = emptyState();
  open(state, "health.ready|worker");

  const decision = decideRestarts(state, [result("health.ready", "worker", "fail")], config(["worker", "worker"]), 1000);

  expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
  expect(decision.state.restarts.worker).toEqual([1000]);
});

test("duplicate owned labels do not kickstart and then cap in the same call", () => {
  const state = emptyState();
  state.restarts.worker = [100, 200];
  open(state, "health.ready|worker");

  const decision = decideRestarts(state, [result("health.ready", "worker", "fail")], config(["worker", "worker"], 3), 1000);

  expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
  expect(decision.state.restarts.worker).toEqual([100, 200, 1000]);
});

test("the cap alert is sent again after the restart window empties for a still-open incident", () => {
  const results = [result("health.ready", "worker", "fail")];
  let state = emptyState();
  state.restarts.worker = [1, 2, 3];
  open(state, "health.ready|worker");

  const first = decideRestarts(state, results, config(["worker"]), 1_000);
  expect(first.actions).toEqual([{ kind: "alert-cap", label: "worker" }]);
  expect(first.state.incidents["health.ready|worker"]?.capAlertSent).toBe(true);

  // Nothing changes while the same window still holds its restarts.
  const quiet = decideRestarts(first.state, results, config(["worker"]), 2_000);
  expect(quiet.actions).toEqual([]);
  expect(quiet.state.incidents["health.ready|worker"]?.capAlertSent).toBe(true);

  // The window expires: the old restarts fall out and the cap is spent again from scratch.
  let decision = decideRestarts(first.state, results, config(["worker"]), 1_000 + 3_600_000 + 1);
  expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
  expect(decision.state.incidents["health.ready|worker"]?.capAlertSent).toBe(false);

  let now = 1_000 + 3_600_000 + 2;
  for (const _ of [0, 1]) {
    decision = decideRestarts(decision.state, results, config(["worker"]), now);
    expect(decision.actions).toEqual([{ kind: "kickstart", label: "worker" }]);
    now += 1_000;
  }

  const capped = decideRestarts(decision.state, results, config(["worker"]), now);
  expect(capped.actions).toEqual([{ kind: "alert-cap", label: "worker" }]);
  expect(capped.state.incidents["health.ready|worker"]?.capAlertSent).toBe(true);
});
