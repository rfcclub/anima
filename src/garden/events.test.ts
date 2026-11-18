import { test, expect } from "bun:test";
import { createGardenEvent, validateGardenEvent, type GardenEvent } from "./events";

const baseInput = {
  id: "evt-1",
  timestamp: new Date("2026-07-08T00:00:00Z").toISOString(),
  agentId: "bruno",
  instanceId: "bruno",
  runtime: "hub" as const,
  project: "castle",
};

test("AGENT_MOVED is a valid GardenEventType", () => {
  const event: GardenEvent = {
    ...baseInput,
    type: "AGENT_MOVED",
    payload: { from: "chamber_bruno", to: "hall_main", disposition: "wander", seed: 42 },
  };
  expect(() => validateGardenEvent(event)).not.toThrow();
  const created = createGardenEvent(event);
  expect(created.type).toBe("AGENT_MOVED");
});

test("SC-026: validation succeeds with full payload", () => {
  const event: GardenEvent = {
    ...baseInput,
    type: "AGENT_MOVED",
    payload: { from: "chamber_bruno", to: "garden", disposition: "wander", seed: 100 },
  };
  expect(() => validateGardenEvent(event)).not.toThrow();
});

test("SC-P01: PULSE_STAGE_STARTED is a valid GardenEventType", () => {
  const event: GardenEvent = {
    ...baseInput,
    type: "PULSE_STAGE_STARTED",
    payload: { stage: "observe" },
  };
  expect(() => validateGardenEvent(event)).not.toThrow();
  expect(createGardenEvent(event).type).toBe("PULSE_STAGE_STARTED");
});

test("SC-P02: PULSE_STAGE_COMPLETED is a valid GardenEventType", () => {
  const event: GardenEvent = {
    ...baseInput,
    type: "PULSE_STAGE_COMPLETED",
    payload: { stage: "observe", text: "real output" },
  };
  expect(() => validateGardenEvent(event)).not.toThrow();
  expect(createGardenEvent(event).type).toBe("PULSE_STAGE_COMPLETED");
});

test("SC-027: validation fails when payload missing to", () => {
  const event = {
    ...baseInput,
    type: "AGENT_MOVED",
    payload: { from: "chamber_bruno", disposition: "wander", seed: 42 },
  };
  expect(() => validateGardenEvent(event as unknown as GardenEvent)).toThrow();
});

test("SC-027b: validation fails when payload missing seed", () => {
  const event = {
    ...baseInput,
    type: "AGENT_MOVED",
    payload: { from: "chamber_bruno", to: "garden", disposition: "wander" },
  };
  expect(() => validateGardenEvent(event as unknown as GardenEvent)).toThrow();
});

test("SC-027c: validation fails when payload missing from", () => {
  const event = {
    ...baseInput,
    type: "AGENT_MOVED",
    payload: { to: "garden", disposition: "wander", seed: 42 },
  };
  expect(() => validateGardenEvent(event as unknown as GardenEvent)).toThrow();
});

test("validation fails when disposition is not an allowed value", () => {
  const event = {
    ...baseInput,
    type: "AGENT_MOVED",
    payload: { from: "chamber_bruno", to: "garden", disposition: "fly", seed: 42 },
  };
  expect(() => validateGardenEvent(event as unknown as GardenEvent)).toThrow();
});

// Regression: existing event types still validate
test("TASK_STARTED still validates", () => {
  const event: GardenEvent = {
    ...baseInput,
    type: "TASK_STARTED",
    payload: { name: "test" },
  };
  expect(() => validateGardenEvent(event)).not.toThrow();
});

// castle-social-meetings SC-037: MEETING_* event types validate
test("SC-037: createGardenEvent accepts MEETING_CONVENED/JOINED/TURN/CLOSED", () => {
  const types = ["MEETING_CONVENED", "MEETING_JOINED", "MEETING_TURN", "MEETING_CLOSED"] as const;
  for (const type of types) {
    const e = createGardenEvent({
      id: `t-${type}`,
      type,
      timestamp: "2026-07-12T00:00:00.000Z",
      agentId: "bruno",
      instanceId: "test",
      runtime: "test",
      project: "anima",
      payload: { meetingId: "m-1" },
    });
    expect(e.type).toBe(type);
  }
});

// castle-social-encounters SC-013: ENCOUNTER + ENCOUNTER_LINE validate
test("SC-013: createGardenEvent accepts ENCOUNTER + ENCOUNTER_LINE", () => {
  for (const type of ["ENCOUNTER", "ENCOUNTER_LINE"] as const) {
    const e = createGardenEvent({
      id: `t-${type}`,
      type,
      timestamp: "2026-07-12T00:00:00.000Z",
      agentId: "bruno",
      instanceId: "test",
      runtime: "test",
      project: "anima",
      payload: { encounterId: "e-1" },
    });
    expect(e.type).toBe(type);
  }
});

// castle-social-expeditions SC-025: EXPEDITION_CLAIMED/ENDED + DISCOVERY validate
test("SC-025: createGardenEvent accepts EXPEDITION_CLAIMED/EXPEDITION_ENDED/DISCOVERY", () => {
  for (const type of ["EXPEDITION_CLAIMED", "EXPEDITION_ENDED", "DISCOVERY"] as const) {
    const e = createGardenEvent({
      id: `t-${type}`,
      type,
      timestamp: "2026-07-12T00:00:00.000Z",
      agentId: "bruno",
      instanceId: "test",
      runtime: "test",
      project: "anima",
      payload: { expeditionId: "e-1" },
    });
    expect(e.type).toBe(type);
  }
});

test("SC-054: ATTENTION events require source, occurrence, state, version, and timestamp payload fields", () => {
  const valid = {
    ...baseInput,
    type: "ATTENTION_OPENED",
    payload: {
      sourceKind: "mesh",
      sourceRef: "mesh:1",
      occurrenceKey: "mesh:1",
      state: "open",
      version: 1,
      occurredAt: 100,
    },
  };
  expect(() => validateGardenEvent(valid as unknown as GardenEvent)).not.toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, sourceKind: undefined } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, sourceRef: "" } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, occurrenceKey: undefined } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, state: undefined } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, version: undefined } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, occurredAt: undefined } } as unknown as GardenEvent)).toThrow();
});

test("SC-054: activation audit events reject missing causal fields", () => {
  const valid = {
    ...baseInput,
    type: "ACTIVATION_LEASED",
    payload: {
      candidateKey: "eli:mesh:mesh:1:mesh:1",
      sourceRef: "mesh:1",
      reasonRef: "mesh:1",
      occurrenceKey: "mesh:1",
      leaseId: "lease-1",
      costUnits: 1,
    },
  };
  expect(() => validateGardenEvent(valid as unknown as GardenEvent)).not.toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, candidateKey: "" } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, leaseId: undefined } } as unknown as GardenEvent)).toThrow();
  expect(() => validateGardenEvent({ ...valid, payload: { ...valid.payload, sourceRef: undefined } } as unknown as GardenEvent)).toThrow();
});

test("SC-056: completion event records the lease and produced domain event ids", () => {
  const event = {
    ...baseInput,
    type: "ACTIVATION_COMPLETED",
    payload: {
      candidateKey: "eli:mesh:mesh:1:mesh:1",
      sourceRef: "mesh:1",
      reasonRef: "mesh:1",
      occurrenceKey: "mesh:1",
      leaseId: "lease-1",
      settledUnits: 1,
      producedEventIds: ["domain:1"],
    },
  };
  expect(() => validateGardenEvent(event as unknown as GardenEvent)).not.toThrow();
  expect(() => validateGardenEvent({ ...event, payload: { ...event.payload, producedEventIds: [] } } as unknown as GardenEvent)).toThrow();
});
