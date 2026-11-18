import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlGardenEventStore, runProgrammingLoop } from "../src/garden";

let tempDir: string;
let eventPath: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-garden-loop-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  eventPath = join(tempDir, "events.jsonl");
});

describe("manual report-only programming loop", () => {
  test("completes with verification evidence", async () => {
    const store = new JsonlGardenEventStore(eventPath);

    const result = await runProgrammingLoop({
      goal: "prove spine",
      agentId: "eli",
      instanceId: "cli-eli-1",
      project: "anima",
      runtime: "cli",
      store,
      verification: { command: "rtk bun test test/garden-operational-spine.test.ts" },
      runCommand: async () => ({ exitCode: 0, stdout: "pass", stderr: "" }),
      now: () => "2026-06-29T11:00:00.000Z",
      id: numberedIds(),
    });

    expect(result.status).toBe("DONE");
    expect(result.evidence?.[0]).toMatchObject({ kind: "command", exitCode: 0 });
    expect((await store.readAll()).map((event) => event.type)).toEqual([
      "TASK_STARTED",
      "TEST_RUN",
      "VERIFY_RESULT",
      "HANDOFF_WRITTEN",
    ]);
  });

  test("reports blocker with verification evidence", async () => {
    const store = new JsonlGardenEventStore(eventPath);

    const result = await runProgrammingLoop({
      goal: "prove spine",
      agentId: "eli",
      instanceId: "cli-eli-1",
      project: "anima",
      runtime: "cli",
      store,
      verification: { command: "rtk loomkit verify operational-spine-for-garden-loops" },
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "Coverage: 6%" }),
      now: () => "2026-06-29T11:00:00.000Z",
      id: numberedIds(),
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.blocker).toContain("rtk loomkit verify");
    expect((await store.readByType("BLOCKER_REPORTED"))[0].payload).toMatchObject({
      blocker: "verification failed: rtk loomkit verify operational-spine-for-garden-loops",
    });
  });

  test("requires approval for durable mutation requests", async () => {
    const store = new JsonlGardenEventStore(eventPath);

    const result = await runProgrammingLoop({
      goal: "deploy production without asking",
      agentId: "eli",
      instanceId: "cli-eli-1",
      project: "anima",
      runtime: "cli",
      store,
      requestedActions: ["deploy"],
      verification: { command: "rtk bun test" },
      runCommand: async () => ({ exitCode: 0, stdout: "pass", stderr: "" }),
      now: () => "2026-06-29T11:00:00.000Z",
      id: numberedIds(),
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.blocker).toContain("requires approval");
    expect((await store.readAll()).map((event) => event.type)).toEqual([
      "TASK_STARTED",
      "BLOCKER_REPORTED",
    ]);
  });
});

function numberedIds() {
  let n = 0;
  return () => `evt-${++n}`;
}
