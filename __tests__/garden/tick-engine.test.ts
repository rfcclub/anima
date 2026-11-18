import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutonomyLadder,
  GardenHub,
  JsonlGardenEventStore,
  TickEngine,
  type AgentEntry,
  type CommandResult,
  type WorkTask,
} from "../../src/garden";

let tempDir: string;
let store: JsonlGardenEventStore;
let ladder: AutonomyLadder;
let hub: GardenHub;

beforeEach(async () => {
  tempDir = join(tmpdir(), `anima-garden-tick-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlGardenEventStore(join(tempDir, "events.jsonl"));
  let n = 0;
  ladder = new AutonomyLadder({
    store,
    project: "anima",
    now: () => "2026-07-03T10:00:00.000Z",
    id: () => `autonomy-${++n}`,
  });
  hub = new GardenHub({ autonomy: ladder });
  for (let i = 0; i < 10; i++) {
    await ladder.recordSuccess("eli", "code-change");
  }
});

function agent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    agentId: "eli",
    name: "Eli",
    instanceId: "hub-eli-1",
    runtime: "hub",
    capabilities: ["code-change"],
    state: "idle",
    ...overrides,
  };
}

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    goal: "fix the flaky test",
    project: "anima",
    verification: { command: "bun test --filter garden" },
    status: "pending",
    events: [],
    ...overrides,
  };
}

function makeEngine(options: {
  runCommand?: (command: string) => Promise<CommandResult>;
  dailyTokens?: number;
  costPerTask?: number;
} = {}): TickEngine {
  let n = 0;
  return new TickEngine({
    hub,
    store,
    interval: 60_000,
    budget: { dailyTokens: options.dailyTokens ?? 100_000 },
    costPerTask: options.costPerTask,
    project: "anima",
    runCommand: options.runCommand ?? (async () => ({ exitCode: 0, stdout: "pass", stderr: "" })),
    now: () => "2026-07-03T10:00:00.000Z",
    id: () => `tick-${++n}`,
  });
}

describe("tick engine", () => {
  test("dispatches pending task to idle agent and completes it", async () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    const engine = makeEngine();

    const report = await engine.tick();

    expect(report.tasksDispatched).toBe(1);
    expect(report.tasksCompleted).toBe(1);
    expect(report.blockers).toEqual([]);
    expect(hub.workQueue[0].status).toBe("done");
    expect(hub.registry.get("eli")?.state).toBe("idle");
  });

  test("failed verification marks task blocked and reports blocker", async () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    const engine = makeEngine({
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "1 fail" }),
    });

    const report = await engine.tick();

    expect(report.tasksDispatched).toBe(1);
    expect(report.tasksCompleted).toBe(0);
    expect(report.blockers[0]).toContain("verification failed");
    expect(hub.workQueue[0].status).toBe("blocked");
  });

  test("records programming loop events on the task", async () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    const engine = makeEngine();

    await engine.tick();

    expect(hub.workQueue[0].events.map((event) => event.type)).toEqual([
      "TASK_STARTED",
      "TEST_RUN",
      "VERIFY_RESULT",
      "HANDOFF_WRITTEN",
    ]);
  });

  test("emits TICK_ACTION event each tick", async () => {
    const engine = makeEngine();

    await engine.tick();

    const ticks = await store.readByType("TICK_ACTION");
    expect(ticks).toHaveLength(1);
    expect(ticks[0].payload).toMatchObject({
      tasksDispatched: 0,
      tasksCompleted: 0,
      blockers: [],
    });
  });

  test("does not dispatch when budget is exhausted", async () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    const engine = makeEngine({ dailyTokens: 0 });

    const report = await engine.tick();

    expect(report.tasksDispatched).toBe(0);
    expect(report.budgetRemaining).toBe(0);
    expect(hub.workQueue[0].status).toBe("pending");
  });

  test("tracks budget usage per dispatched task", async () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    const engine = makeEngine({ dailyTokens: 10_000, costPerTask: 4_000 });

    const report = await engine.tick();

    expect(report.tasksDispatched).toBe(1);
    expect(report.budgetRemaining).toBe(6_000);
    expect(engine.budget).toEqual({ dailyTokens: 10_000, usedToday: 4_000, remaining: 6_000 });
  });

  test("skips busy agents and L0 agents", async () => {
    hub.registerAgent(agent({ agentId: "busy-agent", state: "busy" }));
    hub.registerAgent(agent({ agentId: "novice", instanceId: "hub-novice-1" }));
    hub.enqueueTask(task());
    const engine = makeEngine();

    const report = await engine.tick();

    expect(report.tasksDispatched).toBe(0);
    expect(hub.workQueue[0].status).toBe("pending");
  });

  test("start and stop control the interval loop", () => {
    const engine = makeEngine();

    engine.start();
    engine.start();
    engine.stop();
    engine.stop();
  });
});
