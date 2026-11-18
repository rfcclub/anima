import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutonomyLadder, JsonlGardenEventStore, type AutonomyChangePayload } from "../../src/garden";

let tempDir: string;
let store: JsonlGardenEventStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-garden-autonomy-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  store = new JsonlGardenEventStore(join(tempDir, "events.jsonl"));
});

function makeLadder() {
  let n = 0;
  return new AutonomyLadder({
    store,
    project: "anima",
    now: () => "2026-07-03T10:00:00.000Z",
    id: () => `evt-${++n}`,
  });
}

describe("autonomy ladder", () => {
  test("new agents start at L0 requiring approval", () => {
    const ladder = makeLadder();

    expect(ladder.getLevel("eli", "code-change")).toBe(0);
    expect(ladder.requiresApproval("eli", "code-change")).toBe(true);
    expect(ladder.isAllowed("eli", "code-change")).toBe(false);
  });

  test("promotes L0 to L1 after 10 successes with 0 violations", async () => {
    const ladder = makeLadder();

    for (let i = 0; i < 9; i++) {
      await ladder.recordSuccess("eli", "code-change");
    }
    expect(ladder.getLevel("eli", "code-change")).toBe(0);

    await ladder.recordSuccess("eli", "code-change");
    expect(ladder.getLevel("eli", "code-change")).toBe(1);
    expect(ladder.isAllowed("eli", "code-change")).toBe(true);
    expect(ladder.requiresApproval("eli", "code-change")).toBe(false);
  });

  test("promotion emits AUTONOMY_CHANGE event with from/to/reason", async () => {
    const ladder = makeLadder();

    for (let i = 0; i < 10; i++) {
      await ladder.recordSuccess("eli", "code-change");
    }

    const events = await store.readByType("AUTONOMY_CHANGE");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      agentId: "eli",
      actionClass: "code-change",
      from: 0,
      to: 1,
      reason: "10 successes, 0 violations",
    });
  });

  test("promotes to L2 at 50 and requires peer review for L3 at 100", async () => {
    const ladder = makeLadder();

    for (let i = 0; i < 100; i++) {
      await ladder.recordSuccess("eli", "review");
    }
    expect(ladder.getLevel("eli", "review")).toBe(2);

    ladder.approvePeerReview("eli", "review");
    await ladder.recordSuccess("eli", "review");
    expect(ladder.getLevel("eli", "review")).toBe(3);

    const changes = await store.readByType("AUTONOMY_CHANGE");
    const toL3 = changes.find((event) => (event.payload as AutonomyChangePayload).to === 3);
    expect(toL3?.payload).toMatchObject({ from: 2, reason: "101 successes, peer review approved" });
  });

  test("violation demotes one level and resets counters", async () => {
    const ladder = makeLadder();

    for (let i = 0; i < 10; i++) {
      await ladder.recordSuccess("eli", "deploy");
    }
    expect(ladder.getLevel("eli", "deploy")).toBe(1);

    await ladder.recordViolation("eli", "deploy");
    expect(ladder.getLevel("eli", "deploy")).toBe(0);

    const state = ladder.getState("eli", "deploy");
    expect(state.successCount).toBe(0);
    expect(state.violationCount).toBe(0);
    expect(state.demotedAt).toBe("2026-07-03T10:00:00.000Z");

    const changes = await store.readByType("AUTONOMY_CHANGE");
    expect(changes[changes.length - 1].payload).toMatchObject({
      from: 1,
      to: 0,
      reason: "violation recorded",
    });
  });

  test("violation at L0 stays at L0 and blocks promotion until demotion resets", async () => {
    const ladder = makeLadder();

    await ladder.recordViolation("eli", "code-change");
    expect(ladder.getLevel("eli", "code-change")).toBe(0);

    for (let i = 0; i < 20; i++) {
      await ladder.recordSuccess("eli", "code-change");
    }
    expect(ladder.getLevel("eli", "code-change")).toBe(0);
    expect(await store.readByType("AUTONOMY_CHANGE")).toHaveLength(0);
  });

  test("levels are tracked per agent per action class", async () => {
    const ladder = makeLadder();

    for (let i = 0; i < 10; i++) {
      await ladder.recordSuccess("eli", "code-change");
    }

    expect(ladder.getLevel("eli", "code-change")).toBe(1);
    expect(ladder.getLevel("eli", "deploy")).toBe(0);
    expect(ladder.getLevel("milo", "code-change")).toBe(0);
  });

  test("hydrate restores levels from persisted AUTONOMY_CHANGE events", async () => {
    const ladder = makeLadder();
    for (let i = 0; i < 10; i++) {
      await ladder.recordSuccess("eli", "code-change");
    }

    const restored = makeLadder();
    await restored.hydrate();
    expect(restored.getLevel("eli", "code-change")).toBe(1);
    expect(restored.getLevel("eli", "deploy")).toBe(0);
  });

  test("seed sets initial levels for agents without existing state", async () => {
    const ladder = makeLadder();

    await ladder.seed([
      { agentId: "bruno", actionClass: "code-change", level: 2 },
      { agentId: "eli", actionClass: "code-change", level: 2 },
      { agentId: "lena", actionClass: "code-change", level: 1 },
    ]);

    expect(ladder.getLevel("bruno", "code-change")).toBe(2);
    expect(ladder.getLevel("eli", "code-change")).toBe(2);
    expect(ladder.getLevel("lena", "code-change")).toBe(1);
    expect(ladder.getLevel("bruno", "deploy")).toBe(0); // not seeded
  });

  test("seed does not override existing state", async () => {
    const ladder = makeLadder();

    // Promote eli to L1 first
    for (let i = 0; i < 10; i++) {
      await ladder.recordSuccess("eli", "code-change");
    }
    expect(ladder.getLevel("eli", "code-change")).toBe(1);

    // Seed should NOT override eli's earned level
    await ladder.seed([
      { agentId: "eli", actionClass: "code-change", level: 2 },
    ]);
    expect(ladder.getLevel("eli", "code-change")).toBe(1); // still earned L1, not seeded L2
  });

  test("seed emits AUTONOMY_CHANGE events", async () => {
    const ladder = makeLadder();

    await ladder.seed([
      { agentId: "bruno", actionClass: "code-change", level: 2 },
    ]);

    const events = await store.readByType("AUTONOMY_CHANGE");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      agentId: "bruno",
      actionClass: "code-change",
      from: 0,
      to: 2,
      reason: "seeded at L2",
    });
  });
});
