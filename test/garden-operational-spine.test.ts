import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOperationalBrief,
  createGardenEvent,
  JsonlGardenEventStore,
  projectGardenState,
} from "../src/garden";

let tempDir: string;
let eventPath: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-garden-spine-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  eventPath = join(tempDir, "garden-events.jsonl");
});

describe("Garden operational spine event store", () => {
  test("appends and reads typed Garden events", async () => {
    const store = new JsonlGardenEventStore(eventPath);
    const event = createGardenEvent({
      id: "evt-1",
      type: "TASK_STARTED",
      timestamp: "2026-06-29T10:00:00.000Z",
      agentId: "eli",
      instanceId: "cli-eli-1",
      runtime: "cli",
      project: "anima",
      payload: { goal: "wire operational spine" },
      evidence: [{ kind: "file", ref: "GARDEN_PROPOSAL.md" }],
      confidence: "high",
    });

    await store.append(event);

    expect(await store.readAll()).toEqual([event]);
  });

  test("preserves append order", async () => {
    const store = new JsonlGardenEventStore(eventPath);
    await store.append(baseEvent({ id: "evt-1", type: "TASK_STARTED" }));
    await store.append(baseEvent({ id: "evt-2", type: "VERIFY_RESULT", payload: { ok: true } }));

    expect((await store.readAll()).map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
  });

  test("rejects invalid events before writing partial lines", async () => {
    const store = new JsonlGardenEventStore(eventPath);
    await store.append(baseEvent({ id: "evt-valid", type: "TASK_STARTED" }));

    await expect(store.append({
      id: "evt-invalid",
      type: "TASK_STARTED",
      timestamp: "2026-06-29T10:01:00.000Z",
      agentId: "",
      instanceId: "cli-eli-1",
      runtime: "cli",
      project: "anima",
      payload: {},
    } as any)).rejects.toThrow("agentId");

    const lines = readFileSync(eventPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect((await store.readAll()).map((event) => event.id)).toEqual(["evt-valid"]);
  });

  test("represents and filters reflection tick actions with shared events", async () => {
    const store = new JsonlGardenEventStore(eventPath);
    await store.append(baseEvent({ id: "evt-task", type: "TASK_STARTED" }));
    await store.append(baseEvent({
      id: "evt-tick",
      type: "TICK_ACTION",
      payload: { tickId: "tick-1", phase: "ACT", action: "message-agent" },
    }));

    const tickEvents = await store.readByType("TICK_ACTION");

    expect(tickEvents).toHaveLength(1);
    expect(tickEvents[0].payload).toMatchObject({ tickId: "tick-1", action: "message-agent" });
  });
});

describe("Garden operational brief", () => {
  test("summarizes recent work state", () => {
    const events = [
      baseEvent({ id: "evt-task", type: "TASK_STARTED", payload: { goal: "finish garden spine" } }),
      baseEvent({ id: "evt-test", type: "TEST_RUN", payload: { command: "rtk bun test", exitCode: 0 } }),
      baseEvent({ id: "evt-verify", type: "VERIFY_RESULT", payload: { command: "loomkit verify", covered: 1, total: 17 } }),
      baseEvent({ id: "evt-block", type: "BLOCKER_REPORTED", payload: { blocker: "memory recall not wired" } }),
    ];

    const brief = buildOperationalBrief({
      goal: "finish garden spine",
      agentId: "eli",
      project: "anima",
      events,
      memoryRecall: ["The user wants evidence, not broad claims."],
      priorJudgments: ["Keep loops manual/report-only in v1."],
    });

    expect(brief.currentMission).toContain("finish garden spine");
    expect(brief.knownState.join("\n")).toContain("finish garden spine");
    expect(brief.blockers).toContain("memory recall not wired");
    expect(brief.recentEvidence.join("\n")).toContain("rtk bun test");
    expect(brief.priorJudgments).toContain("Keep loops manual/report-only in v1.");
    expect(brief.nextBestMove).toMatch(/memory recall|blocker/i);
  });

  test("stays separate from identity substrate", () => {
    const brief = buildOperationalBrief({
      goal: "inspect state",
      agentId: "eli",
      project: "anima",
      events: [],
      memoryRecall: ["A remembered preference"],
    });

    expect(brief.substrateMutation).toBe(false);
    expect(brief.identityMutation).toBe(false);
    expect(brief.memoryMutation).toBe(false);
  });
});

describe("Garden projection", () => {
  test("projects Hub state from events", () => {
    const events = [
      baseEvent({ id: "evt-task", type: "TASK_STARTED", payload: { goal: "ship spine", nextAction: "write tests" } }),
      baseEvent({ id: "evt-verify", type: "VERIFY_RESULT", payload: { command: "rtk loomkit verify", status: "FAIL" } }),
      baseEvent({ id: "evt-block", type: "BLOCKER_REPORTED", payload: { blocker: "16 scenarios uncovered" } }),
      baseEvent({ id: "evt-memory", type: "MEMORY_PROPOSAL", payload: { proposal: "remember garden boundary" } }),
    ];

    const projection = projectGardenState(events, { project: "anima" });

    expect(projection.activeSessions).toContain("cli-eli-1");
    expect(projection.recentWork[0]).toContain("ship spine");
    expect(projection.blockers).toContain("16 scenarios uncovered");
    expect(projection.verificationResults[0]).toContain("rtk loomkit verify");
    expect(projection.memoryProposals).toContain("remember garden boundary");
    expect(projection.nextActions).toContain("write tests");
  });

  test("projection is read-only", async () => {
    const store = new JsonlGardenEventStore(eventPath);
    await store.append(baseEvent({ id: "evt-task", type: "TASK_STARTED" }));
    const before = await store.readAll();

    projectGardenState(before, { project: "anima" });

    expect(await store.readAll()).toEqual(before);
  });
});

function baseEvent(overrides: Partial<ReturnType<typeof createGardenEvent>> = {}) {
  return createGardenEvent({
    id: "evt-base",
    type: "TASK_STARTED",
    timestamp: "2026-06-29T10:00:00.000Z",
    agentId: "eli",
    instanceId: "cli-eli-1",
    runtime: "cli",
    project: "anima",
    payload: { goal: "build spine" },
    evidence: [{ kind: "observation", ref: "test", summary: "fixture evidence" }],
    confidence: "medium",
    ...overrides,
  });
}
