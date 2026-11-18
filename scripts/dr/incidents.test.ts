import { expect, test } from "bun:test";
import { reduceIncidents } from "./incidents.ts";
import type { CheckResult, State } from "./types.ts";

const emptyState = (): State => ({
  version: 1,
  failCount: {},
  incidents: {},
  restarts: {},
  runSamples: {},
  presenceSince: {},
  queue: [],
});
const result = (status: CheckResult["status"], subject?: string, reason?: string): CheckResult => ({
  id: "mesh.join",
  ...(subject === undefined ? {} : { subject }),
  status,
  ...(reason === undefined ? {} : { reason }),
});

test("SC-012: two failures open an incident", () => {
  const first = reduceIncidents(emptyState(), [result("fail", "node-a", "not joined")], 100);
  expect(first.state.incidents["mesh.join|node-a"]).toBeUndefined();
  expect(first.events).toEqual([]);
  const second = reduceIncidents(first.state, [result("fail", "node-a", "still not joined")], 200);
  expect(second.state.incidents["mesh.join|node-a"]).toEqual({
    openedAt: 200,
    reason: "still not joined",
    alertSent: false,
    capAlertSent: false,
  });
  expect(second.events).toEqual([{ kind: "opened", key: "mesh.join|node-a", reason: "still not joined" }]);
});

test("SC-013: a pass closes an open incident", () => {
  const failedTwice = reduceIncidents(
    reduceIncidents(emptyState(), [result("fail", undefined, "down")], 100).state,
    [result("fail", undefined, "still down")],
    200,
  ).state;
  const recovered = reduceIncidents(failedTwice, [result("pass")], 300);
  expect(recovered.state.incidents["mesh.join|"]).toBeUndefined();
  expect(recovered.state.failCount["mesh.join|"]).toBe(0);
  expect(recovered.events).toEqual([{ kind: "closed", key: "mesh.join|", reason: "recovered" }]);
});

test("SC-012: unknown does not reset the consecutive failure count", () => {
  const first = reduceIncidents(emptyState(), [result("fail")], 100);
  const unknown = reduceIncidents(first.state, [result("unknown")], 200);
  expect(unknown.state.failCount["mesh.join|"]).toBe(1);
  const second = reduceIncidents(unknown.state, [result("fail")], 300);
  expect(second.state.incidents["mesh.join|"]).toBeDefined();
});

test("SC-012: a different subject is a different incident", () => {
  const first = reduceIncidents(emptyState(), [result("fail", "a"), result("fail", "b")], 100);
  const second = reduceIncidents(first.state, [result("fail", "a")], 200);
  expect(second.state.incidents["mesh.join|a"]).toBeDefined();
  expect(second.state.incidents["mesh.join|b"]).toBeUndefined();
  expect(second.state.failCount["mesh.join|b"]).toBe(1);
});

test("SC-012: two results for one key in a single run count as one run", () => {
  const out = reduceIncidents(emptyState(), [result("fail", "node-a", "one"), result("fail", "node-a", "two")], 100);
  expect(out.state.failCount["mesh.join|node-a"]).toBe(1);
  expect(out.state.incidents["mesh.join|node-a"]).toBeUndefined();
  expect(out.events).toEqual([]);
});

test("SC-012: in one run a failure beats a pass whatever the order", () => {
  for (const results of [[result("pass", "node-a"), result("fail", "node-a", "bad")], [result("fail", "node-a", "bad"), result("pass", "node-a")]]) {
    const out = reduceIncidents(emptyState(), results, 100);
    expect(out.state.failCount["mesh.join|node-a"]).toBe(1);
  }
});

test("SC-012: unknown in a run changes nothing for that key", () => {
  const first = reduceIncidents(emptyState(), [result("fail", "node-a", "bad")], 100);
  const second = reduceIncidents(first.state, [result("unknown", "node-a"), result("unknown", "node-a")], 200);
  expect(second.state.failCount["mesh.join|node-a"]).toBe(1);
});
