import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutonomyLadder,
  GardenHub,
  JsonlGardenEventStore,
  createGardenEvent,
  type AgentEntry,
  type WorkTask,
} from "../../src/garden";

let tempDir: string;
let store: JsonlGardenEventStore;
let ladder: AutonomyLadder;
let hub: GardenHub;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-garden-hub-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlGardenEventStore(join(tempDir, "events.jsonl"));
  let n = 0;
  ladder = new AutonomyLadder({
    store,
    project: "anima",
    now: () => "2026-07-03T10:00:00.000Z",
    id: () => `evt-${++n}`,
  });
  hub = new GardenHub({ autonomy: ladder });
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
    status: "pending",
    events: [],
    ...overrides,
  };
}

async function promote(agentId: string, actionClass: "code-change" | "review" = "code-change") {
  for (let i = 0; i < 10; i++) {
    await ladder.recordSuccess(agentId, actionClass);
  }
}

describe("garden hub", () => {
  test("registers agents and enqueues tasks", () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());

    expect(hub.registry.get("eli")?.name).toBe("Eli");
    expect(hub.workQueue).toHaveLength(1);
    expect(hub.workQueue[0].status).toBe("pending");
  });

  test("L0 agent cannot claim tasks (approval required)", () => {
    hub.registerAgent(agent());
    hub.enqueueTask(task());

    expect(hub.claimTask("eli")).toBeNull();
    expect(hub.workQueue[0].status).toBe("pending");
  });

  test("L1 idle agent claims next pending task", async () => {
    await promote("eli");
    hub.registerAgent(agent());
    hub.enqueueTask(task());

    const claimed = hub.claimTask("eli");
    expect(claimed?.id).toBe("task-1");
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.assignedTo).toBe("eli");
    expect(hub.registry.get("eli")?.state).toBe("busy");
  });

  test("busy or unknown agents cannot claim", async () => {
    await promote("eli");
    hub.registerAgent(agent({ state: "busy" }));
    hub.enqueueTask(task());

    expect(hub.claimTask("eli")).toBeNull();
    expect(hub.claimTask("ghost")).toBeNull();
  });

  test("agent only claims tasks matching its capabilities", async () => {
    await promote("eli");
    hub.registerAgent(agent());
    hub.enqueueTask(task({ actionClass: "deploy" }));

    expect(hub.claimTask("eli")).toBeNull();
  });

  test("reportResult marks task done, frees agent, and records success", async () => {
    await promote("eli");
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    hub.claimTask("eli");

    const before = ladder.getState("eli", "code-change").successCount;
    await hub.reportResult("task-1", { status: "done" });

    expect(hub.workQueue[0].status).toBe("done");
    expect(hub.registry.get("eli")?.state).toBe("idle");
    expect(ladder.getState("eli", "code-change").successCount).toBe(before + 1);
  });

  test("reportResult with violation demotes the agent", async () => {
    await promote("eli");
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    hub.claimTask("eli");

    await hub.reportResult("task-1", { status: "blocked", violation: true });

    expect(hub.workQueue[0].status).toBe("blocked");
    expect(ladder.getLevel("eli", "code-change")).toBe(0);
  });

  test("reportResult throws for unknown task", async () => {
    await expect(hub.reportResult("missing", { status: "done" })).rejects.toThrow("unknown task");
  });

  test("getProjection aggregates events from all tasks", async () => {
    await promote("eli");
    hub.registerAgent(agent());
    hub.enqueueTask(task());
    hub.claimTask("eli");

    const started = createGardenEvent({
      id: "evt-a",
      type: "TASK_STARTED",
      timestamp: "2026-07-03T10:00:00.000Z",
      agentId: "eli",
      instanceId: "hub-eli-1",
      runtime: "hub",
      project: "anima",
      payload: { goal: "fix the flaky test" },
    });
    await hub.reportResult("task-1", { status: "done", events: [started] });

    const projection = hub.getProjection();
    expect(projection.recentWork).toEqual(["fix the flaky test"]);
    expect(projection.activeSessions).toEqual(["hub-eli-1"]);
  });
});
