import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRoomLogEntries, createRoomLogStream } from "./castle-room-log";
import type { GardenEvent } from "../../../garden/events";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "anima-room-log-"));
  mkdirSync(join(tmpDir, "_shared", "garden"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvent(event: GardenEvent): void {
  writeFileSync(join(tmpDir, "_shared", "garden", "events.jsonl"), JSON.stringify(event) + "\n", { flag: "a" });
}

const baseEvent = {
  timestamp: new Date("2026-09-03T00:00:00Z").toISOString(),
  instanceId: "bruno",
  runtime: "hub" as const,
  project: "castle",
};

function moved(id: string, agentId: string, from: string, to: string): GardenEvent {
  return { ...baseEvent, id, type: "AGENT_MOVED", agentId, payload: { from, to, disposition: "wander", seed: 1 } };
}

function convened(id: string, agentId: string, meetingId: string, placeId: string): GardenEvent {
  return { ...baseEvent, id, type: "MEETING_CONVENED", agentId, payload: { meetingId, placeId, topic: "t" } };
}

function joined(id: string, agentId: string, meetingId: string): GardenEvent {
  return { ...baseEvent, id, type: "MEETING_JOINED", agentId, payload: { meetingId } };
}

function turn(id: string, agentId: string, meetingId: string, text: string): GardenEvent {
  return { ...baseEvent, id, type: "MEETING_TURN", agentId, payload: { meetingId, text } };
}

function closed(id: string, agentId: string, meetingId: string, topic: string): GardenEvent {
  return { ...baseEvent, id, type: "MEETING_CLOSED", agentId, payload: { meetingId, topic } };
}

function pulseStarted(id: string, agentId: string, stage: string): GardenEvent {
  return { ...baseEvent, id, type: "PULSE_STAGE_STARTED", agentId, payload: { stage } };
}

function encounter(id: string, agentId: string, encounterId: string, agents: string[], place: string): GardenEvent {
  return { ...baseEvent, id, type: "ENCOUNTER", agentId, payload: { encounterId, agents, place } };
}

function encounterLine(id: string, agentId: string, encounterId: string, text: string): GardenEvent {
  return { ...baseEvent, id, type: "ENCOUNTER_LINE", agentId, payload: { encounterId, text } };
}

function pulseCompleted(id: string, agentId: string, stage: string, text: string): GardenEvent {
  return { ...baseEvent, id, type: "PULSE_STAGE_COMPLETED", agentId, payload: { stage, text } };
}

test("SC-1: AGENT_MOVED into the room becomes an entered event with no agentName", () => {
  const entries = buildRoomLogEntries([moved("e1", "bruno", "chamber_bruno", "hall_main")], "hall_main");
  expect(entries).toHaveLength(1);
  expect(entries[0].agentName).toBeUndefined();
  expect(entries[0].content).toContain("bruno");
  expect(entries[0].content.toLowerCase()).toContain("entered");
});

test("SC-2: AGENT_MOVED out of the room becomes a left event", () => {
  const entries = buildRoomLogEntries([moved("e1", "bruno", "hall_main", "chamber_bruno")], "hall_main");
  expect(entries).toHaveLength(1);
  expect(entries[0].content.toLowerCase()).toContain("left");
});

test("SC-3: MEETING_TURN carries the real spoken text scoped to the meeting's room", () => {
  const events = [
    convened("e1", "bruno", "m1", "hall_main"),
    turn("e2", "bruno", "m1", "hello eli"),
  ];
  const entries = buildRoomLogEntries(events, "hall_main");
  const turnEntry = entries.find((e) => e.content === "hello eli");
  expect(turnEntry).toBeDefined();
  expect(turnEntry?.agentName).toBe("bruno");
});

test("SC-4: MEETING_JOINED and MEETING_CLOSED resolve to the convened meeting's room even without their own placeId", () => {
  const events = [
    convened("e1", "bruno", "m1", "hall_main"),
    joined("e2", "eli", "m1"),
    closed("e3", "bruno", "m1", "philosophy"),
  ];
  const entries = buildRoomLogEntries(events, "hall_main");
  expect(entries.some((e) => e.content.toLowerCase().includes("eli") && e.content.toLowerCase().includes("joined"))).toBe(true);
  expect(entries.some((e) => e.content.toLowerCase().includes("ended"))).toBe(true);
});

test("SC-5: events for a different room are excluded entirely", () => {
  const events = [
    moved("e1", "bruno", "chamber_bruno", "workshop"),
    convened("e2", "eli", "m1", "workshop"),
    turn("e3", "eli", "m1", "should not appear"),
  ];
  const entries = buildRoomLogEntries(events, "hall_main");
  expect(entries).toHaveLength(0);
});

test("SC-6: two meetings in different rooms are not cross-contaminated", () => {
  const events = [
    convened("e1", "bruno", "m1", "hall_main"),
    convened("e2", "lena", "m2", "workshop"),
    turn("e3", "bruno", "m1", "hall talk"),
    turn("e4", "lena", "m2", "workshop talk"),
  ];
  const hallEntries = buildRoomLogEntries(events, "hall_main");
  const workshopEntries = buildRoomLogEntries(events, "workshop");
  expect(hallEntries.some((e) => e.content === "hall talk")).toBe(true);
  expect(hallEntries.some((e) => e.content === "workshop talk")).toBe(false);
  expect(workshopEntries.some((e) => e.content === "workshop talk")).toBe(true);
  expect(workshopEntries.some((e) => e.content === "hall talk")).toBe(false);
});

// ── SSE stream ──────────────────────────────────────────────────────────────

test("SC-P10: PULSE_STAGE_STARTED for library becomes a light entry with no agentName", () => {
  const entries = buildRoomLogEntries([pulseStarted("e1", "rhea", "observe")], "library");
  expect(entries).toHaveLength(1);
  expect(entries[0].agentName).toBeUndefined();
  expect(entries[0].content).toContain("rhea");
  expect(entries[0].content).toContain("observe");
});

test("SC-P11: PULSE_STAGE_COMPLETED for library carries the real produced text", () => {
  const entries = buildRoomLogEntries([pulseCompleted("e1", "rhea", "observe", "real bridge output")], "library");
  expect(entries).toHaveLength(1);
  expect(entries[0].agentName).toBe("rhea");
  expect(entries[0].content).toBe("real bridge output");
});

test("SC-P12: pulse-anima events are excluded for any room other than library", () => {
  const events = [pulseStarted("e1", "rhea", "observe"), pulseCompleted("e2", "rhea", "observe", "output")];
  expect(buildRoomLogEntries(events, "hall_main")).toHaveLength(0);
  expect(buildRoomLogEntries(events, "workshop")).toHaveLength(0);
});

test("SC-E1: ENCOUNTER for this room becomes a light entry naming both agents, scoped by its own place field", () => {
  const entries = buildRoomLogEntries([encounter("e1", "bruno", "enc-1", ["bruno", "lena"], "hall_main")], "hall_main");
  expect(entries).toHaveLength(1);
  expect(entries[0].agentName).toBeUndefined();
  expect(entries[0].content).toContain("bruno");
  expect(entries[0].content).toContain("lena");
});

test("SC-E2: ENCOUNTER_LINE carries the real exchanged text, resolved to its room via encounterId (no placeId of its own)", () => {
  const events = [
    encounter("e1", "bruno", "enc-1", ["bruno", "lena"], "hall_main"),
    encounterLine("e2", "lena", "enc-1", "hey bruno, been a while"),
  ];
  const entries = buildRoomLogEntries(events, "hall_main");
  const line = entries.find((e) => e.content === "hey bruno, been a while");
  expect(line).toBeDefined();
  expect(line?.agentName).toBe("lena");
});

test("SC-E3: an encounter in a different room is excluded, including its line", () => {
  const events = [
    encounter("e1", "bruno", "enc-1", ["bruno", "lena"], "workshop"),
    encounterLine("e2", "lena", "enc-1", "should not appear in hall_main"),
  ];
  const entries = buildRoomLogEntries(events, "hall_main");
  expect(entries).toHaveLength(0);
});

test("SC-7: createRoomLogStream backfills only entries scoped to placeId", async () => {
  writeEvent(moved("e1", "bruno", "chamber_bruno", "hall_main"));
  writeEvent(moved("e2", "lena", "chamber_lena", "workshop"));

  const stream = createRoomLogStream({ roomsDir: tmpDir, placeId: "hall_main", pollMs: 30 });
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.cancel();

  const text = new TextDecoder().decode(value);
  const parsed = JSON.parse(text.replace("data: ", "").trim());
  expect(parsed.entry.content).toContain("bruno");
});

test("SC-8: createRoomLogStream emits new scoped entries appended after stream opens", async () => {
  const stream = createRoomLogStream({ roomsDir: tmpDir, placeId: "hall_main", pollMs: 30 });
  const reader = stream.getReader();

  setTimeout(() => {
    writeEvent(moved("e-later", "eli", "chamber_eli", "hall_main"));
  }, 60);

  const { value } = await reader.read();
  reader.cancel();
  const text = new TextDecoder().decode(value);
  const parsed = JSON.parse(text.replace("data: ", "").trim());
  expect(parsed.entry.content).toContain("eli");
});

// castle-presence-persistence, C: a room sprite can stand for more than one
// place (Bridge = gate_world + gate_machine). The room log
// must show what happened at EITHER of them — otherwise the map lights up for
// an agent the room then claims never visited.

test("SC-C1: a room spanning two places logs events from both, and only those", () => {
  const events = [
    moved("e1", "cleo", "chamber_cleo", "gate_machine"),
    moved("e2", "ivan", "chamber_ivan", "gate_world"),
    encounter("e3", "cleo", "x1", ["cleo", "ivan"], "gate_machine"),
    encounterLine("e4", "cleo", "x1", "the gate hums"),
    moved("e5", "eli", "chamber_eli", "library"),
  ];
  const entries = buildRoomLogEntries(events, ["gate_world", "gate_machine"]);
  const text = entries.map((e) => e.content).join(" | ");
  expect(text).toContain("cleo entered the room");
  expect(text).toContain("ivan entered the room");
  expect(text).toContain("crossed paths here");
  expect(text).toContain("the gate hums");
  expect(text).not.toContain("eli");
});

test("SC-C2: a single placeId still behaves exactly as before", () => {
  const events = [
    moved("e1", "cleo", "chamber_cleo", "gate_machine"),
    moved("e2", "ivan", "chamber_ivan", "gate_world"),
  ];
  const single = buildRoomLogEntries(events, "gate_world");
  expect(single).toHaveLength(1);
  expect(single[0].content).toContain("ivan");
});

test("SC-P40: a raw event irrelevant to this room (produces no compiled entry) does not re-trigger a full backfill replay on the next poll (regression: 'lastEventId not found in compiled → slice(0)' re-sent every entry every poll tick)", async () => {
  writeEvent(moved("e1", "bruno", "chamber_bruno", "hall_main"));

  const stream = createRoomLogStream({ roomsDir: tmpDir, placeId: "hall_main", pollMs: 30 });
  const reader = stream.getReader();
  // Drain the backfill frame for e1.
  await reader.read();

  // An event for a totally unrelated room+type — produces NO compiled entry
  // for hall_main. This becomes the new "last raw event" the stream must
  // track past, without re-emitting e1's already-sent entry.
  writeEvent({ ...baseEvent, id: "e-irrelevant", type: "AGENT_MOVED", agentId: "finn", payload: { from: "workshop", to: "workshop", disposition: "wander", seed: 1 } });

  const seen: string[] = [];
  const collectPromise = (async () => {
    for (let i = 0; i < 3; i++) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 150)),
      ]);
      if (done || !value) break;
      seen.push(new TextDecoder().decode(value));
    }
  })();
  await collectPromise;
  reader.cancel();

  // The bug re-sent "bruno entered the room" on every poll after e1. Correct
  // behavior: nothing new to send (the only new raw event has no entry).
  expect(seen).toHaveLength(0);
});
