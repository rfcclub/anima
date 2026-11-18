import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOrCreateActivationLayer, __resetActivationLayer } from "./activation-layer";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "anima-activation-layer-"));
  mkdirSync(join(tmpDir, "_shared"), { recursive: true });
  __resetActivationLayer();
});

afterEach(() => {
  __resetActivationLayer();
  rmSync(tmpDir, { recursive: true, force: true });
});

function noopLog() {}

test("SC-064: off/shadow mode constructs no activation layer", () => {
  expect(getOrCreateActivationLayer({ activationMode: "off", roomsDir: tmpDir, log: noopLog })).toBeNull();
  expect(getOrCreateActivationLayer({ activationMode: "shadow", roomsDir: tmpDir, log: noopLog })).toBeNull();
});

test("SC-064b: gate/enforce mode constructs a real layer with store, budget, executor, broker", () => {
  const layer = getOrCreateActivationLayer({ activationMode: "gate", roomsDir: tmpDir, log: noopLog });
  expect(layer).not.toBeNull();
  expect(layer!.store).toBeTruthy();
  expect(layer!.budget).toBeTruthy();
  expect(layer!.executor).toBeTruthy();
  expect(layer!.broker).toBeTruthy();
  layer!.store.close();
});

test("SC-064c: repeated calls return the exact same instance (one shared broker, not two)", () => {
  const first = getOrCreateActivationLayer({ activationMode: "gate", roomsDir: tmpDir, log: noopLog });
  const second = getOrCreateActivationLayer({ activationMode: "gate", roomsDir: tmpDir, log: noopLog });
  expect(second).toBe(first);
  first!.store.close();
});

test("SC-064d: a candidate enqueued and claimed through the shared layer is visible to a second caller of getOrCreateActivationLayer", () => {
  const layer = getOrCreateActivationLayer({ activationMode: "gate", roomsDir: tmpDir, log: noopLog })!;
  layer.broker.enqueue({
    key: "bruno:reflection-signal:bruno:tick:1", agentId: "bruno", sourceKind: "reflection-signal", sourceRef: "bruno",
    occurrenceKey: "tick:1", sourceVersion: 1, dueAt: 1, urgency: 5, costClass: "T1", executor: "reflection",
    summary: "test", reasonRef: "bruno",
  });

  const second = getOrCreateActivationLayer({ activationMode: "gate", roomsDir: tmpDir, log: noopLog })!;
  const claimed = second.broker.claimCandidate("bruno:reflection-signal:bruno:tick:1", 100);
  expect(claimed.ok).toBe(true);
  layer.store.close();
});
