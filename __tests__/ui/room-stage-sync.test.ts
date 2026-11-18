import { describe, expect, test } from "bun:test";
import { createStageSync, type StageDriver } from "../../src/ui/features/castle/lib/stage-sync";
import type { RoomCharacter } from "../../src/ui/features/castle/engine/room-stage";

const agent = (agentId: string, highlighted = false): RoomCharacter => ({ agentId, position: "center", emotion: "neutral", highlighted });

/** A fake stage: draw adds the agents' sprites after a gate, clear removes them; failures can be scripted. */
function fakeStage() {
  const stage = new Map<string, number>(); // agentId -> sprite count (duplicates would show as 2)
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const draws: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const failures: Array<string[] | "throw"> = []; // per draw call: ids whose portrait fails to load, or a thrown error
  let hold = false;
  const driver: StageDriver = {
    async draw(agents) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      draws.push(agents.map((a) => a.agentId));
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      for (const a of agents) stage.set(a.agentId, (stage.get(a.agentId) ?? 0) + 1);
      inFlight--;
      const failed = failures.shift() ?? [];
      if (failed === "throw") throw new Error("canvas not ready");
      return failed;
    },
    clear(ids) { for (const id of ids) stage.delete(id); },
  };
  const setTimer = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false };
    timers.push(t);
    return () => { t.cancelled = true; };
  };
  return {
    driver, stage, draws, timers, failures, setTimer,
    get maxInFlight() { return maxInFlight; },
    hold(v: boolean) { hold = v; },
    release() { gates.splice(0).forEach((g) => g()); },
    fireTimers() { timers.filter((t) => !t.cancelled).splice(0).forEach((t) => { t.cancelled = true; t.fn(); }); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ids = (m: Map<string, number>) => [...m.entries()].map(([k, v]) => `${k}x${v}`).sort();

describe("stage sync", () => {
  test("SC-2: agents that arrive before the canvas is ready are drawn once it is", async () => {
    const f = fakeStage();
    const sync = createStageSync(f.driver, { setTimer: f.setTimer });
    sync.set([agent("cleo"), agent("kai")]);
    await tick();
    expect(f.draws).toEqual([]);
    sync.setReady();
    await tick();
    expect(ids(f.stage)).toEqual(["cleox1", "kaix1"]);
  });

  test("SC-1: presence that resolves after the canvas is ready is drawn without another trigger", async () => {
    const f = fakeStage();
    const sync = createStageSync(f.driver, { setTimer: f.setTimer });
    sync.setReady();
    sync.set([]);
    await tick();
    expect(ids(f.stage)).toEqual([]);
    sync.set([agent("cleo")]);
    await tick();
    expect(ids(f.stage)).toEqual(["cleox1"]);
  });

  test("SC-3: a newer set while a draw is in flight ends with exactly the newer sprites, one draw at a time", async () => {
    const f = fakeStage();
    const sync = createStageSync(f.driver, { setTimer: f.setTimer });
    sync.setReady();
    f.hold(true);
    sync.set([agent("cleo"), agent("kai")]);
    await tick();
    sync.set([agent("cleo"), agent("bruno")]);
    await tick();
    f.hold(false);
    f.release();
    await tick();
    await tick();
    expect(ids(f.stage)).toEqual(["brunox1", "cleox1"]);
    expect(f.maxInFlight).toBe(1);
  });

  test("an agent who leaves is removed from the stage", async () => {
    const f = fakeStage();
    const sync = createStageSync(f.driver, { setTimer: f.setTimer });
    sync.setReady();
    sync.set([agent("cleo"), agent("kai")]);
    await tick();
    sync.set([agent("cleo")]);
    await tick();
    expect(ids(f.stage)).toEqual(["cleox1"]);
  });

  test("the same agents and highlight are not drawn again", async () => {
    const f = fakeStage();
    const sync = createStageSync(f.driver, { setTimer: f.setTimer });
    sync.setReady();
    sync.set([agent("cleo")]);
    await tick();
    sync.set([agent("cleo")]);
    await tick();
    expect(f.draws.length).toBe(1);
    sync.set([agent("cleo", true)]);
    await tick();
    expect(f.draws.length).toBe(2);
  });

  test("SC-4: a portrait that failed to load is drawn again later, and the real one replaces the placeholder", async () => {
    const f = fakeStage();
    f.failures.push(["kai"]);
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [1500, 4000] });
    sync.setReady();
    sync.set([agent("cleo"), agent("kai")]);
    await tick();
    expect(f.draws.length).toBe(1);
    expect(f.timers.map((t) => t.ms)).toEqual([1500]);
    f.fireTimers();
    await tick();
    expect(f.draws.length).toBe(2);
    expect(ids(f.stage)).toEqual(["cleox1", "kaix1"]);
    expect(f.timers.filter((t) => !t.cancelled).length).toBe(0);
  });

  test("retries stop after the last delay", async () => {
    const f = fakeStage();
    f.failures.push(["kai"], ["kai"], ["kai"], ["kai"]);
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [10, 20] });
    sync.setReady();
    sync.set([agent("kai")]);
    await tick();
    f.fireTimers(); await tick();
    f.fireTimers(); await tick();
    f.fireTimers(); await tick();
    expect(f.draws.length).toBe(3);
  });

  test("a new wish gets its own retry budget after an earlier one used it up", async () => {
    const f = fakeStage();
    f.failures.push(["cleo"], ["cleo"], ["cleo"]);
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [10, 20] });
    sync.setReady();
    sync.set([agent("cleo")]);
    await tick();
    f.fireTimers(); await tick();
    f.fireTimers(); await tick();
    expect(f.draws.length).toBe(3);
    expect(f.timers.filter((t) => !t.cancelled).length).toBe(0); // budget used up
    // a visitor arrives; the draw fails once more, and it must be retried
    f.failures.push(["kai"]);
    sync.set([agent("cleo"), agent("kai")]);
    await tick();
    expect(f.draws.length).toBe(4);
    expect(f.timers.filter((t) => !t.cancelled).length).toBe(1);
    f.fireTimers(); await tick();
    expect(ids(f.stage)).toEqual(["cleox1", "kaix1"]);
  });

  test("polling that wants the same agents again does not bypass the retry schedule or its limit", async () => {
    const f = fakeStage();
    for (let i = 0; i < 40; i++) f.failures.push(["kai"]); // kai never loads
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [10, 20] });
    sync.setReady();
    sync.set([agent("cleo"), agent("kai")]);
    await tick();
    // ten presence polls: a new array each time, the same agents
    for (let i = 0; i < 10; i++) { sync.set([agent("cleo"), agent("kai")]); await tick(); }
    expect(f.draws.length).toBe(1);
    expect(f.timers.filter((t) => !t.cancelled).length).toBe(1);
    f.fireTimers(); await tick();
    f.fireTimers(); await tick();
    expect(f.draws.length).toBe(3); // first draw plus the two scheduled retries
    for (let i = 0; i < 10; i++) { sync.set([agent("cleo"), agent("kai")]); await tick(); }
    f.fireTimers(); await tick();
    expect(f.draws.length).toBe(3); // the limit holds however often the same wish is repeated
  });

  test("a new wish cancels the old wish's pending retry and starts at the first delay", async () => {
    const f = fakeStage();
    f.failures.push(["cleo"], ["cleo"]);
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [10, 1000] });
    sync.setReady();
    sync.set([agent("cleo")]);
    await tick();
    f.fireTimers(); await tick(); // cleo fails again: a 1000 ms retry is now pending
    expect(f.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([1000]);
    f.failures.push(["kai"]);
    sync.set([agent("kai")]);
    await tick();
    expect(f.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([10]);
  });

  test("a draw that throws (canvas not ready) is retried", async () => {
    const f = fakeStage();
    f.failures.push("throw");
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [10] });
    sync.setReady();
    sync.set([agent("cleo")]);
    await tick();
    f.fireTimers(); await tick();
    expect(ids(f.stage)).toEqual(["cleox1"]);
  });

  test("dispose cancels a pending retry", async () => {
    const f = fakeStage();
    f.failures.push(["cleo"]);
    const sync = createStageSync(f.driver, { setTimer: f.setTimer, retryDelaysMs: [10] });
    sync.setReady();
    sync.set([agent("cleo")]);
    await tick();
    sync.dispose();
    f.fireTimers(); await tick();
    expect(f.draws.length).toBe(1);
  });
});
