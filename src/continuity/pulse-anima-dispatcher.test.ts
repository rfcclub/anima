import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPulseAnimaState, runPulseAnimaStage, PulseAnimaDispatcher, PULSE_ANIMA_STAGES, stageOutputFileName, scheduleRestoreHomeAfterIdle, restoreOverdueAgentsHome, PULSE_ANIMA_IDLE_MS, LIBRARY_ACTIVE_FLAG, isLibraryActive, extractPulseStageSpokenLine, snapshotPriorPlaces } from "./pulse-anima-dispatcher";
import * as dispatcherModule from "./pulse-anima-dispatcher";
import type { GardenEvent } from "../garden/events";
import type { BeamEntry } from "../dream/light-nap";

let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pulse-anima-dispatcher-"));
  stateFile = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const FIXTURE = {
  status: "active",
  cycles: {
    observe: { cycle: "observe", next: "milo", sequence: ["rhea", "gus", "milo", "ivan"] },
    reflect: { cycle: "reflect", next: "cleo", sequence: ["kai", "dana", "cleo", "nora"] },
    dream: { cycle: "dream", next: "sam", sequence: ["eli", "sam", "pia", "finn"] },
    integrate: { cycle: "integrate", next: "bruno", sequence: ["abel", "hana", "lena", "bruno"] },
  },
};

test("SC-2: readPulseAnimaState resolves the current next agent for each stage", () => {
  writeFileSync(stateFile, JSON.stringify(FIXTURE));
  const state = readPulseAnimaState(stateFile);
  expect(state.observe.next).toBe("milo");
  expect(state.reflect.next).toBe("cleo");
  expect(state.dream.next).toBe("sam");
  expect(state.integrate.next).toBe("bruno");
});

test("SC-5: stageOutputFileName matches pulse-anima-cycle.sh's real per-stage output files", () => {
  expect(stageOutputFileName("observe")).toBe("BRIDGE.md");
  expect(stageOutputFileName("reflect")).toBe("MIRROR.md");
  expect(stageOutputFileName("dream")).toBe("BROADCAST.md");
  expect(stageOutputFileName("integrate")).toBe("SUBSTRATE.md");
});

test("readPulseAnimaState throws a clear error when the file is missing", () => {
  expect(() => readPulseAnimaState(join(tmpDir, "does-not-exist.json"))).toThrow(/state\.json/);
});

test("readPulseAnimaState throws a clear error when a stage's next is missing", () => {
  writeFileSync(stateFile, JSON.stringify({ status: "active", cycles: { observe: { cycle: "observe" } } }));
  expect(() => readPulseAnimaState(stateFile)).toThrow(/next/);
});

// ── runPulseAnimaStage ───────────────────────────────────────────────────

function makeDeps(overrides: Partial<Parameters<typeof runPulseAnimaStage>[2]> = {}) {
  const presenceCalls: unknown[] = [];
  const appended: GardenEvent[] = [];
  const beams: Array<{ agentId: string; beam: BeamEntry }> = [];
  return {
    presenceCalls,
    appended,
    beams,
    deps: {
      store: { setPresence: (p: unknown) => { presenceCalls.push(p); } },
      eventStore: { append: async (e: GardenEvent) => { appended.push(e); } },
      runScript: async () => ({ exitCode: 0 }),
      readOutput: async () => "real stage output",
      writeBeam: async (agentId: string, beam: BeamEntry) => { beams.push({ agentId, beam }); },
      now: () => Date.parse("2026-09-05T00:00:00Z"),
      ...overrides,
    },
  };
}

test("SC-3/SC-4: a successful stage sets presence in library then appends STARTED before running", async () => {
  const { presenceCalls, appended, deps } = makeDeps();
  await runPulseAnimaStage("observe", "rhea", deps);
  expect(presenceCalls[0]).toMatchObject({ agentId: "rhea", placeId: "library", activity: "pulse:observe" });
  expect(appended[0]).toMatchObject({ type: "PULSE_STAGE_STARTED", agentId: "rhea", payload: { stage: "observe" } });
});

test("SC-5: a successful stage appends COMPLETED with the real output text", async () => {
  const { appended, deps } = makeDeps({ readOutput: async () => "the real BRIDGE.md content" });
  await runPulseAnimaStage("observe", "rhea", deps);
  expect(appended[1]).toMatchObject({ type: "PULSE_STAGE_COMPLETED", agentId: "rhea", payload: { stage: "observe", text: "the real BRIDGE.md content" } });
});

test("SC-6: exit-1 with no readable output appends COMPLETED with failed:true and never throws", async () => {
  const { appended, deps } = makeDeps({
    runScript: async () => ({ exitCode: 1 }),
    readOutput: async () => { throw new Error("ENOENT"); },
  });
  await expect(runPulseAnimaStage("dream", "eli", deps)).resolves.toEqual({ exitCode: 1 });
  expect(appended[1]).toMatchObject({ type: "PULSE_STAGE_COMPLETED", agentId: "eli", payload: { stage: "dream", text: "dream failed", failed: true } });
});

test("SC-P50: exit-1 but the output file was already written (pulse-anima-cycle.sh's quality-gate exits 1 AFTER writing real content) still surfaces the real text, not a discarded 'failed' marker — verified against pulse-anima-cycle.sh:750-805's check_quality() running post-write", async () => {
  const { appended, deps } = makeDeps({
    runScript: async () => ({ exitCode: 1 }),
    readOutput: async () => "real content the quality gate happened to reject afterward",
  });
  await runPulseAnimaStage("observe", "ivan", deps);
  expect(appended[1]).toMatchObject({
    type: "PULSE_STAGE_COMPLETED",
    agentId: "ivan",
    payload: { stage: "observe", text: "real content the quality gate happened to reject afterward" },
  });
  expect(appended[1].payload).not.toHaveProperty("failed");
});

// Castle's room log must not render a stage's full raw digest (header plus
// the whole reflection) as if it were spoken dialogue. Real output files
// (<pulse dir>/cycles/<stage>/current/*.md) look like:
//   # Integrate — hana\n\n**Turn:** 421\n**Model:** ...\n**Timestamp:** ...\n\n===\n\n<body>
// extractPulseStageSpokenLine strips that header and shortens the body to
// something that reads like a spoken line, not a dumped document.
test("extractPulseStageSpokenLine strips the header block up to the === separator", () => {
  const raw = "# Integrate — hana\n\n**Turn:** 421\n**Model:** example-model\n**Timestamp:** 2026-09-13T11:08:22Z\n\n===\n\nShort body.";
  expect(extractPulseStageSpokenLine(raw)).toBe("Short body.");
});

test("extractPulseStageSpokenLine truncates a long body to a spoken-length excerpt, ending at a sentence boundary", () => {
  const raw = `# Integrate — hana\n\n===\n\nFirst sentence is short. ${"Padding words here. ".repeat(20)}`;
  const result = extractPulseStageSpokenLine(raw);
  expect(result.length).toBeLessThan(260);
  expect(result.startsWith("First sentence is short.")).toBe(true);
  expect(result.endsWith(".")).toBe(true);
});

test("extractPulseStageSpokenLine passes header-less text through unchanged when short", () => {
  expect(extractPulseStageSpokenLine("the real BRIDGE.md content")).toBe("the real BRIDGE.md content");
});

test("extractPulseStageSpokenLine hard-truncates with an ellipsis when no sentence boundary is found early enough", () => {
  const raw = `===\n\n${"a".repeat(400)}`;
  const result = extractPulseStageSpokenLine(raw);
  expect(result.endsWith("…")).toBe(true);
  expect(result.length).toBeLessThan(260);
});

test("a successful stage writes exactly one beam, keyed by agent and stage (requirement: one beam per pulse)", async () => {
  const { beams, deps } = makeDeps({ readOutput: async () => "real integrate output" });
  await runPulseAnimaStage("integrate", "hana", deps);
  expect(beams).toHaveLength(1);
  expect(beams[0].agentId).toBe("hana");
  expect(beams[0].beam.agent).toBe("hana");
  expect(beams[0].beam.session).toBe("pulse:integrate");
  expect(beams[0].beam.source).toBe("pulse-anima:integrate");
  expect(beams[0].beam.content).toBe("real integrate output");
});

test("a failed stage (unreadable output) writes NO beam — only real content becomes a beam", async () => {
  const { beams, deps } = makeDeps({
    runScript: async () => ({ exitCode: 1 }),
    readOutput: async () => { throw new Error("ENOENT"); },
  });
  await runPulseAnimaStage("dream", "eli", deps);
  expect(beams).toHaveLength(0);
});

// pulse-anima-cycle.sh's own stasis detector (input unchanged across consecutive cycles) can write a
// header-only output file — readable (doesn't hit the catch above), but empty
// after extractPulseStageSpokenLine strips the header. That produced a real,
// content-less beam file.
test("a readable but header-only (stasis) output writes NO beam — an empty beam is noise, not a reflection", async () => {
  const { beams, deps } = makeDeps({
    readOutput: async () => "# Integrate — hana\n\n**Turn:** 462\n**Model:** example-model\n**Timestamp:** 2026-09-14T00:46:08Z\n\n===\n\n",
  });
  await runPulseAnimaStage("integrate", "hana", deps);
  expect(beams).toHaveLength(0);
});

test("SC-90: COMPLETED text is the extracted spoken excerpt, not the raw digest, when the real header format is present", async () => {
  const raw = "# Integrate — hana\n\n**Turn:** 421\n**Model:** example-model\n**Timestamp:** 2026-09-13T11:08:22Z\n\n===\n\nA real reflection body that should be spoken, not the header above it.";
  const { appended, deps } = makeDeps({ readOutput: async () => raw });
  await runPulseAnimaStage("integrate", "hana", deps);
  const completed = appended[1].payload as { text: string };
  expect(completed.text).not.toContain("**Turn:**");
  expect(completed.text).toBe("A real reflection body that should be spoken, not the header above it.");
});

test("SC-P70: a stage sets presence in library and does NOT restore it home itself — the whole session (all 4 agents) stays present together until the dispatcher ends the cycle (requirement: agents wait until all agents have finished their work before going back to their rooms)", async () => {
  const { presenceCalls, deps } = makeDeps();
  await runPulseAnimaStage("observe", "rhea", deps);
  expect(presenceCalls).toHaveLength(1);
  expect(presenceCalls[0]).toMatchObject({ agentId: "rhea", placeId: "library" });
});

test("SC-P71: a failing stage also leaves presence in library — restoration is the dispatcher's job, not the stage's", async () => {
  const { presenceCalls, deps } = makeDeps({
    runScript: async () => ({ exitCode: 1 }),
    readOutput: async () => { throw new Error("ENOENT"); },
  });
  await runPulseAnimaStage("dream", "eli", deps);
  expect(presenceCalls).toHaveLength(1);
  expect(presenceCalls[0]).toMatchObject({ agentId: "eli", placeId: "library" });
});

// ── PulseAnimaDispatcher ─────────────────────────────────────────────────

function makeDispatcherDeps(nowMs: number, sharedClaims?: Set<string>) {
  const runStageCalls: Array<{ stage: string; agentId: string; startedAt: number; finishedAt: number }> = [];
  let disruptionCalls = 0;
  const restoreHomeCalls: string[][] = [];
  let checkOverdueRestoresCalls = 0;
  let markLibraryActiveCalls = 0;
  const state = { observe: { next: "milo" }, reflect: { next: "cleo" }, dream: { next: "sam" }, integrate: { next: "bruno" } };
  let currentTime = nowMs;
  const claims = sharedClaims ?? new Set<string>();
  const legacyFlags = new Set<string>();
  const claimCalls: string[] = [];
  const order: string[] = [];
  const events: Array<{ stage: string; ok: boolean }> = [];
  const logs: string[] = [];
  const control: {
    claimError?: Error;
    preError?: Error;
    postError?: Error;
    stageExit: Record<string, number>;
    stageThrow: Set<string>;
  } = { stageExit: {}, stageThrow: new Set() };
  return {
    runStageCalls,
    getDisruptionCalls: () => disruptionCalls,
    restoreHomeCalls,
    getCheckOverdueRestoresCalls: () => checkOverdueRestoresCalls,
    getMarkLibraryActiveCalls: () => markLibraryActiveCalls,
    setTime: (t: number) => { currentTime = t; },
    claims,
    legacyFlags,
    claimCalls,
    order,
    events,
    logs,
    control,
    deps: {
      readState: () => state,
      runStage: async (stage: string, agentId: string) => {
        const startedAt = currentTime;
        order.push(stage);
        await Promise.resolve();
        runStageCalls.push({ stage, agentId, startedAt, finishedAt: currentTime });
        if (control.stageThrow.has(stage)) throw new Error(`${stage} exploded`);
        return { exitCode: control.stageExit[stage] ?? 0 };
      },
      runPre: async () => {
        order.push("pre");
        if (control.preError) throw control.preError;
        return { exitCode: 0 };
      },
      runPost: async () => {
        order.push("post");
        if (control.postError) throw control.postError;
        return { exitCode: 0 };
      },
      emitStageEvent: async (stage: string, ok: boolean) => { events.push({ stage, ok }); },
      runDisruptionCheck: async () => { disruptionCalls += 1; order.push("disruption-check"); },
      restoreHome: (agentIds: string[]) => { restoreHomeCalls.push(agentIds); order.push("restore"); },
      isSlotFired: (slotKey: string) => legacyFlags.has(slotKey),
      claimSlot: (name: string): "claimed" | "exists" => {
        claimCalls.push(name);
        if (control.claimError) throw control.claimError;
        if (claims.has(name)) return "exists";
        claims.add(name);
        return "claimed";
      },
      log: (message: string) => { logs.push(message); },
      checkOverdueRestores: () => { checkOverdueRestoresCalls += 1; },
      markLibraryActive: () => { markLibraryActiveCalls += 1; },
      now: () => currentTime,
    },
  };
}

test("SC-1: entering a configured slot runs all 4 stages in order, then disruption-check", async () => {
  const { runStageCalls, getDisruptionCalls, deps } = makeDispatcherDeps(Date.parse("2026-09-05T04:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.tick();
  expect(runStageCalls.map((c) => c.stage)).toEqual([...PULSE_ANIMA_STAGES]);
  expect(runStageCalls.map((c) => c.agentId)).toEqual(["milo", "cleo", "sam", "bruno"]);
  expect(getDisruptionCalls()).toBe(1);
});

test("SC-P72: tick() restores presence home for all 4 stage-agents exactly once, after every stage and the disruption-check have finished — not per-stage (requirement: agents wait until all agents have finished their work before going back to their rooms)", async () => {
  const { restoreHomeCalls, deps } = makeDispatcherDeps(Date.parse("2026-09-05T04:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.tick();
  expect(restoreHomeCalls).toHaveLength(1);
  expect(restoreHomeCalls[0]).toEqual(["milo", "cleo", "sam", "bruno"]);
});

test("SC-P73: forceTick() also restores presence home for all 4 agents exactly once at the end", async () => {
  const { restoreHomeCalls, deps } = makeDispatcherDeps(Date.parse("2026-09-05T02:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.forceTick();
  expect(restoreHomeCalls).toHaveLength(1);
  expect(restoreHomeCalls[0]).toEqual(["milo", "cleo", "sam", "bruno"]);
});

/** In-memory stand-in for the durable flags store (shared_flags table) —
 *  just enough of setMark/getMark's contract for these tests. */
function makeMarkStore() {
  const presenceCalls: unknown[] = [];
  const flags = new Map<string, string>();
  return {
    presenceCalls,
    store: {
      setPresence: (p: unknown) => { presenceCalls.push(p); },
      setMark: (key: string, value: string, _by: string) => { flags.set(key, value); },
      getMark: (key: string) => (flags.has(key) ? { value: flags.get(key)! } : null),
    },
  };
}

test("SC-P80: scheduleRestoreHomeAfterIdle waits PULSE_ANIMA_IDLE_MS (10 min) before restoring — agents linger after work instead of leaving immediately (requirement: after finishing work they stay around 5-10 min, so nobody leaves the moment they finish)", () => {
  const { presenceCalls, store } = makeMarkStore();
  let capturedFn: (() => void) | undefined;
  let capturedMs: number | undefined;
  scheduleRestoreHomeAfterIdle(store, ["ivan", "dana"], (fn, ms) => {
    capturedFn = fn;
    capturedMs = ms;
  });
  expect(capturedMs).toBe(PULSE_ANIMA_IDLE_MS);
  expect(presenceCalls).toHaveLength(0);
  capturedFn?.();
  expect(presenceCalls).toHaveLength(2);
  expect(presenceCalls[0]).toMatchObject({ agentId: "ivan", placeId: "chamber_ivan" });
  expect(presenceCalls[1]).toMatchObject({ agentId: "dana", placeId: "chamber_dana" });
});

test("SC-P81: PULSE_ANIMA_IDLE_MS is 10 minutes", () => {
  expect(PULSE_ANIMA_IDLE_MS).toBe(10 * 60 * 1000);
});

// ── Durable restore backstop ───────────────────────────────────────────────
// A plain setTimeout does not survive a process restart, which silently
// drops any pending timer. Without a durable backstop, stage-agents could
// stay in library past their 10-minute idle window.

test("SC-P90: scheduleRestoreHomeAfterIdle persists a durable due-flag before the timer fires", () => {
  const { store } = makeMarkStore();
  scheduleRestoreHomeAfterIdle(store, ["ivan", "dana"], () => {}, () => 1_000_000);
  const flag = store.getMark("pulse-anima-restore-due");
  expect(flag).not.toBeNull();
  const parsed = JSON.parse(flag!.value);
  expect(parsed).toEqual({ agentIds: ["ivan", "dana"], dueAt: 1_000_000 + PULSE_ANIMA_IDLE_MS });
});

test("SC-P91: scheduleRestoreHomeAfterIdle clears the due-flag once the in-memory timer actually fires", () => {
  const { store } = makeMarkStore();
  let capturedFn: (() => void) | undefined;
  scheduleRestoreHomeAfterIdle(store, ["ivan"], (fn) => { capturedFn = fn; });
  expect(store.getMark("pulse-anima-restore-due")).not.toBeNull();
  capturedFn?.();
  expect(store.getMark("pulse-anima-restore-due")?.value).toBe("");
});

test("SC-P92: restoreOverdueAgentsHome does nothing when no restore is pending", () => {
  const { presenceCalls, store } = makeMarkStore();
  restoreOverdueAgentsHome(store, () => 1_000_000);
  expect(presenceCalls).toHaveLength(0);
});

test("SC-P93: restoreOverdueAgentsHome does nothing while the pending restore isn't due yet", () => {
  const { presenceCalls, store } = makeMarkStore();
  scheduleRestoreHomeAfterIdle(store, ["ivan"], () => {}, () => 1_000_000);
  restoreOverdueAgentsHome(store, () => 1_000_000 + PULSE_ANIMA_IDLE_MS - 1);
  expect(presenceCalls).toHaveLength(0);
});

test("SC-P94: restoreOverdueAgentsHome restores every pending agent home and consumes the flag once overdue — this is the backstop for a process restart dropping the in-memory timer", () => {
  const { presenceCalls, store } = makeMarkStore();
  scheduleRestoreHomeAfterIdle(store, ["rhea", "cleo", "eli", "hana"], () => { /* simulate restart: never fires */ }, () => 1_000_000);
  restoreOverdueAgentsHome(store, () => 1_000_000 + PULSE_ANIMA_IDLE_MS);
  expect(presenceCalls).toHaveLength(4);
  expect(presenceCalls[0]).toMatchObject({ agentId: "rhea", placeId: "chamber_rhea" });
  expect(presenceCalls[3]).toMatchObject({ agentId: "hana", placeId: "chamber_hana" });
  expect(store.getMark("pulse-anima-restore-due")?.value).toBe("");
  // Calling again after consuming is a no-op, not a double-restore.
  restoreOverdueAgentsHome(store, () => 1_000_000 + PULSE_ANIMA_IDLE_MS + 1);
  expect(presenceCalls).toHaveLength(4);
});

test("SC-P95: PulseAnimaDispatcher.tick() calls checkOverdueRestores unconditionally, even outside a configured slot hour — the backstop must run every dispatch interval, not just on real cycle hours", async () => {
  const { getCheckOverdueRestoresCalls, deps } = makeDispatcherDeps(Date.parse("2026-09-05T02:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.tick();
  expect(getCheckOverdueRestoresCalls()).toBe(1);
});

test("SC-1: ticking again within the same slot does not re-fire", async () => {
  const { runStageCalls, deps } = makeDispatcherDeps(Date.parse("2026-09-05T04:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.tick();
  await dispatcher.tick();
  await dispatcher.tick();
  expect(runStageCalls).toHaveLength(4);
});

test("SC-1: a tick outside any configured hour does nothing", async () => {
  const { runStageCalls, getDisruptionCalls, deps } = makeDispatcherDeps(Date.parse("2026-09-05T02:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.tick();
  expect(runStageCalls).toHaveLength(0);
  expect(getDisruptionCalls()).toBe(0);
});

test("SC-P30: a fresh dispatcher instance sharing the same persisted slot store does NOT re-fire a slot the previous instance already fired (server-restart regression)", async () => {
  const t = Date.parse("2026-09-05T07:00:22-04:00");
  const first = makeDispatcherDeps(t);
  await new PulseAnimaDispatcher(first.deps).tick();
  expect(first.runStageCalls).toHaveLength(4);

  // Simulate a process restart: a brand-new PulseAnimaDispatcher instance
  // (fresh in-memory lastFiredSlotKey, exactly what a redeploy produces),
  // but backed by the SAME persisted claim store.
  const second = makeDispatcherDeps(t + 15 * 60_000, first.claims);
  await new PulseAnimaDispatcher(second.deps).tick();
  expect(second.runStageCalls).toHaveLength(0);
  expect(second.getDisruptionCalls()).toBe(0);
});

test("SC-1: a new configured slot later fires again", async () => {
  const { runStageCalls, setTime, deps } = makeDispatcherDeps(Date.parse("2026-09-05T04:00:00-04:00"));
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.tick();
  setTime(Date.parse("2026-09-05T07:00:00-04:00"));
  await dispatcher.tick();
  expect(runStageCalls).toHaveLength(8);
});

test("SC-P60: forceTick runs all 4 stages + disruption-check regardless of hour or already-fired slot — for on-demand verification without waiting on the wall clock (requirement: verification must not depend on the run time)", async () => {
  const outsideHour = makeDispatcherDeps(Date.parse("2026-09-05T02:00:00-04:00")); // not a configured slot hour
  outsideHour.claims.add("2026-09-05-02");
  const dispatcher = new PulseAnimaDispatcher(outsideHour.deps);
  await dispatcher.forceTick();
  expect(outsideHour.runStageCalls.map((c) => c.stage)).toEqual([...PULSE_ANIMA_STAGES]);
  expect(outsideHour.getDisruptionCalls()).toBe(1);
});

test("SC-P61: forceTick does not mark any slot as fired — a later natural tick() for the real current hour still fires normally", async () => {
  const t = Date.parse("2026-09-05T07:00:22-04:00");
  const { runStageCalls, deps } = makeDispatcherDeps(t);
  const dispatcher = new PulseAnimaDispatcher(deps);
  await dispatcher.forceTick();
  expect(runStageCalls).toHaveLength(4);
  await dispatcher.tick();
  expect(runStageCalls).toHaveLength(8);
});

test("SC-1: stage 2 does not start until stage 1's promise resolves", async () => {
  const order: string[] = [];
  let releaseStage1: (() => void) | undefined;
  const state = { observe: { next: "milo" }, reflect: { next: "cleo" }, dream: { next: "sam" }, integrate: { next: "bruno" } };
  const dispatcher = new PulseAnimaDispatcher({
    readState: () => state,
    runStage: async (stage) => {
      order.push(`start:${stage}`);
      if (stage === "observe") {
        await new Promise<void>((resolve) => { releaseStage1 = resolve; });
      }
      order.push(`end:${stage}`);
      return { exitCode: 0 };
    },
    runPre: async () => ({ exitCode: 0 }),
    runPost: async () => ({ exitCode: 0 }),
    emitStageEvent: async () => {},
    runDisruptionCheck: async () => {},
    restoreHome: () => {},
    isSlotFired: () => false,
    claimSlot: () => "claimed",
    checkOverdueRestores: () => {},
    markLibraryActive: () => {},
    now: () => Date.parse("2026-09-05T04:00:00-04:00"),
  });
  const tickPromise = dispatcher.tick();
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["start:observe"]);
  releaseStage1?.();
  await tickPromise;
  expect(order[0]).toBe("start:observe");
  expect(order[1]).toBe("end:observe");
  expect(order[2]).toBe("start:reflect");
});

// ── Library-active flag ────────────────────────────────────────────────────
// room-scene-dispatcher.ts used to detect "this occupancy is a real
// pulse-anima cycle, not ordinary wandering" by matching the exact agent
// combo against a hardcoded snapshot of the 4 rotations (pulse-anima-ticks.ts).
// Each stage's rotation advances independently, so the 4 rotations drift out
// of phase with each other over time. Once drifted, the real combo no longer
// matches any of the 4 hardcoded tuples, the guard silently fails, and every
// real pulse-anima tick would trigger a paid image generation. The fix:
// PulseAnimaDispatcher marks a live flag for the duration agents are actually
// present in library, instead of guessing from a frozen combo list that can
// drift.

test("SC-PA1: tick() marks the library active before running any stage — the flag room-scene-dispatcher checks instead of guessing from a combo list that can drift", async () => {
  const { deps, getMarkLibraryActiveCalls, runStageCalls } = makeDispatcherDeps(Date.parse("2026-09-05T04:00:00-04:00"));
  const order: string[] = [];
  const withOrder = {
    ...deps,
    markLibraryActive: () => { order.push("marked"); },
    runStage: async (stage: string) => { order.push(`stage:${stage}`); return { exitCode: 0 }; },
  };
  await new PulseAnimaDispatcher(withOrder).tick();
  expect(order[0]).toBe("marked");
  expect(order.slice(1)).toEqual([...PULSE_ANIMA_STAGES].map((s) => `stage:${s}`));
});

test("SC-PA2: forceTick() also marks the library active before running any stage", async () => {
  const { deps } = makeDispatcherDeps(Date.parse("2026-09-05T02:00:00-04:00"));
  const order: string[] = [];
  const withOrder = {
    ...deps,
    markLibraryActive: () => { order.push("marked"); },
    runStage: async (stage: string) => { order.push(`stage:${stage}`); return { exitCode: 0 }; },
  };
  await new PulseAnimaDispatcher(withOrder).forceTick();
  expect(order[0]).toBe("marked");
});

test("SC-PA3: scheduleRestoreHomeAfterIdle clears the library-active flag only once the idle timer actually fires (agents genuinely leave), not before", () => {
  const { store } = makeMarkStore();
  store.setMark(LIBRARY_ACTIVE_FLAG, "1", "test");
  let capturedFn: (() => void) | undefined;
  scheduleRestoreHomeAfterIdle(store, ["ivan"], (fn) => { capturedFn = fn; });
  expect(store.getMark(LIBRARY_ACTIVE_FLAG)?.value).toBe("1");
  capturedFn?.();
  expect(store.getMark(LIBRARY_ACTIVE_FLAG)?.value).toBe("");
});

test("SC-PA4: restoreOverdueAgentsHome also clears the library-active flag when it fires the durable backstop restore", () => {
  const { store } = makeMarkStore();
  store.setMark(LIBRARY_ACTIVE_FLAG, "1", "test");
  scheduleRestoreHomeAfterIdle(store, ["rhea"], () => {}, () => 1_000_000);
  restoreOverdueAgentsHome(store, () => 1_000_000 + PULSE_ANIMA_IDLE_MS);
  expect(store.getMark(LIBRARY_ACTIVE_FLAG)?.value).toBe("");
});

test("isLibraryActive reads the flag directly — true only when the stored value is exactly \"1\"", () => {
  const { store } = makeMarkStore();
  expect(isLibraryActive(store)).toBe(false);
  store.setMark(LIBRARY_ACTIVE_FLAG, "1", "test");
  expect(isLibraryActive(store)).toBe(true);
  store.setMark(LIBRARY_ACTIVE_FLAG, "", "test");
  expect(isLibraryActive(store)).toBe(false);
});

// ── Restore to where the agent WAS, not always home (castle-presence-persistence) ──
// The restore must not put every stage-agent at chamber_<agent>
// unconditionally, which erases wander/meeting spots.

test("SC-PP1: scheduleRestoreHomeAfterIdle restores each agent to its pre-pulse place when one was snapshotted; unknown agents still fall back to their own chamber", () => {
  const { presenceCalls, store } = makeMarkStore();
  let capturedFn: (() => void) | undefined;
  scheduleRestoreHomeAfterIdle(store, ["ivan", "dana"], (fn) => { capturedFn = fn; }, () => 1_000_000, { ivan: "hall_main" });
  capturedFn?.();
  expect(presenceCalls[0]).toMatchObject({ agentId: "ivan", placeId: "hall_main" });
  expect(presenceCalls[1]).toMatchObject({ agentId: "dana", placeId: "chamber_dana" });
});

test("SC-PP2: the durable flag carries the snapshot, so restoreOverdueAgentsHome (the restart backstop) also restores to the pre-pulse place", () => {
  const { presenceCalls, store } = makeMarkStore();
  scheduleRestoreHomeAfterIdle(store, ["rhea", "hana"], () => {}, () => 1_000_000, { rhea: "gate_machine" });
  const parsed = JSON.parse(store.getMark("pulse-anima-restore-due")!.value);
  expect(parsed.priorPlaces).toEqual({ rhea: "gate_machine" });
  restoreOverdueAgentsHome(store, () => 1_000_000 + PULSE_ANIMA_IDLE_MS);
  expect(presenceCalls[0]).toMatchObject({ agentId: "rhea", placeId: "gate_machine" });
  expect(presenceCalls[1]).toMatchObject({ agentId: "hana", placeId: "chamber_hana" });
});

test("SC-PP3: tick() snapshots the stage-agents' places BEFORE any stage runs, and hands the snapshot to restoreHome", async () => {
  const { runStageCalls, restoreHomeArgs, deps } = makeSnapshotDispatcherDeps(Date.parse("2026-09-05T04:00:00-04:00"));
  await new PulseAnimaDispatcher(deps).tick();
  expect(restoreHomeArgs).toHaveLength(1);
  expect(restoreHomeArgs[0].priorPlaces).toEqual({ milo: "hall_main", cleo: "workshop" });
  // Snapshot was taken while nobody had been moved to library yet.
  expect(deps.snapshotCallsBeforeFirstStage()).toBe(true);
  expect(runStageCalls).toHaveLength(4);
});

test("SC-PP4: forceTick() also snapshots before the stages and passes it to restoreHome", async () => {
  const { restoreHomeArgs, deps } = makeSnapshotDispatcherDeps(Date.parse("2026-09-05T02:00:00-04:00"));
  await new PulseAnimaDispatcher(deps).forceTick();
  expect(restoreHomeArgs[0].priorPlaces).toEqual({ milo: "hall_main", cleo: "workshop" });
  expect(deps.snapshotCallsBeforeFirstStage()).toBe(true);
});

test("SC-PP5: snapshotPriorPlaces keeps real places, and skips agents with no presence row or who are still in an un-restored pulse-library state (a stale snapshot would just re-trap them in library)", () => {
  const rows: Record<string, { placeId: string; activity?: string } | null> = {
    a: { placeId: "hall_main" },
    b: { placeId: "library", activity: "pulse:observe" },
    c: null,
    d: { placeId: "library" }, // chose the library on its own — a real place
  };
  const got = snapshotPriorPlaces({ getPresence: (id: string) => rows[id] ?? null }, ["a", "b", "c", "d"]);
  expect(got).toEqual({ a: "hall_main", d: "library" });
});

function makeSnapshotDispatcherDeps(nowMs: number) {
  const base = makeDispatcherDeps(nowMs);
  const restoreHomeArgs: Array<{ agentIds: string[]; priorPlaces?: Record<string, string> }> = [];
  let stagesRunWhenSnapshotTaken = -1;
  const deps = {
    ...base.deps,
    snapshotPlaces: (_ids: string[]) => {
      stagesRunWhenSnapshotTaken = base.runStageCalls.length;
      return { milo: "hall_main", cleo: "workshop" };
    },
    restoreHome: (agentIds: string[], priorPlaces?: Record<string, string>) => { restoreHomeArgs.push({ agentIds, priorPlaces }); },
    snapshotCallsBeforeFirstStage: () => stagesRunWhenSnapshotTaken === 0,
  };
  return { runStageCalls: base.runStageCalls, restoreHomeArgs, deps };
}

// ── pulse-single-owner: one owner per slot ──────────────────────────────────

const SLOT_10 = Date.parse("2026-10-22T10:05:00-04:00");
const FULL_ORDER = ["pre", "observe", "reflect", "dream", "integrate", "disruption-check", "post", "restore"];

test("PO-5: runPulseAnimaStage returns the script's exit code", async () => {
  const ok = makeDeps({ runScript: async () => ({ exitCode: 0 }) });
  expect(await runPulseAnimaStage("observe", "milo", ok.deps)).toEqual({ exitCode: 0 });
  const failed = makeDeps({ runScript: async () => ({ exitCode: 1 }) });
  expect(await runPulseAnimaStage("observe", "milo", failed.deps)).toEqual({ exitCode: 1 });
});

test("PO-5: after each stage the dispatcher emits one event: ok on exit 0, failed on a non-zero exit or a throw", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.control.stageExit.reflect = 1;
  t.control.stageThrow.add("dream");
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.events).toEqual([
    { stage: "observe", ok: true },
    { stage: "reflect", ok: false },
    { stage: "dream", ok: false },
    { stage: "integrate", ok: true },
  ]);
});

test("PO-5: a failing event emit is logged and does not stop the sequence", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  const deps = { ...t.deps, emitStageEvent: async () => { throw new Error("hub down"); } };
  await new PulseAnimaDispatcher(deps).tick();
  expect(t.order).toEqual(FULL_ORDER);
  expect(t.logs.length).toBeGreaterThan(0);
});

test("regression: two ticks in one slot run each stage once, not twice — PO-4: the claim is named by local date and slot hour, zero-padded", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  const dispatcher = new PulseAnimaDispatcher(t.deps);
  await dispatcher.tick();
  t.setTime(SLOT_10 + 5 * 60_000);
  await dispatcher.tick();
  expect(t.claimCalls).toEqual(["2026-10-22-10", "2026-10-22-10"]);
  expect(t.order.filter((step) => step === "pre")).toHaveLength(1);
  expect(t.runStageCalls).toHaveLength(4);
});

test("PO-4: a single-digit month and hour are zero-padded in the claim name", async () => {
  const t = makeDispatcherDeps(Date.parse("2026-03-05T04:00:00-05:00"));
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.claimCalls[0]).toMatch(/^2026-03-05-0[34]$/);
});

test("PO-4: a claim error other than 'exists' is logged once and starts no work", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.control.claimError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.order).toEqual([]);
  expect(t.logs).toHaveLength(1);
});

test("PO-4: outside a slot hour no claim is made and nothing runs", async () => {
  const t = makeDispatcherDeps(Date.parse("2026-10-22T09:30:00-04:00"));
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.claimCalls).toEqual([]);
  expect(t.order).toEqual([]);
});

test("PO-8: the legacy zero-based-month DB mark makes tick() create the claim and run nothing", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.legacyFlags.add("2026-9-22-10"); // October is month index 9 in the old key
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.claims.has("2026-10-22-10")).toBe(true);
  expect(t.order).toEqual([]);
});

test("PO-1: tick() runs pre, the four stages, the disruption check, post, then the restore, each once", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.order).toEqual(FULL_ORDER);
});

test("PO-2: forceTick() runs the same sequence with an existing claim and neither reads nor creates a claim", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.claims.add("2026-10-22-10");
  t.legacyFlags.add("2026-9-22-10");
  await new PulseAnimaDispatcher(t.deps).forceTick();
  expect(t.order).toEqual(FULL_ORDER);
  expect(t.claimCalls).toEqual([]);
  expect([...t.claims]).toEqual(["2026-10-22-10"]);
});

test("PO-3: a pre that throws is logged and the stages, disruption check, post and restore still run", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.control.preError = new Error("pre exploded");
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.order).toEqual(FULL_ORDER);
  expect(t.logs).toHaveLength(1);
});

test("PO-3: a stage that throws is logged and the later stages, disruption check, post and restore still run", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.control.stageThrow.add("dream");
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.order).toEqual(FULL_ORDER);
});

test("PO-3: a post that throws does not skip the restore", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  t.control.postError = new Error("post exploded");
  await new PulseAnimaDispatcher(t.deps).tick();
  expect(t.order).toEqual(FULL_ORDER);
});

test("PO-3: a non-zero exit from pre or post is logged and the sequence continues", async () => {
  const t = makeDispatcherDeps(SLOT_10);
  const deps = { ...t.deps, runPre: async () => { t.order.push("pre"); return { exitCode: 3 }; } };
  await new PulseAnimaDispatcher(deps).tick();
  expect(t.order).toEqual(FULL_ORDER);
  expect(t.logs).toHaveLength(1);
});

test("PO-4: createSlotClaimer makes .slots and the leaf on a fresh directory, reports 'exists' the second time, and throws on other errors", () => {
  const claim = dispatcherModule.createSlotClaimer(tmpDir);
  expect(claim("2026-10-22-10")).toBe("claimed");
  expect(existsSync(join(tmpDir, ".slots", "2026-10-22-10"))).toBe(true);
  expect(claim("2026-10-22-10")).toBe("exists");
  writeFileSync(join(tmpDir, "not-a-dir"), "");
  const blocked = dispatcherModule.createSlotClaimer(join(tmpDir, "not-a-dir"));
  expect(() => blocked("2026-10-22-10")).toThrow();
});

test("PO-6: runShellScript passes several arguments to the script", async () => {
  writeFileSync(join(tmpDir, "echo-args.sh"), 'echo "$1 $2" > "$PULSE_DIR/args.txt"\n');
  const result = await dispatcherModule.runShellScript(tmpDir, tmpDir, "echo-args.sh", "observe", "failed");
  expect(result).toEqual({ exitCode: 0 });
  expect(readFileSync(join(tmpDir, "args.txt"), "utf8").trim()).toBe("observe failed");
});
