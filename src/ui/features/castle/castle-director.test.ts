import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventToVnPayload } from "./castle-director";
import { createCastleFeedStream } from "./castle-feed";
import type { GardenEvent } from "../../../garden/events";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "anima-castle-feed-"));
  mkdirSync(join(tmpDir, "_shared", "garden"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseEvent = {
  id: "evt-1",
  timestamp: new Date("2026-07-08T00:00:00Z").toISOString(),
  instanceId: "bruno",
  runtime: "hub" as const,
  project: "castle",
};

test("SC-031: AGENT_MOVED to hall_main maps to VN payload with scene + character enter", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 42 },
  };
  const payload = eventToVnPayload(event);
  expect(payload).not.toBeNull();
  expect(payload?.scene).toBe("hall_main");
  expect(payload?.transition).toBe("fade");
  expect(payload?.characters?.length).toBe(1);
  expect(payload?.characters?.[0]).toMatchObject({
    agentId: "bruno",
    action: "enter",
  });
});

test("SC-032: AGENT_MOVED to chamber maps with same shape", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "AGENT_MOVED",
    agentId: "lena",
    payload: { from: "hall_main", to: "chamber_lena", disposition: "home", seed: 7 },
  };
  const payload = eventToVnPayload(event);
  expect(payload?.scene).toBe("chamber_lena");
  expect(payload?.characters?.[0]?.agentId).toBe("lena");
});

test("SC-033: zero-distance move emits no payload (from===to)", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "garden", to: "garden", disposition: "wander", seed: 1 },
  };
  expect(eventToVnPayload(event)).toBeNull();
});

test("non-AGENT_MOVED event returns null", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "TASK_STARTED",
    agentId: "bruno",
    payload: { name: "test" },
  };
  expect(eventToVnPayload(event)).toBeNull();
});

// ── SSE feed ────────────────────────────────────────────────────────────────

function writeEvent(event: GardenEvent): void {
  const line = JSON.stringify(event) + "\n";
  writeFileSync(join(tmpDir, "_shared", "garden", "events.jsonl"), line, { flag: "a" });
}

test("SC-029: createCastleFeedStream emits SSE frames for existing AGENT_MOVED events", async () => {
  writeEvent({
    ...baseEvent,
    id: "e1",
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 1 },
  });

  const stream = createCastleFeedStream({ roomsDir: tmpDir, pollMs: 50 });
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.cancel();

  const text = new TextDecoder().decode(value);
  expect(text).toContain("data: ");
  const parsed = JSON.parse(text.replace("data: ", "").trim());
  // First frame of a move is the exit from the source place.
  expect(parsed.id).toBe("e1");
  expect(parsed.payload.scene).toBe("chamber_bruno");
  expect(parsed.payload.characters?.[0]?.action).toBe("exit");
});

test("SC-030: feed emits new events appended after stream opens", async () => {
  writeEvent({
    ...baseEvent,
    id: "e1",
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 1 },
  });

  const stream = createCastleFeedStream({ roomsDir: tmpDir, pollMs: 30 });
  const reader = stream.getReader();
  // Drain the backfill frames first (exit + enter for e1).
  await reader.read();
  await reader.read();

  // Append a new event
  setTimeout(() => {
    writeEvent({
      ...baseEvent,
      id: "e2",
      type: "AGENT_MOVED",
      agentId: "lena",
      payload: { from: "hall_main", to: "garden", disposition: "wander", seed: 2 },
    });
  }, 60);

  const { value } = await reader.read();
  reader.cancel();
  const text = new TextDecoder().decode(value);
  const parsed = JSON.parse(text.replace("data: ", "").trim());
  // First frame of e2 is the exit from hall_main.
  expect(parsed.id).toBe("e2");
  expect(parsed.payload.scene).toBe("hall_main");
  expect(parsed.payload.characters?.[0]?.action).toBe("exit");
});

test("SC-033b: feed skips zero-distance moves", async () => {
  writeEvent({
    ...baseEvent,
    id: "e-zero",
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "garden", to: "garden", disposition: "wander", seed: 1 },
  });

  const stream = createCastleFeedStream({ roomsDir: tmpDir, pollMs: 50 });
  const reader = stream.getReader();
  const readPromise = reader.read();
  let emitted = false;
  readPromise.then(() => { emitted = true; });
  await new Promise((r) => setTimeout(r, 120));
  reader.cancel();
  expect(emitted).toBe(false);
});

// ── castle-social-places-movement: feed ?since= + exit/enter pair ────────
import { eventToVnPayloads } from "./castle-director";

// SC-004: a move from hall_main to chamber_milo must compile to TWO payloads —
// an exit from hall_main, then an enter into chamber_milo.
test("SC-004: AGENT_MOVED compiles to exit-from + enter-to payloads", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "AGENT_MOVED",
    agentId: "milo",
    payload: { from: "hall_main", to: "chamber_milo", disposition: "home", seed: 7 },
  };
  const payloads = eventToVnPayloads(event);
  expect(payloads.length).toBe(2);
  // First frame: exit from the source place.
  expect(payloads[0].scene).toBe("hall_main");
  expect(payloads[0].characters?.[0]).toMatchObject({
    agentId: "milo",
    action: "exit",
  });
  // Second frame: enter into the destination place.
  expect(payloads[1].scene).toBe("chamber_milo");
  expect(payloads[1].characters?.[0]).toMatchObject({
    agentId: "milo",
    action: "enter",
  });
});

// SC-005: zero-distance move emits zero payloads (eventToVnPayloads mirror).
test("SC-005: zero-distance move emits zero payloads", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "garden", to: "garden", disposition: "wander", seed: 1 },
  };
  expect(eventToVnPayloads(event)).toEqual([]);
});

// SC-003: single-move still compiles to [exit, enter] (exit frame carries the
// source scene so the client can animate the departure).
test("SC-003: move compiles to exit-then-enter with the source scene first", () => {
  const event: GardenEvent = {
    ...baseEvent,
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 42 },
  };
  const payloads = eventToVnPayloads(event);
  expect(payloads[0].scene).toBe("chamber_bruno");
  expect(payloads[0].characters?.[0]?.action).toBe("exit");
  expect(payloads[1].scene).toBe("hall_main");
  expect(payloads[1].characters?.[0]?.action).toBe("enter");
});

// SC-006: ?since=<id> filters out events with id <= since.
test("SC-006: feed with since skips events at or before the since id", async () => {
  writeEvent({
    ...baseEvent,
    id: "since-1",
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 1 },
  });
  writeEvent({
    ...baseEvent,
    id: "since-2",
    type: "AGENT_MOVED",
    agentId: "lena",
    payload: { from: "hall_main", to: "garden", disposition: "wander", seed: 2 },
  });

  // since=since-1 must skip since-1 (id <= since) and emit since-2 only.
  const stream = createCastleFeedStream({ roomsDir: tmpDir, since: "since-1", pollMs: 50 });
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.cancel();
  const text = new TextDecoder().decode(value);
  const parsed = JSON.parse(text.replace("data: ", "").trim());
  expect(parsed.id).toBe("since-2");
  // First frame of since-2 is the exit from hall_main (its source place).
  expect(parsed.payload.scene).toBe("hall_main");
  expect(parsed.payload.characters?.[0]?.action).toBe("exit");
});

// SC-007: no since → backfill the most recent events (live tail + recent history).
test("SC-007: feed without since backfills recent history", async () => {
  writeEvent({
    ...baseEvent,
    id: "no-since-1",
    type: "AGENT_MOVED",
    agentId: "bruno",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 1 },
  });

  const stream = createCastleFeedStream({ roomsDir: tmpDir, pollMs: 50 });
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.cancel();
  const text = new TextDecoder().decode(value);
  const parsed = JSON.parse(text.replace("data: ", "").trim());
  // Without since, the first backfilled event is the most recent move.
  expect(parsed.id).toBe("no-since-1");
});

// ── castle-social-meetings: MEETING_* director mappings ──────────────────
import { createGardenEvent } from "../../../garden/events";

function meetingEvent(type: any, payload: Record<string, unknown>, agentId = "lena") {
  return createGardenEvent({
    id: `t-${type}-${Math.random()}`,
    type,
    timestamp: "2026-07-12T00:00:00.000Z",
    agentId,
    instanceId: "test",
    runtime: "test",
    project: "castle",
    payload,
  });
}

// SC-038: MEETING_JOINED → staging at meeting place
test("SC-038: MEETING_JOINED stages agent into meeting place", () => {
  const e = meetingEvent("MEETING_JOINED", { meetingId: "m-1", placeId: "hall_main" });
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.scene).toBe("hall_main");
  expect(p!.characters?.[0]?.agentId).toBe("lena");
  expect(p!.characters?.[0]?.action).toBe("enter");
});

// SC-039: MEETING_TURN → dialogue with text + speakerId
test("SC-039: MEETING_TURN compiles to dialogue payload", () => {
  const e = meetingEvent("MEETING_TURN", { meetingId: "m-1", text: "the deploy is blocked" }, "sam");
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.text).toBe("the deploy is blocked");
  expect(p!.speakerId).toBe("sam");
});

// SC-040: MEETING_CLOSED → closing narration
test("SC-040: MEETING_CLOSED compiles to closing text", () => {
  const e = meetingEvent("MEETING_CLOSED", { meetingId: "m-1", topic: "blocker-sync" });
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.text.length).toBeGreaterThan(0);
});

// SC-040b: MEETING_CONVENED also stages (same as joined)
test("SC-040b: MEETING_CONVENED stages convener", () => {
  const e = meetingEvent("MEETING_CONVENED", { meetingId: "m-1", placeId: "hall_main" });
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.scene).toBe("hall_main");
});

// ── castle-social-encounters: ENCOUNTER director mappings ────────────────
// SC-014: ENCOUNTER stages two characters at the place
test("SC-014: ENCOUNTER stages two characters", () => {
  const e = meetingEvent("ENCOUNTER", { encounterId: "e-1", agents: ["bruno", "lena"], place: "garden" });
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.scene).toBe("garden");
  expect(p!.characters?.length).toBe(2);
  expect(p!.characters?.map((c) => c.agentId).sort()).toEqual(["bruno", "lena"]);
});

// SC-015: ENCOUNTER_LINE compiles to dialogue
test("SC-015: ENCOUNTER_LINE compiles to dialogue", () => {
  const e = meetingEvent("ENCOUNTER_LINE", { encounterId: "e-1", text: "oh, hey" }, "lena");
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.text).toBe("oh, hey");
  expect(p!.speakerId).toBe("lena");
});

// ── castle-social-expeditions: DISCOVERY director mapping ────────────────
// SC-024: DISCOVERY compiles to a non-empty discovery-card with the
// discovering agent as speaker.
test("SC-024: DISCOVERY compiles to a discovery card", () => {
  const e = meetingEvent(
    "DISCOVERY",
    { expeditionId: "e-1", summary: "the cron job is dangling — last run 9 days ago" },
    "lena",
  );
  const p = eventToVnPayload(e);
  expect(p).not.toBeNull();
  expect(p!.text).toBe("the cron job is dangling — last run 9 days ago");
  expect(p!.speakerId).toBe("lena");
});
