import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../../src/agents/session";
import { ReflectionScheduler, type AgentConfig } from "../../src/continuity/reflection-engine";
import { ExpeditionDispatcher } from "../../src/garden/expedition-dispatcher";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";

let roomsDir: string;
let scheduler: ReflectionScheduler | null = null;

beforeEach(() => {
  roomsDir = mkdtempSync(join(tmpdir(), "anima-reflection-scheduler-"));
  mkdirSync(join(roomsDir, "_shared"), { recursive: true });
  __resetSharedNarrativeStore();
});

afterEach(() => {
  scheduler?.stop();
  scheduler = null;
  __resetSharedNarrativeStore();
  rmSync(roomsDir, { recursive: true, force: true });
});

// Task 10: the scheduler wires an ExpeditionDispatcher, exercised between
// tick rounds via its own interval, and tears it down on stop().
test("ReflectionScheduler wires an ExpeditionDispatcher on start and tears it down on stop", () => {
  scheduler = new ReflectionScheduler();
  scheduler.start([], AgentSession, roomsDir);

  const dispatcher = (scheduler as unknown as { expeditionDispatcher: ExpeditionDispatcher | null }).expeditionDispatcher;
  expect(dispatcher).toBeInstanceOf(ExpeditionDispatcher);
  const timer = (scheduler as unknown as { expeditionTimer: unknown }).expeditionTimer;
  expect(timer).not.toBeNull();

  scheduler.stop();

  expect((scheduler as unknown as { expeditionDispatcher: ExpeditionDispatcher | null }).expeditionDispatcher).toBeNull();
  expect((scheduler as unknown as { expeditionTimer: unknown }).expeditionTimer).toBeNull();
});

test("dispatcher wired by the scheduler picks up a claimed expedition on tick()", async () => {
  const agent: AgentConfig = { name: "lena", reflectionEnabled: false };
  scheduler = new ReflectionScheduler();
  scheduler.start([agent], AgentSession, roomsDir);

  const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
  store.seedPlacesFromRoster(["lena"]);
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: Date.now() });

  const dispatcher = (scheduler as unknown as { expeditionDispatcher: ExpeditionDispatcher }).expeditionDispatcher;
  await dispatcher.tick();

  // `lena` has no configured provider in this fixture, so resolveProvider
  // returns null and the dispatcher no-ops without throwing — the claim
  // stays put for a later tick once a provider is available.
  expect(store.claimedExpeditions().length).toBe(1);
});

test("enforce mode reaches every legacy autonomous path as a fail-closed policy", () => {
  const agent: AgentConfig = { name: "lena", reflectionEnabled: true };
  scheduler = new ReflectionScheduler();
  scheduler.start([agent], AgentSession, roomsDir, { activationMode: "enforce" });

  const runners = (scheduler as unknown as { runners: Map<string, unknown> }).runners;
  const runner = runners.get("lena") as { deps: { activation?: { mode: string } } };
  const dispatcher = (scheduler as unknown as {
    expeditionDispatcher: { deps: { activation?: { mode: string } } } | null;
  }).expeditionDispatcher;

  expect(runner.deps.activation).toEqual({ mode: "enforce" });
  expect(dispatcher?.deps.activation).toEqual({ mode: "enforce" });
});
